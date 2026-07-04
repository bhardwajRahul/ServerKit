"""Tests for the `serverkit manifest` CLI verbs (#22): plan/apply/diff against a
stubbed API client, mirroring the monkeypatch pattern in test_cli_api.py."""
import pytest
from click.testing import CliRunner

import cli as serverkit_cli


def _all_output(result):
    out = result.output
    try:
        out += result.stderr
    except (ValueError, AttributeError):
        pass
    return out


class FakeClient:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def get(self, path):
        self.calls.append(('GET', path, None))
        return self.responses[path]

    def post(self, path, json_body=None):
        self.calls.append(('POST', path, json_body))
        resp = self.responses[path]
        if isinstance(resp, Exception):
            raise resp
        return resp


@pytest.fixture
def fake_api(monkeypatch):
    def _install(responses):
        fake = FakeClient(responses)
        monkeypatch.setattr(serverkit_cli, '_api_client', lambda with_token=True: fake)
        return fake
    return _install


def _plan(steps, summary='Plan computed', issues=None):
    return {'plan': {
        'steps': steps,
        'step_count': len(steps),
        'summary': summary,
        'issues': issues or [],
    }}


def test_plan_prints_steps_and_summary(fake_api):
    fake = fake_api({
        '/manifests/plan': _plan(
            [
                {'type': 'create', 'service': 'web', 'description': 'create app web'},
                {'type': 'update', 'service': 'api', 'description': 'update env'},
            ],
            summary='2 changes planned',
        ),
    })
    result = CliRunner().invoke(
        serverkit_cli.cli, ['manifest', 'plan', '--project', '7'])
    assert result.exit_code == 0, _all_output(result)
    assert ('POST', '/manifests/plan', {'project_id': 7}) in fake.calls
    assert 'create  web  create app web' in result.output
    assert 'update  api  update env' in result.output
    assert '2 changes planned' in result.output
    assert '(2 steps)' in result.output


def test_plan_prints_issues_as_warnings(fake_api):
    fake_api({
        '/manifests/plan': _plan(
            [{'type': 'create', 'service': 'web', 'description': 'create'}],
            issues=[{'message': 'Missing secret DB_PASSWORD'}],
        ),
    })
    result = CliRunner().invoke(
        serverkit_cli.cli, ['manifest', 'plan', '--project', '1'])
    assert result.exit_code == 0, _all_output(result)
    assert 'Missing secret DB_PASSWORD' in result.output


def test_diff_empty_plan_prints_no_changes(fake_api):
    fake_api({'/manifests/plan': _plan([])})
    result = CliRunner().invoke(
        serverkit_cli.cli, ['manifest', 'diff', '--project', '3'])
    assert result.exit_code == 0, _all_output(result)
    assert 'No changes — live state matches the manifest.' in result.output


def test_diff_shows_planned_changes(fake_api):
    fake_api({
        '/manifests/plan': _plan(
            [{'type': 'delete', 'service': 'old', 'description': 'remove old app'}]),
    })
    result = CliRunner().invoke(
        serverkit_cli.cli, ['manifest', 'diff', '--project', '3'])
    assert result.exit_code == 0, _all_output(result)
    assert 'Planned changes:' in result.output
    assert 'delete  old  remove old app' in result.output


def test_apply_yes_posts_and_reports_success(fake_api):
    fake = fake_api({
        '/manifests/apply': {
            'success': True,
            'applied': 2,
            'issues': [],
            'results': [
                {'type': 'create', 'service': 'web', 'status': 'ok'},
                {'type': 'update', 'service': 'api', 'status': 'applied'},
            ],
            'job_id': 42,
        },
    })
    result = CliRunner().invoke(
        serverkit_cli.cli, ['manifest', 'apply', '--project', '9', '--yes'])
    assert result.exit_code == 0, _all_output(result)
    # --yes skips the plan call; only apply is posted.
    assert fake.calls == [('POST', '/manifests/apply', {'project_id': 9})]
    assert 'Applied 2 change(s).' in result.output
    assert 'web' in result.output and 'api' in result.output


def test_apply_reports_failure_and_exits_nonzero(fake_api):
    fake_api({
        '/manifests/apply': {
            'success': False,
            'applied': 1,
            'issues': [],
            'results': [
                {'type': 'create', 'service': 'web', 'status': 'ok'},
                {'type': 'update', 'service': 'api', 'status': 'error',
                 'error': 'port in use'},
            ],
            'job_id': 43,
        },
    })
    result = CliRunner().invoke(
        serverkit_cli.cli, ['manifest', 'apply', '--project', '9', '--yes'])
    assert result.exit_code == 1
    assert 'port in use' in _all_output(result)


def test_apply_shows_plan_and_confirms(fake_api):
    fake = fake_api({
        '/manifests/plan': _plan(
            [{'type': 'create', 'service': 'web', 'description': 'create app web'}]),
        '/manifests/apply': {
            'success': True, 'applied': 1, 'issues': [],
            'results': [{'type': 'create', 'service': 'web', 'status': 'ok'}],
            'job_id': 1,
        },
    })
    result = CliRunner().invoke(
        serverkit_cli.cli, ['manifest', 'apply', '--project', '5'], input='y\n')
    assert result.exit_code == 0, _all_output(result)
    assert 'create app web' in result.output
    posted = [c[1] for c in fake.calls]
    assert '/manifests/plan' in posted and '/manifests/apply' in posted


def test_apply_abort_when_declined(fake_api):
    fake = fake_api({
        '/manifests/plan': _plan(
            [{'type': 'create', 'service': 'web', 'description': 'create app web'}]),
        '/manifests/apply': {'success': True, 'applied': 0, 'results': []},
    })
    result = CliRunner().invoke(
        serverkit_cli.cli, ['manifest', 'apply', '--project', '5'], input='n\n')
    assert result.exit_code == 0, _all_output(result)
    assert 'Aborted.' in result.output
    assert not any(c[1] == '/manifests/apply' for c in fake.calls)


def test_cli_api_error_surfaces_via_fail(fake_api):
    from app.services.cli_api_client import CliApiError
    fake_api({'/manifests/plan': CliApiError('Admin access required')})
    result = CliRunner().invoke(
        serverkit_cli.cli, ['manifest', 'plan', '--project', '2'])
    assert result.exit_code == 1
    assert 'Admin access required' in _all_output(result)
