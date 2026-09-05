"""Repository registration ordering and compensating cleanup, without HTTP."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.services import repository_application_service as imports
from app.services.deployment_job_service import DeploymentJobService
from app.services.manifest_persistence_service import ManifestPersistenceService


@pytest.fixture
def runtime(monkeypatch, tmp_path):
    app = SimpleNamespace(id=42, root_path=str(tmp_path / 'apps' / 'demo'))
    session = Mock()
    git = Mock()
    build = Mock()
    git.configure_deployment.return_value = {'success': True, 'webhook_url': '/hook'}
    build.configure_build.return_value = {'success': True, 'config': {'build_method': 'dockerfile'}}
    manifest = Mock(return_value={'imported': True})
    enqueue = Mock(return_value={'success': True, 'job_id': 'job-42'})
    monkeypatch.setattr(imports, 'db', SimpleNamespace(session=session))
    monkeypatch.setattr(imports, 'GitService', git)
    monkeypatch.setattr(imports, 'BuildService', build)
    monkeypatch.setattr(imports.paths, 'APPS_DIR', str(tmp_path / 'apps'))
    monkeypatch.setattr(ManifestPersistenceService, 'apply_import', manifest)
    monkeypatch.setattr(DeploymentJobService, 'enqueue_app_deploy', enqueue)
    options = dict(user_id=7, repo_url='https://github.com/acme/demo', branch='release',
                   auto_deploy=False, manifest={'strategy': 'dockerfile'},
                   build_options={'build_method': 'dockerfile', 'custom_start_cmd': 'serve'})
    return SimpleNamespace(app=app, session=session, git=git, build=build,
                           manifest=manifest, enqueue=enqueue, options=options)


def test_commit_precedes_configuration_and_observable_deployment(runtime):
    effects = Mock()
    for name, method in [('commit', runtime.session.commit),
                         ('deploy', runtime.git.configure_deployment),
                         ('build', runtime.build.configure_build),
                         ('manifest', runtime.manifest), ('enqueue', runtime.enqueue)]:
        effects.attach_mock(method, name)
    result = imports.finalize_repository_application(runtime.app, **runtime.options)
    assert [call[0] for call in effects.mock_calls] == ['commit', 'deploy', 'build', 'manifest', 'enqueue']
    assert result['deploy_job_id'] == 'job-42'
    assert result['manifest_import'] == {'imported': True}
    runtime.git.configure_deployment.assert_called_once_with(
        app_id=42, app_path=runtime.app.root_path, repo_url=runtime.options['repo_url'],
        branch='release', auto_deploy=False)
    runtime.build.configure_build.assert_called_once_with(
        app_id=42, app_path=runtime.app.root_path, **runtime.options['build_options'])
    runtime.enqueue.assert_called_once_with(runtime.app, user_id=7, trigger='install')


@pytest.mark.parametrize('stage', ['deploy', 'build'])
def test_mandatory_setup_failure_propagates_for_compensation(runtime, stage):
    method = runtime.git.configure_deployment if stage == 'deploy' else runtime.build.configure_build
    method.return_value = {'success': False, 'error': 'setup failed'}
    with pytest.raises(RuntimeError, match='setup failed'):
        imports.finalize_repository_application(runtime.app, **runtime.options)
    runtime.manifest.assert_not_called()
    runtime.enqueue.assert_not_called()


@pytest.mark.parametrize('queue_failure', [False, True])
def test_optional_enrichment_and_queue_failure_keep_registered_app(runtime, queue_failure):
    runtime.manifest.side_effect = RuntimeError('unsupported manifest')
    if queue_failure:
        runtime.enqueue.side_effect = RuntimeError('queue unavailable')
    else:
        runtime.enqueue.return_value = {'success': False, 'error': 'queue unavailable'}
    result = imports.finalize_repository_application(runtime.app, **runtime.options)
    assert result['manifest_import'] is None
    assert result['deploy_job_id'] is None
    runtime.session.commit.assert_called_once()
    runtime.session.rollback.assert_not_called()
    runtime.git.remove_deployment.assert_not_called()


@pytest.mark.parametrize('location', ['managed', 'sibling', 'base'])
def test_compensation_hard_deletes_record_but_only_removes_managed_child_path(runtime, monkeypatch, location):
    from pathlib import Path
    base = Path(imports.paths.APPS_DIR)
    target = {'managed': base / 'demo', 'sibling': base.with_name('apps-other'), 'base': base}[location]
    target.mkdir(parents=True)
    marker = target / 'keep.txt'
    marker.write_text('source')
    runtime.app.root_path = str(target)
    query = Mock()
    query.get.return_value = runtime.app
    monkeypatch.setattr(imports, 'Application', SimpleNamespace(query=query))
    effects = Mock()
    effects.attach_mock(runtime.session.rollback, 'rollback')
    effects.attach_mock(runtime.git.remove_deployment, 'deployment')
    effects.attach_mock(runtime.session.delete, 'delete')
    effects.attach_mock(runtime.session.commit, 'commit')
    imports.abort_repository_creation(runtime.app)
    assert [call[0] for call in effects.mock_calls] == ['rollback', 'deployment', 'delete', 'commit']
    assert marker.exists() == (location != 'managed')
