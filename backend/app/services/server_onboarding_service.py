"""Server onboarding state machine.

Formalizes "add a server" as an observable lifecycle:

    pending -> validating -> installing_prerequisites -> installing_docker
            -> pairing_agent -> ready    (or -> failed at any step)

Phase 1 scope:
  * `validate` is a real, best-effort transition (server exists, has an
    endpoint or agent, optional reachability probe).
  * `install_prerequisites` / `install_docker` / `pair_agent` are structured,
    idempotent STUBS — they record a started/succeeded pair and advance. The
    real install automation lands in a later phase. They must never crash on
    Windows/dev (all Unix-only work is guarded).

Each transition appends a `ServerOnboardingLog` row and mirrors a compact
snapshot onto `Server.onboarding_progress` so the wizard can poll cheaply.

In tests / under `ENV=testing` the background job consumer is disabled, so
callers drive the machine synchronously via `start()` / `validate()` /
`advance()`. In production `start()` (and each step) enqueues a
`server.onboarding.advance` job that resumes the machine.
"""
import json
import logging
from datetime import datetime

from flask import current_app, has_app_context

from app import db
from app.models.server import Server
from app.models.server_onboarding_log import ServerOnboardingLog

logger = logging.getLogger(__name__)

# Job kind used to resume / drive the machine in the background.
ONBOARDING_JOB_KIND = 'server.onboarding.advance'

# Number of recent log rows mirrored into Server.onboarding_progress.
_PROGRESS_SNAPSHOT_LIMIT = 40


