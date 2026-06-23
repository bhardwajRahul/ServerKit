"""Tests for the server onboarding state machine (Phase 1).

Under the testing config the job consumer is disabled, so the service is driven
synchronously: `start()` validates + advances all the way to `ready` (the steps
after `validating` are idempotent stubs that chain via `advance`).
"""
import pytest

from app import db
from app.models.server import Server
from app.models.server_onboarding_log import ServerOnboardingLog
from app.services.server_onboarding_service import ServerOnboardingService as SOS


def _make_server(**overrides):
    data = dict(
        name='Test Server',
        hostname='test.example.com',
        ip_address='203.0.113.10',
    )
    data.update(overrides)
    server = Server(**data)
    db.session.add(server)
    db.session.commit()
    return server


def test_start_runs_full_pipeline_to_ready(app):
    with app.app_context():
        server = _make_server()
        assert server.onboarding_state in (None, 'pending')

        status = SOS.start(server.id)

        # Synchronous in testing — should reach the terminal ready state.
        assert status['state'] == SOS.STATE_READY
        assert status['is_terminal'] is True

        refreshed = Server.query.get(server.id)
        assert refreshed.onboarding_state == SOS.STATE_READY
        assert refreshed.onboarding_updated_at is not None

        # Logs were written for each lifecycle step.
        states_logged = {
            row.state for row in
            ServerOnboardingLog.query.filter_by(server_id=server.id).all()
        }
        assert SOS.STATE_VALIDATING in states_logged
        assert SOS.STATE_INSTALLING_PREREQS in states_logged
        assert SOS.STATE_INSTALLING_DOCKER in states_logged
        assert SOS.STATE_PAIRING_AGENT in states_logged
        assert SOS.STATE_READY in states_logged


def test_progress_snapshot_mirrored_on_server(app):
    with app.app_context():
        server = _make_server()
        SOS.start(server.id)

        refreshed = Server.query.get(server.id)
        progress = refreshed._onboarding_progress_list()
        assert isinstance(progress, list)
        assert len(progress) > 0
        # Each snapshot entry carries the to_dict() shape.
        assert {'state', 'status', 'message'} <= set(progress[0].keys())

        # to_dict surfaces the new fields.
        as_dict = refreshed.to_dict()
        assert as_dict['onboarding_state'] == SOS.STATE_READY
        assert isinstance(as_dict['onboarding_progress'], list)
        assert as_dict['onboarding_updated_at'] is not None


def test_validation_fails_without_endpoint_or_agent(app):
    with app.app_context():
        # No hostname/ip and no agent — validation must fail.
        server = _make_server(hostname=None, ip_address=None, agent_id=None)

        status = SOS.start(server.id)

        assert status['state'] == SOS.STATE_FAILED
        refreshed = Server.query.get(server.id)
        assert refreshed.onboarding_state == SOS.STATE_FAILED

        failed_logs = ServerOnboardingLog.query.filter_by(
            server_id=server.id, status=ServerOnboardingLog.STATUS_FAILED
        ).all()
        assert len(failed_logs) >= 1
        assert failed_logs[0].state == SOS.STATE_VALIDATING


def test_retry_recovers_from_failed(app):
    with app.app_context():
        server = _make_server(hostname=None, ip_address=None, agent_id=None)
        SOS.start(server.id)
        assert Server.query.get(server.id).onboarding_state == SOS.STATE_FAILED

        # Give it a reachable endpoint, then retry — should now complete.
        server = Server.query.get(server.id)
        server.hostname = 'recovered.example.com'
        db.session.commit()

        status = SOS.retry(server.id)
        assert status['state'] == SOS.STATE_READY
        assert Server.query.get(server.id).onboarding_state == SOS.STATE_READY

        # A "Retrying onboarding" log row exists.
        retry_logs = [
            r for r in ServerOnboardingLog.query.filter_by(server_id=server.id).all()
            if r.message and 'Retry' in r.message
        ]
        assert len(retry_logs) >= 1


def test_retry_on_non_failed_is_noop(app):
    with app.app_context():
        server = _make_server()
        SOS.start(server.id)  # -> ready
        status = SOS.retry(server.id)
        # Already ready; retry just reports current status.
        assert status['state'] == SOS.STATE_READY


def test_transition_validation_helper(app):
    with app.app_context():
        assert SOS.is_valid_transition(SOS.STATE_PENDING, SOS.STATE_VALIDATING)
        assert SOS.is_valid_transition(
            SOS.STATE_VALIDATING, SOS.STATE_INSTALLING_PREREQS)
        assert not SOS.is_valid_transition(
            SOS.STATE_PENDING, SOS.STATE_READY)
        # Any non-ready state can fail.
        assert SOS.is_valid_transition(
            SOS.STATE_INSTALLING_DOCKER, SOS.STATE_FAILED)


def test_get_status_unknown_server_raises(app):
    with app.app_context():
        with pytest.raises(ValueError):
            SOS.get_status('does-not-exist')


def test_register_jobs_is_callable(app):
    with app.app_context():
        # Should not raise; registers the advance handler.
        SOS.register_jobs()
        from app.jobs import registry
        from app.services.server_onboarding_service import ONBOARDING_JOB_KIND
        assert registry.is_registered(ONBOARDING_JOB_KIND)
