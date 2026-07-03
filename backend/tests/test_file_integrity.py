"""Tests for the scoped file-integrity monitoring service + API (task #16)."""
import json
import os
import stat as stat_mod

import pytest

from app.services.file_integrity_service import (
    FIM_EVENT_KEY,
    FIM_JOB_KIND,
    FileIntegrityScopeError,
    FileIntegrityService,
    OPTIN_SETTING_KEY,
)


# --------------------------------------------------------------------------- #
# Helpers / fixtures
# --------------------------------------------------------------------------- #

@pytest.fixture
def fim(tmp_path, monkeypatch):
    """FileIntegrityService pointed at tmp dirs for state + nginx/systemd roots."""
    state_dir = tmp_path / 'state'
    sites = tmp_path / 'sites-enabled'
    confd = tmp_path / 'conf.d'
    systemd = tmp_path / 'systemd'
    for d in (sites, confd, systemd):
        d.mkdir()

    monkeypatch.setattr(FileIntegrityService, 'STATE_DIR', str(state_dir))
    monkeypatch.setattr(FileIntegrityService, 'NGINX_ROOTS', [str(sites), str(confd)])
    monkeypatch.setattr(FileIntegrityService, 'SYSTEMD_ROOT', str(systemd))

    (sites / 'site-a.conf').write_text('server { listen 80; }')
    (confd / 'gzip.conf').write_text('gzip on;')
    (systemd / 'serverkit-agent.service').write_text('[Unit]\nDescription=x\n')
    (systemd / 'unrelated.service').write_text('[Unit]\nDescription=y\n')

    return {
        'sites': sites,
        'confd': confd,
        'systemd': systemd,
        'state': state_dir,
    }


def _make_app(db, name='fimapp', root_path=None):
    from app.models import User
    from app.models.application import Application
    user = User.query.first()
    if user is None:
        from werkzeug.security import generate_password_hash
        user = User(
            email='fim@test.local', username='fimuser',
            password_hash=generate_password_hash('x'),
            role=User.ROLE_ADMIN, is_active=True,
        )
        db.session.add(user)
        db.session.commit()
    application = Application(
        name=name, app_type='php', user_id=user.id, root_path=root_path,
    )
    db.session.add(application)
    db.session.commit()
    return application


# --------------------------------------------------------------------------- #
# Baseline + check diffing
# --------------------------------------------------------------------------- #

def test_baseline_records_files(fim):
    summary = FileIntegrityService.baseline('nginx')
    assert summary['scope'] == 'nginx'
    assert summary['file_count'] == 2
    # Multi-root scope prefixes relpaths with the root basename.
    state = FileIntegrityService._load_state('nginx')
    keys = set(state['files'])
    assert 'sites-enabled/site-a.conf' in keys
    assert 'conf.d/gzip.conf' in keys
    entry = state['files']['sites-enabled/site-a.conf']
    assert set(entry) == {'sha256', 'size', 'mode', 'mtime'}
    assert len(entry['sha256']) == 64


def test_check_detects_added_removed_modified(fim):
    FileIntegrityService.baseline('nginx')

    (fim['sites'] / 'site-b.conf').write_text('server { listen 81; }')  # added
    (fim['confd'] / 'gzip.conf').unlink()                               # removed
    (fim['sites'] / 'site-a.conf').write_text('server { listen 443; }')  # modified

    result = FileIntegrityService.check('nginx')
    assert result['added'] == ['sites-enabled/site-b.conf']
    assert result['removed'] == ['conf.d/gzip.conf']
    assert len(result['modified']) == 1
    mod = result['modified'][0]
    assert mod['path'] == 'sites-enabled/site-a.conf'
    assert 'hash' in mod['what']
    assert 'size' in mod['what']  # content length changed too
    assert result['total_changes'] == 3
    assert result['counts'] == {'added': 1, 'removed': 1, 'modified': 1}

    # Last result is persisted in the scope state.
    state = FileIntegrityService._load_state('nginx')
    assert state['last_check']['total_changes'] == 3