class ServerOnboardingService:
    """Drives a server through its provisioning lifecycle."""

    # Lifecycle states, in order. The position in this list defines "next".
    STATE_PENDING = 'pending'
    STATE_VALIDATING = 'validating'
    STATE_INSTALLING_PREREQS = 'installing_prerequisites'
    STATE_INSTALLING_DOCKER = 'installing_docker'
    STATE_PAIRING_AGENT = 'pairing_agent'
    STATE_READY = 'ready'
    STATE_FAILED = 'failed'

    # Ordered active path (excludes the terminal `failed` sink).
    STATES = [
        STATE_PENDING,
        STATE_VALIDATING,
        STATE_INSTALLING_PREREQS,
        STATE_INSTALLING_DOCKER,
        STATE_PAIRING_AGENT,
        STATE_READY,
    ]

    TERMINAL_STATES = (STATE_READY, STATE_FAILED)

    # ------------------------------------------------------------------ #
    # Transition helpers
    # ------------------------------------------------------------------ #

    @classmethod
    def _next_state(cls, state):
        """Return the state that follows ``state`` on the active path, or None
        if there is no successor (already ready / unknown)."""
        try:
            idx = cls.STATES.index(state)
        except ValueError:
            return None
        if idx + 1 < len(cls.STATES):
            return cls.STATES[idx + 1]
        return None

    @classmethod
    def is_valid_transition(cls, from_state, to_state):
        """A transition is valid if it's the immediate next active state, or a
        move to `failed` from any non-terminal state (so any step can fail)."""
        if to_state == cls.STATE_FAILED:
            return from_state not in (cls.STATE_READY,)
        if from_state == to_state:
            return True
        return cls._next_state(from_state) == to_state

    # ------------------------------------------------------------------ #
    # Logging / progress snapshot
    # ------------------------------------------------------------------ #

    @classmethod
    def _log(cls, server, state, status, message=None, detail=None, commit=True):
        """Append an onboarding log row and refresh the cached snapshot."""
        entry = ServerOnboardingLog(
            server_id=server.id,
            state=state,
            status=status,
            message=message,
        )
        entry.set_detail(detail or {})
        db.session.add(entry)
        # Flush so the new row participates in the snapshot query below.
        db.session.flush()
        cls._refresh_snapshot(server)
        if commit:
            db.session.commit()
        return entry

    @classmethod
    def _refresh_snapshot(cls, server):
        """Mirror the most recent log rows onto Server.onboarding_progress."""
        rows = (ServerOnboardingLog.query
                .filter_by(server_id=server.id)
                .order_by(ServerOnboardingLog.created_at.asc(),
                          ServerOnboardingLog.id.asc())
                .limit(_PROGRESS_SNAPSHOT_LIMIT)
                .all())
        snapshot = [r.to_dict() for r in rows]
        try:
            server.onboarding_progress = json.dumps(snapshot)
        except (TypeError, ValueError):
            server.onboarding_progress = '[]'
        server.onboarding_updated_at = datetime.utcnow()

    @classmethod
    def _set_state(cls, server, state):
        server.onboarding_state = state
        server.onboarding_updated_at = datetime.utcnow()

    @classmethod
    def _fail(cls, server, state, message, detail=None):
        """Record a failure on ``state`` and move the machine to `failed`."""
        cls._log(server, state, ServerOnboardingLog.STATUS_FAILED,
                 message=message, detail=detail, commit=False)
        cls._set_state(server, cls.STATE_FAILED)
        db.session.commit()
        cls._audit('server.onboarding.failed', server,
                   {'state': state, 'message': message})

    @classmethod
    def _audit(cls, action, server, details):
        """Best-effort audit; never let an audit failure break onboarding."""
        try:
            from app.services.audit_service import AuditService
            AuditService.log(
                action=action,
                target_type='server',
                target_id=server.id,
                details=details or {},
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug('onboarding audit %s failed: %s', action, exc)

    @staticmethod
    def _is_testing():
        if not has_app_context():
            return True
        return bool(current_app.config.get('TESTING') or
                    current_app.config.get('ENV') == 'testing')

    @classmethod
    def _enqueue_advance(cls, server):
        """Schedule a background resume of the machine. No-op under testing
        (callers drive synchronously there)."""
        if cls._is_testing():
            return None
        try:
            from app.plugins_sdk import jobs
            return jobs.enqueue(
                ONBOARDING_JOB_KIND,
                payload={'server_id': server.id},
                owner_type='server',
                owner_id=server.id,
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning('Failed to enqueue onboarding advance for %s: %s',
                           server.id, exc)
            return None

    # ------------------------------------------------------------------ #
    # Public lifecycle entry points
    # ------------------------------------------------------------------ #

    @classmethod
    def start(cls, server_id):
        """Begin onboarding: move pending -> validating and kick off the machine.

        Returns the current status dict. Idempotent-ish: re-calling on an
        in-flight onboarding just re-enqueues an advance.
        """
        server = Server.query.get(server_id)
        if not server:
            raise ValueError(f'Server not found: {server_id}')

        cls._set_state(server, cls.STATE_VALIDATING)
        cls._log(server, cls.STATE_VALIDATING, ServerOnboardingLog.STATUS_STARTED,
                 message='Onboarding started', commit=True)
        cls._audit('server.onboarding.started', server, {'server_id': server.id})

        if cls._is_testing():
            # Synchronous path for tests: run validate immediately so the
            # machine advances without a job consumer.
            cls.validate(server)
        else:
            cls._enqueue_advance(server)
        return cls.get_status(server_id)

    @classmethod
    def validate(cls, server):
        """Best-effort validation that we have enough to provision this server.

        Checks (all soft on dev/Windows):
          * server row exists (caller passes it in)
          * has a hostname/ip OR an already-paired agent
          * records a reachability flag (connected agent counts as reachable)

        On pass: advance to installing_prerequisites. On fail: -> failed.
        """
        if server is None:
            raise ValueError('validate requires a Server instance')

        cls._set_state(server, cls.STATE_VALIDATING)
        cls._log(server, cls.STATE_VALIDATING, ServerOnboardingLog.STATUS_STARTED,
                 message='Validating server details', commit=True)

        has_endpoint = bool((server.hostname or '').strip() or
                            (server.ip_address or '').strip())
        has_agent = bool(server.agent_id)

        reachable = cls._check_reachable(server)

        detail = {
            'has_endpoint': has_endpoint,
            'has_agent': has_agent,
            'reachable': reachable,
            'hostname': server.hostname,
            'ip_address': server.ip_address,
        }

        if not has_endpoint and not has_agent:
            cls._fail(
                server, cls.STATE_VALIDATING,
                'No hostname/IP and no paired agent — nothing to connect to.',
                detail=detail,
            )
            return cls.get_status(server.id)

        cls._log(server, cls.STATE_VALIDATING, ServerOnboardingLog.STATUS_SUCCEEDED,
                 message='Validation passed', detail=detail, commit=False)
        cls._set_state(server, cls.STATE_INSTALLING_PREREQS)
        db.session.commit()

        # Continue down the chain.
        return cls.advance(server)

    @classmethod
    def _check_reachable(cls, server):
        """Defensive reachability probe.

        A connected agent is the strongest signal and works on any OS. We
        deliberately avoid raw ICMP/socket probes here in Phase 1 (they're
        unreliable behind NAT and noisy on dev) — a real network probe lands
        with the install automation phase.
        """
        try:
            from app.services.agent_registry import agent_registry
            if agent_registry.is_agent_connected(server.id):
                return True
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug('reachability check failed for %s: %s', server.id, exc)
        return None  # unknown — not a hard failure in Phase 1

    @classmethod
    def install_prerequisites(cls, server):
        """STUB: install base prerequisites. Idempotent + safe on any OS.

        Phase 4 will run real package installs via the agent. For now we record
        a started/succeeded pair and advance.
        """
        return cls._run_stub_step(
            server,
            state=cls.STATE_INSTALLING_PREREQS,
            start_msg='Installing prerequisites',
            done_msg='Prerequisites ready (stub)',
            detail={'stub': True, 'note': 'real installs land in a later phase'},
        )

    @classmethod
    def install_docker(cls, server):
        """STUB: ensure Docker is installed. Idempotent + safe on any OS."""
        from app.utils.system import is_command_available

        docker_present = False
        try:
            docker_present = is_command_available('docker')
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug('docker presence check failed: %s', exc)

        return cls._run_stub_step(
            server,
            state=cls.STATE_INSTALLING_DOCKER,
            start_msg='Installing Docker',
            done_msg=('Docker already present' if docker_present
                      else 'Docker install queued (stub)'),
            detail={'stub': True, 'docker_present': docker_present},
        )

    @classmethod
    def pair_agent(cls, server):
        """STUB: pair the management agent. Idempotent + safe on any OS.

        If an agent is already connected we treat pairing as satisfied; the
        real token mint / install handshake lands in a later phase.
        """
        already_paired = False
        try:
            from app.services.agent_registry import agent_registry
            already_paired = agent_registry.is_agent_connected(server.id)
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug('agent pairing check failed: %s', exc)

        return cls._run_stub_step(
            server,
            state=cls.STATE_PAIRING_AGENT,
            start_msg='Pairing agent',
            done_msg=('Agent already paired' if already_paired
                      else 'Agent pairing prepared (stub)'),
            detail={'stub': True, 'already_paired': already_paired},
        )

    @classmethod
    def _run_stub_step(cls, server, state, start_msg, done_msg, detail=None):
        """Shared body for the stubbed install/pair steps: log started, log
        succeeded, advance to the next state, return status."""
        cls._set_state(server, state)
        cls._log(server, state, ServerOnboardingLog.STATUS_STARTED,
                 message=start_msg, commit=True)

        cls._log(server, state, ServerOnboardingLog.STATUS_SUCCEEDED,
                 message=done_msg, detail=detail, commit=False)

        nxt = cls._next_state(state)
        if nxt:
            cls._set_state(server, nxt)
        db.session.commit()
        return cls.advance(server)

    # ------------------------------------------------------------------ #
    # Reconcile / advance / retry
    # ------------------------------------------------------------------ #

    # Dispatch table: which method runs for each current state.
    @classmethod
    def _step_for_state(cls, state):
        return {
            cls.STATE_VALIDATING: cls.validate,
            cls.STATE_INSTALLING_PREREQS: cls.install_prerequisites,
            cls.STATE_INSTALLING_DOCKER: cls.install_docker,
            cls.STATE_PAIRING_AGENT: cls.pair_agent,
        }.get(state)

    @classmethod
    def advance(cls, server):
        """Resume the machine from the server's current onboarding_state.

        Runs the step for the current state, which itself advances to the next
        and recurses, until it reaches a terminal state. Safe to call at any
        point; a no-op on ready/failed/pending.
        """
        if server is None:
            raise ValueError('advance requires a Server instance')

        state = server.onboarding_state or cls.STATE_PENDING

        if state == cls.STATE_READY:
            # Write the terminal "ready" log exactly once (the step that
            # advanced us here only set the state).
            has_ready_log = (ServerOnboardingLog.query
                             .filter_by(server_id=server.id,
                                        state=cls.STATE_READY)
                             .first() is not None)
            if not has_ready_log:
                cls._mark_ready(server)
            return cls.get_status(server.id)

        if state == cls.STATE_FAILED:
            # Don't auto-run on a failed machine; callers use retry().
            return cls.get_status(server.id)

        if state == cls.STATE_PENDING:
            # Not started yet — nothing to advance. start() owns the kickoff.
            return cls.get_status(server.id)

        step = cls._step_for_state(state)
        if step is None:
            return cls.get_status(server.id)

        if state in (cls.STATE_INSTALLING_PREREQS, cls.STATE_INSTALLING_DOCKER,
                     cls.STATE_PAIRING_AGENT):
            # Wrap stubbed steps so an unexpected error fails gracefully
            # instead of crashing the consumer.
            try:
                return step(server)
            except Exception as exc:  # pragma: no cover - defensive
                logger.exception('Onboarding step %s failed for %s', state, server.id)
                cls._fail(server, state, f'Step error: {exc}')
                return cls.get_status(server.id)

        # validate() has its own pass/fail handling.
        return step(server)

    # `reconcile` is an alias spelling of advance for callers that think in
    # reconcile-loop terms.
    @classmethod
    def reconcile(cls, server):
        return cls.advance(server)

    @classmethod
    def _mark_ready(cls, server):
        cls._set_state(server, cls.STATE_READY)
        cls._log(server, cls.STATE_READY, ServerOnboardingLog.STATUS_SUCCEEDED,
                 message='Server ready', commit=True)
        cls._audit('server.onboarding.completed', server, {'server_id': server.id})

    @classmethod
    def retry(cls, server_id):
        """Clear a failed onboarding and resume from the start of the pipeline.

        We rewind to `validating` rather than guessing the failed step, so a
        retry always re-checks prerequisites from a clean baseline.
        """
        server = Server.query.get(server_id)
        if not server:
            raise ValueError(f'Server not found: {server_id}')

        if server.onboarding_state != cls.STATE_FAILED:
            # Nothing to recover; just report current status.
            return cls.get_status(server_id)

        cls._set_state(server, cls.STATE_VALIDATING)
        cls._log(server, cls.STATE_VALIDATING, ServerOnboardingLog.STATUS_STARTED,
                 message='Retrying onboarding', commit=True)
        cls._audit('server.onboarding.retried', server, {'server_id': server.id})

        if cls._is_testing():
            cls.validate(server)
        else:
            cls._enqueue_advance(server)
        return cls.get_status(server_id)

    # ------------------------------------------------------------------ #
    # Status read
    # ------------------------------------------------------------------ #

    @classmethod
    def get_status(cls, server_id):
        """Return ``{state, progress: [...logs...], updated_at}`` for a server."""
        server = Server.query.get(server_id)
        if not server:
            raise ValueError(f'Server not found: {server_id}')

        rows = (ServerOnboardingLog.query
                .filter_by(server_id=server_id)
                .order_by(ServerOnboardingLog.created_at.asc(),
                          ServerOnboardingLog.id.asc())
                .all())
        return {
            'server_id': server_id,
            'state': server.onboarding_state or cls.STATE_PENDING,
            'states': cls.STATES,
            'is_terminal': (server.onboarding_state in cls.TERMINAL_STATES),
            'progress': [r.to_dict() for r in rows],
            'updated_at': (server.onboarding_updated_at.isoformat()
                           if server.onboarding_updated_at else None),
        }

    # ------------------------------------------------------------------ #
    # Job registration
    # ------------------------------------------------------------------ #

    @classmethod
    def _advance_job(cls, job):
        """Job handler: resume the machine for the server in the payload."""
        payload = job.get_payload() if hasattr(job, 'get_payload') else (job.payload or {})
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except (TypeError, ValueError):
                payload = {}
        server_id = (payload or {}).get('server_id')
        if not server_id:
            return {'skipped': 'no server_id'}
        server = Server.query.get(server_id)
        if not server:
            return {'skipped': f'server {server_id} not found'}
        status = cls.advance(server)
        return {'state': status.get('state')}

    @classmethod
    def register_jobs(cls):
        """Register the onboarding advance job handler. Call once at app
        startup (wired from app/__init__.py)."""
        from app.jobs import registry
        registry.register(ONBOARDING_JOB_KIND, cls._advance_job, replace=True)
