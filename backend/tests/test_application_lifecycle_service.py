"""Lifecycle dispatch, failure handling and side effects without HTTP context."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.services import application_lifecycle_service as lifecycle


@pytest.fixture
def runtime(monkeypatch, tmp_path):
    docker = Mock()
    remote = Mock()
    registry = Mock()
    session = Mock()
    invalidate = Mock()
    monkeypatch.setattr(lifecycle, 'DockerService', docker)
    monkeypatch.setattr(lifecycle, 'RemoteDockerService', remote)
    monkeypatch.setattr(lifecycle, 'ContainerRegistryService', registry)
    monkeypatch.setattr(lifecycle, 'db', SimpleNamespace(session=session))
    monkeypatch.setattr(lifecycle.container_status_service, 'invalidate', invalidate)
    app = SimpleNamespace(
        id=42, app_type='docker', root_path=str(tmp_path), server_id=None,
        compose_file='custom.yml', buildpack_type=None, docker_image=None,
        status='original',
    )
    return SimpleNamespace(
        app=app, docker=docker, remote=remote, registry=registry,
        session=session, invalidate=invalidate,
    )


@pytest.mark.parametrize('operation,method,status', [
    ('start', 'up', 'running'), ('stop', 'down', 'stopped'),
    ('restart', 'restart', 'running'),
])
@pytest.mark.parametrize('target', ['local', 'remote', 'single'])
def test_dispatch_and_commit_before_invalidation(runtime, operation, method, status, target):
    app = runtime.app
    if target == 'remote':
        app.server_id = 'remote-server'
        service = runtime.remote
    else:
        service = runtime.docker
    if target == 'single':
        app.compose_file = None
        app.buildpack_type = 'nixpacks'
        command = getattr(service, f'{operation}_container')
    else:
        command = getattr(service, f'compose_{method}')
    command.return_value = {'success': True}
    effects = []
    runtime.session.commit.side_effect = lambda: effects.append('commit')
    runtime.invalidate.side_effect = lambda value: effects.append(('invalidate', value))

    getattr(lifecycle, f'{operation}_application')(app, user_id=7)

    assert app.status == status
    assert effects == ['commit', ('invalidate', 42)]
    kwargs = {'detach': True} if operation == 'start' else {}
    if target == 'remote':
        command.assert_called_once_with(
            'remote-server', lifecycle._compose_target(app), user_id=7, **kwargs,
        )
        assert not runtime.docker.mock_calls
    elif target == 'single':
        command.assert_called_once_with('serverkit-app-42')
    else:
        command.assert_called_once_with(app.root_path, compose_file='custom.yml', **kwargs)
        if operation == 'start':
            runtime.registry.login_for_app.assert_called_once_with(app)
            runtime.registry.logout_for_app.assert_called_once_with(runtime.registry.login_for_app.return_value)


@pytest.mark.parametrize('operation,method', [('start', 'up'), ('stop', 'down'), ('restart', 'restart')])
def test_agent_failure_preserves_status_and_cache(runtime, operation, method):
    runtime.app.server_id = 'remote-server'
    getattr(runtime.remote, f'compose_{method}').return_value = {
        'success': True, 'data': {'success': False, 'error': 'agent rejected'},
    }
    with pytest.raises(lifecycle.ApplicationLifecycleError, match='agent rejected'):
        getattr(lifecycle, f'{operation}_application')(runtime.app, user_id=7)
    assert runtime.app.status == 'original'
    runtime.session.commit.assert_not_called()
    runtime.invalidate.assert_not_called()


def test_registry_logout_even_when_compose_raises(runtime):
    runtime.docker.compose_up.side_effect = RuntimeError('docker unavailable')
    with pytest.raises(RuntimeError, match='docker unavailable'):
        lifecycle.start_application(runtime.app)
    runtime.registry.logout_for_app.assert_called_once_with(runtime.registry.login_for_app.return_value)
    runtime.session.commit.assert_not_called()
    runtime.invalidate.assert_not_called()


def test_commit_failure_does_not_invalidate(runtime):
    runtime.docker.compose_up.return_value = {'success': True}
    runtime.session.commit.side_effect = RuntimeError('database unavailable')
    with pytest.raises(RuntimeError, match='database unavailable'):
        lifecycle.start_application(runtime.app)
    runtime.invalidate.assert_not_called()


def test_first_image_start_persists_compose_before_runtime_failure(runtime, monkeypatch, tmp_path):
    app = runtime.app
    app.root_path = None
    app.compose_file = None
    app.docker_image = 'example/private:latest'
    app.name = 'image-app'
    app.port = 8080
    app.healthcheck_path = '/health'
    app.managed_by = None
    monkeypatch.setattr(lifecycle.paths, 'APPS_DIR', str(tmp_path))
    monkeypatch.setattr(lifecycle.AppPortService, 'get_ports', lambda value: [])
    render = Mock(return_value='services: {}\n')
    monkeypatch.setattr(lifecycle.UnitComposeService, 'render_yaml', render)
    runtime.docker.compose_up.return_value = {'success': False, 'error': 'pull failed'}

    with pytest.raises(lifecycle.ApplicationLifecycleError, match='pull failed'):
        lifecycle.start_application(app)

    assert (tmp_path / 'image-app' / 'docker-compose.yml').read_text() == 'services: {}\n'
    assert app.compose_file == 'docker-compose.yml'
    assert app.managed_by == 'docker_compose'
    assert app.status == 'original'
    runtime.session.commit.assert_called_once()
    runtime.invalidate.assert_not_called()
    render.assert_called_once_with('image-app', [{
        'name': 'app', 'image': 'example/private:latest',
        'ports': [{'host_port': 8080, 'container_port': 8080, 'expose': 'local'}],
        'health_check': {'http_path': '/health'},
    }])
    # A retry uses the saved project instead of writing/committing it again.
    runtime.docker.compose_up.return_value = {'success': True}
    lifecycle.start_application(app)
    assert runtime.session.commit.call_count == 2
    assert render.call_count == 1
    runtime.invalidate.assert_called_once_with(app.id)


def test_image_path_validation_rejects_escape_before_write(runtime, monkeypatch, tmp_path):
    app = runtime.app
    app.root_path = None
    app.docker_image = 'example/image:latest'
    app.name = '../outside'
    monkeypatch.setattr(lifecycle.paths, 'APPS_DIR', str(tmp_path))
    with pytest.raises(lifecycle.ApplicationLifecycleError, match='Invalid application path'):
        lifecycle.start_application(app)
    assert not list(tmp_path.iterdir())
    runtime.session.commit.assert_not_called()
    runtime.invalidate.assert_not_called()