def test_check_detects_mode_change(fim):
    target = fim['sites'] / 'site-a.conf'
    FileIntegrityService.baseline('nginx')

    before = os.stat(target).st_mode
    os.chmod(target, stat_mod.S_IREAD)  # read-only works on every OS
    if os.stat(target).st_mode == before:
        os.chmod(target, before)
        pytest.skip('chmod does not change st_mode on this filesystem')

    try:
        result = FileIntegrityService.check('nginx')
        mods = {m['path']: m['what'] for m in result['modified']}
        assert mods == {'sites-enabled/site-a.conf': ['mode']}
    finally:
        os.chmod(target, before)


def test_check_without_baseline_raises(fim):
    with pytest.raises(FileIntegrityScopeError):
        FileIntegrityService.check('nginx')


def test_unknown_scope_rejected(fim):
    with pytest.raises(FileIntegrityScopeError):
        FileIntegrityService.baseline('etc-passwd')
    with pytest.raises(FileIntegrityScopeError):
        FileIntegrityService.check('app:notanumber')


def test_systemd_scope_only_serverkit_units(fim):
    summary = FileIntegrityService.baseline('systemd')
    state = FileIntegrityService._load_state('systemd')
    assert summary['file_count'] == 1
    assert list(state['files']) == ['serverkit-agent.service']

    # A change to a non-serverkit unit stays invisible.
    (fim['systemd'] / 'unrelated.service').write_text('changed')
    result = FileIntegrityService.check('systemd')
    assert result['total_changes'] == 0


def test_accept_rebaselines(fim):
    FileIntegrityService.baseline('nginx')
    (fim['sites'] / 'site-b.conf').write_text('new')
    assert FileIntegrityService.check('nginx')['total_changes'] == 1

    FileIntegrityService.accept('nginx')
    assert FileIntegrityService.check('nginx')['total_changes'] == 0


def test_accept_preserves_extra_excludes(fim):
    FileIntegrityService.baseline('nginx', options={'exclude': ['*.ignore']})
    (fim['sites'] / 'x.ignore').write_text('noise')
    assert FileIntegrityService.check('nginx')['total_changes'] == 0

    FileIntegrityService.accept('nginx')
    (fim['sites'] / 'y.ignore').write_text('more noise')
    assert FileIntegrityService.check('nginx')['total_changes'] == 0


# --------------------------------------------------------------------------- #
# Exclusions
# --------------------------------------------------------------------------- #

def test_nginx_scope_excludes_logs(fim):
    (fim['sites'] / 'access.log').write_text('GET /')
    FileIntegrityService.baseline('nginx')
    state = FileIntegrityService._load_state('nginx')
    assert 'sites-enabled/access.log' not in state['files']

    (fim['sites'] / 'error.log').write_text('boom')
    assert FileIntegrityService.check('nginx')['total_changes'] == 0


def test_app_scope_excludes_uploads_and_cache(fim, tmp_path, app, db_session):
    docroot = tmp_path / 'docroot'
    (docroot / 'wp-content' / 'uploads').mkdir(parents=True)
    (docroot / 'wp-content' / 'cache').mkdir(parents=True)
    (docroot / 'index.php').write_text('<?php echo 1;')
    (docroot / 'wp-content' / 'uploads' / 'img.jpg').write_text('jpegdata')
    (docroot / 'wp-content' / 'cache' / 'page.html').write_text('cached')

    application = _make_app(db_session, root_path=str(docroot))
    scope = f'app:{application.id}'

    summary = FileIntegrityService.baseline(scope)
    assert summary['file_count'] == 1
    state = FileIntegrityService._load_state(scope)
    assert list(state['files']) == ['index.php']

    # Churn in excluded trees never shows up as a change.
    (docroot / 'wp-content' / 'uploads' / 'img2.jpg').write_text('more')
    assert FileIntegrityService.check(scope)['total_changes'] == 0

    # But real code changes do.
    (docroot / 'index.php').write_text('<?php echo 2;')
    result = FileIntegrityService.check(scope)
    assert result['modified'][0]['path'] == 'index.php'


def test_app_scope_unknown_application(fim, app):
    with pytest.raises(FileIntegrityScopeError):
        FileIntegrityService.baseline('app:999999')


# --------------------------------------------------------------------------- #
# Opt-ins
# --------------------------------------------------------------------------- #

def test_optin_round_trip(fim, app, db_session):
    assert FileIntegrityService.get_app_optins() == []
    ids = FileIntegrityService.set_app_optins([3, 1, 3])
    assert ids == [1, 3]
    assert FileIntegrityService.get_app_optins() == [1, 3]

    from app.services.settings_service import SettingsService
    assert json.loads(SettingsService.get(OPTIN_SETTING_KEY)) == [1, 3]

    with pytest.raises(FileIntegrityScopeError):
        FileIntegrityService.set_app_optins(['nope'])


def test_optout_drops_stale_baseline(fim, tmp_path, app, db_session):
    docroot = tmp_path / 'doc2'
    docroot.mkdir()
    (docroot / 'a.txt').write_text('a')
    application = _make_app(db_session, name='fimapp2', root_path=str(docroot))
    scope = f'app:{application.id}'

    FileIntegrityService.set_app_optins([application.id])
    FileIntegrityService.baseline(scope)
    assert FileIntegrityService._load_state(scope) is not None

    FileIntegrityService.set_app_optins([])
    assert FileIntegrityService._load_state(scope) is None


# --------------------------------------------------------------------------- #
# check_all + notification
# --------------------------------------------------------------------------- #

def test_check_all_notifies_on_changes(fim, app, monkeypatch):
    sent = []
    import app.plugins_sdk as sdk
    monkeypatch.setattr(
        sdk.notify, 'send',
        lambda event, to, data=None, **kw: sent.append((event, to, data)),
    )

    FileIntegrityService.baseline('nginx')
    FileIntegrityService.baseline('systemd')

    # No changes → no notification.
    results = FileIntegrityService.check_all()
    assert set(results) == {'nginx', 'systemd'}
    assert sent == []

    (fim['sites'] / 'evil.conf').write_text('server {}')
    results = FileIntegrityService.check_all()
    assert results['nginx']['total_changes'] == 1
    assert len(sent) == 1
    event, to, data = sent[0]
    assert event == FIM_EVENT_KEY
    assert to == 'admins'
    assert data['scope'] == 'nginx'
    assert data['counts'] == {'added': 1, 'removed': 0, 'modified': 0}
    assert data['sample_paths'] == ['sites-enabled/evil.conf']


def test_notification_sample_capped_at_ten(fim, app, monkeypatch):
    sent = []
    import app.plugins_sdk as sdk
    monkeypatch.setattr(
        sdk.notify, 'send',
        lambda event, to, data=None, **kw: sent.append(data),
    )
    FileIntegrityService.baseline('nginx')
    for i in range(15):
        (fim['sites'] / f'n{i:02d}.conf').write_text('x')
    FileIntegrityService.check_all()
    assert len(sent) == 1
    assert len(sent[0]['sample_paths']) == 10


def test_notify_failure_does_not_break_check(fim, app, monkeypatch):
    import app.plugins_sdk as sdk
    def boom(*a, **kw):
        raise RuntimeError('bus down')
    monkeypatch.setattr(sdk.notify, 'send', boom)
    FileIntegrityService.baseline('nginx')
    (fim['sites'] / 'x.conf').write_text('x')
    results = FileIntegrityService.check_all()
    assert results['nginx']['total_changes'] == 1


# --------------------------------------------------------------------------- #
# Job registration
# --------------------------------------------------------------------------- #

def test_register_jobs_registers_handler_and_event(app):
    from app.jobs import registry
    FileIntegrityService.register_jobs()
    assert registry.is_registered(FIM_JOB_KIND)
    assert registry.get(FIM_JOB_KIND) == FileIntegrityService.run_check_job

    from app.notifications import catalog
    entry = catalog.get_entry(FIM_EVENT_KEY) if hasattr(catalog, 'get_entry') else None
    if entry is None:
        # Fall back to resolve(): registered events keep their catalog title.
        meta = catalog.resolve(FIM_EVENT_KEY, {})
        assert meta['title'] == 'File integrity changes detected'
        assert meta['category'] == 'security'
    else:
        assert entry['severity'] == 'warning'


def test_run_check_job_returns_summary(fim, app, monkeypatch):
    import app.plugins_sdk as sdk
    monkeypatch.setattr(sdk.notify, 'send', lambda *a, **kw: None)
    FileIntegrityService.baseline('nginx')
    (fim['sites'] / 'x.conf').write_text('x')
    result = FileIntegrityService.run_check_job(job=None)
    assert result == {'scopes_checked': 1, 'scopes_changed': 1}


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #

def test_fim_api_requires_auth(fim, client):
    assert client.get('/api/v1/security/fim').status_code == 401
    assert client.post('/api/v1/security/fim/nginx/baseline').status_code == 401


def test_fim_api_happy_path(fim, client, auth_headers, db_session):
    # Status before any baseline: nginx + systemd scopes, no app opt-ins.
    resp = client.get('/api/v1/security/fim', headers=auth_headers)
    assert resp.status_code == 200
    body = resp.get_json()
    assert body['app_optins'] == []
    scopes = {s['scope']: s for s in body['scopes']}
    assert set(scopes) == {'nginx', 'systemd'}
    assert scopes['nginx']['baseline'] is None

    # Baseline → check → accept round-trip.
    resp = client.post('/api/v1/security/fim/nginx/baseline', headers=auth_headers)
    assert resp.status_code == 200
    assert resp.get_json()['file_count'] == 2

    (fim['sites'] / 'new.conf').write_text('server {}')
    resp = client.post('/api/v1/security/fim/nginx/check', headers=auth_headers)
    assert resp.status_code == 200
    assert resp.get_json()['total_changes'] == 1

    resp = client.post('/api/v1/security/fim/nginx/accept', headers=auth_headers)
    assert resp.status_code == 200
    resp = client.post('/api/v1/security/fim/nginx/check', headers=auth_headers)
    assert resp.get_json()['total_changes'] == 0

    # Status now carries baseline metadata + last result.
    body = client.get('/api/v1/security/fim', headers=auth_headers).get_json()
    nginx = next(s for s in body['scopes'] if s['scope'] == 'nginx')
    assert nginx['baseline']['file_count'] == 3
    assert nginx['last_check']['total_changes'] == 0


def test_fim_api_error_paths(fim, client, auth_headers):
    # Unknown scope → 400 JSON error.
    resp = client.post('/api/v1/security/fim/bogus/baseline', headers=auth_headers)
    assert resp.status_code == 400
    assert 'error' in resp.get_json()

    # Check without baseline → 400.
    resp = client.post('/api/v1/security/fim/nginx/check', headers=auth_headers)
    assert resp.status_code == 400

    # Opt-ins require app_ids.
    resp = client.put('/api/v1/security/fim/apps', json={}, headers=auth_headers)
    assert resp.status_code == 400


def test_fim_api_app_optins(fim, tmp_path, client, auth_headers, db_session):
    docroot = tmp_path / 'apidoc'
    docroot.mkdir()
    (docroot / 'main.py').write_text('print(1)')
    application = _make_app(db_session, name='fimapi', root_path=str(docroot))

    resp = client.put(
        '/api/v1/security/fim/apps',
        json={'app_ids': [application.id]},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.get_json()['app_optins'] == [application.id]

    body = client.get('/api/v1/security/fim', headers=auth_headers).get_json()
    scopes = {s['scope']: s for s in body['scopes']}
    scope_key = f'app:{application.id}'
    assert scope_key in scopes
    assert scopes[scope_key]['app_name'] == 'fimapi'
    assert scopes[scope_key]['available'] is True

    resp = client.post(
        f'/api/v1/security/fim/{scope_key}/baseline', headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.get_json()['file_count'] == 1
