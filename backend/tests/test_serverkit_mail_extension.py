"""serverkit-mail extension tests — manifest, models, engine, blueprint.

Covers the Stalwart-based builtin mail extension the same way production loads a
builtin: ``plugin_service._ensure_builtin_backend_importable`` registers
``builtin-extensions/serverkit-mail/backend`` as the dashed package
``app.plugins.serverkit-mail``. The models module is imported at test-module top
level so its ``ext_serverkit_mail_*`` tables register on ``db.metadata`` before
the ``app`` fixture runs ``db.create_all()``.

This file proves: manifest validity + permissions + entry point + frontend
export, the SQLAlchemy models (create + ``to_dict`` + no mailbox password column +
the unique constraint), the StalwartService Docker/API choke-points (install argv
with a loopback-only admin API, status parsing, Windows gating, clean API error
dicts, best-effort reconcile methods), and the blueprint auth/validation paths.

Preflight, the activation gate, DKIM/DNS, and the fail2ban jail live in
``test_serverkit_mail_preflight_dns.py``.
"""
import importlib
import json
import os
from types import SimpleNamespace

import pytest

from app.services import plugin_service

SLUG = 'serverkit-mail'
EXT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    'builtin-extensions', SLUG,
)


def _load_ext():
    assert plugin_service._ensure_builtin_backend_importable(SLUG), (
        f'builtin extension backend not importable from {EXT_DIR}')
    # Import models at module top so the ext_serverkit_mail_* tables register on
    # db.metadata before any app fixture calls db.create_all().
    models = importlib.import_module(f'app.plugins.{SLUG}.models')
    stalwart = importlib.import_module(f'app.plugins.{SLUG}.stalwart_service')
    bp = importlib.import_module(f'app.plugins.{SLUG}.mail')
    return models, stalwart, bp


models_mod, svc_mod, bp_mod = _load_ext()
StalwartService = svc_mod.StalwartService
MailDomain = models_mod.MailDomain
Mailbox = models_mod.Mailbox
Forwarder = models_mod.Forwarder
Autoresponder = models_mod.Autoresponder
PreflightResult = models_mod.PreflightResult

CFG = {'admin_password': 'test-admin-pw', 'hostname': 'mail.example.com'}


def _proc(returncode=0, stdout='', stderr=''):
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


class FakeResponse:
    def __init__(self, status_code=200, data=None, text=''):
        self.status_code = status_code
        self._data = data
        self.text = text or (json.dumps(data) if data is not None else '')
        self.content = self.text.encode()

    def json(self):
        if self._data is None:
            raise ValueError('no json')
        return self._data


@pytest.fixture
def linux(monkeypatch):
    """Pretend we're on Linux with docker installed and admin creds saved."""
    monkeypatch.setattr(svc_mod.os, 'name', 'posix')
    monkeypatch.setattr(svc_mod, 'is_command_available', lambda c: True)
    monkeypatch.setattr(StalwartService, '_config', classmethod(lambda cls: dict(CFG)))


# ---------------------------------------------------------------------------
# manifest
# ---------------------------------------------------------------------------

def test_manifest_passes_validator():
    with open(os.path.join(EXT_DIR, 'plugin.json'), encoding='utf-8') as f:
        manifest = json.load(f)
    assert plugin_service._validate_manifest(manifest) is True
    assert manifest['name'] == SLUG
    assert manifest['category'] == 'integration'
    assert manifest['entry_point'] == 'mail:mail_bp'
    assert manifest['url_prefix'] == '/api/v1/mail'
    assert manifest['models'] == 'models:register'
    assert set(manifest['permissions']) == {'shell', 'filesystem', 'network', 'docker'}
    nav = manifest['contributions']['nav'][0]
    assert nav['route'] == '/mail'
    assert nav['id'] == 'mail'
    routes = manifest['contributions']['routes']
    assert {'path': 'mail', 'component': 'MailPage'} in routes
    assert manifest['contributions']['page_titles']['/mail'] == 'Mail Server'


def test_manifest_permissions_are_known():
    from app.plugins_sdk import permissions as sdk_perms
    with open(os.path.join(EXT_DIR, 'plugin.json'), encoding='utf-8') as f:
        manifest = json.load(f)
    assert sdk_perms.unknown_permissions(manifest['permissions']) == []


def test_lifecycle_hook_keys_match_loader():
    """The loader reads lifecycle.get('install')/('uninstall') — the manifest must
    use those exact keys (not 'on_install'/'on_uninstall'), else the hooks that
    register notify events and tear down the container silently never fire. The
    _validate_manifest check only vets the VALUES, so this guards the KEYS and
    proves each referenced hook actually resolves + is importable."""
    import importlib
    with open(os.path.join(EXT_DIR, 'plugin.json'), encoding='utf-8') as f:
        lifecycle = json.load(f)['lifecycle']
    assert set(lifecycle) <= {'install', 'upgrade', 'uninstall'}
    assert 'install' in lifecycle and 'uninstall' in lifecycle
    for ref in lifecycle.values():
        module_name, func_name = ref.split(':')
        mod = importlib.import_module(f'app.plugins.{SLUG}.{module_name}')
        assert callable(getattr(mod, func_name, None)), ref


def test_manifest_jobs_and_schedule_resolve():
    """Job handlers + the daily preflight schedule are wired to real callables."""
    import importlib
    with open(os.path.join(EXT_DIR, 'plugin.json'), encoding='utf-8') as f:
        manifest = json.load(f)
    kinds = {j['kind'] for j in manifest['jobs']}
    assert 'mail.preflight.run' in kinds
    for job in manifest['jobs']:
        module_name, func_name = job['handler'].split(':')
        mod = importlib.import_module(f'app.plugins.{SLUG}.{module_name}')
        assert callable(getattr(mod, func_name, None)), job['handler']
    sched = manifest['schedules'][0]
    assert sched['kind'] in kinds and sched.get('cron')


def test_entry_point_resolves_to_blueprint():
    assert getattr(bp_mod, 'mail_bp', None) is not None
    assert bp_mod.mail_bp.name == 'mail'


def test_models_register_is_a_noop_passthrough():
    # Manifest declares models: "models:register"; the callable must exist and be
    # a harmless passthrough (tables register as an import side effect).
    from app import db
    assert models_mod.register(db) is None


def test_frontend_exports_route_component():
    index = os.path.join(EXT_DIR, 'frontend', 'index.jsx')
    if not os.path.isfile(index):
        pytest.skip('serverkit-mail frontend/index.jsx not present in this build')
    with open(index, encoding='utf-8') as f:
        src = f.read()
    assert 'export { default as MailPage }' in src
    # No module-level default export: PluginLoader legacy-auto-renders those.
    assert 'export default' not in src


# ---------------------------------------------------------------------------
# models
# ---------------------------------------------------------------------------

def test_mail_domain_persists_and_to_dict(app):
    from app import db
    row = MailDomain(name='example.com', catch_all_target='root@example.com',
                     is_active=False, sync_state='pending')
    db.session.add(row)
    db.session.commit()

    d = row.to_dict()
    for key in ('id', 'name', 'is_active', 'catch_all_target', 'dkim_selector',
                'dkim_public_key', 'dkim_configured', 'dns_deployed',
                'dns_last_result', 'sync_state', 'sync_error', 'mailboxes_count',
                'forwarders_count', 'created_at', 'updated_at'):
        assert key in d, key
    assert d['name'] == 'example.com'
    assert d['is_active'] is False
    assert d['dkim_selector'] == 'serverkit'  # column default
    assert d['dkim_configured'] is False
    assert d['mailboxes_count'] == 0


def test_mailbox_has_no_password_and_to_dict(app):
    from app import db
    domain = MailDomain(name='mailbox-test.com')
    db.session.add(domain)
    db.session.commit()

    box = Mailbox(domain_id=domain.id, local_part='alice', quota_mb=512,
                  display_name='Alice')
    db.session.add(box)
    db.session.commit()

    # Passwords are NEVER persisted panel-side.
    assert not hasattr(box, 'password')
    assert 'password' not in Mailbox.__table__.columns
    assert 'password_hash' not in Mailbox.__table__.columns

    d = box.to_dict()
    assert 'password' not in d
    assert d['local_part'] == 'alice'
    assert d['email'] == 'alice@mailbox-test.com'
    assert d['quota_mb'] == 512
    assert d['domain_name'] == 'mailbox-test.com'


def test_mailbox_unique_domain_local_part(app):
    from app import db
    from sqlalchemy.exc import IntegrityError
    domain = MailDomain(name='dupe.com')
    db.session.add(domain)
    db.session.commit()

    db.session.add(Mailbox(domain_id=domain.id, local_part='postmaster'))
    db.session.commit()

    db.session.add(Mailbox(domain_id=domain.id, local_part='postmaster'))
    with pytest.raises(IntegrityError):
        db.session.commit()
    db.session.rollback()


def test_forwarder_and_autoresponder_persist(app):
    from app import db
    domain = MailDomain(name='fwd.com')
    db.session.add(domain)
    db.session.commit()

    fwd = Forwarder(domain_id=domain.id, source_local_part='sales',
                    destination='team@elsewhere.org', keep_copy=True)
    db.session.add(fwd)
    db.session.commit()
    fd = fwd.to_dict()
    assert fd['source'] == 'sales@fwd.com'
    assert fd['destination'] == 'team@elsewhere.org'
    assert fd['keep_copy'] is True

    box = Mailbox(domain_id=domain.id, local_part='bob')
    db.session.add(box)
    db.session.commit()
    ar = Autoresponder(mailbox_id=box.id, enabled=True, subject='OOO', body='Away')
    db.session.add(ar)
    db.session.commit()
    ad = ar.to_dict()
    assert ad['mailbox_id'] == box.id
    assert ad['enabled'] is True
    assert ad['subject'] == 'OOO'


def test_preflight_result_persist_and_to_dict(app):
    from app import db
    row = PreflightResult(hostname='mail.example.com', server_ip='203.0.113.5',
                          ptr_ok=True, ptr_value='mail.example.com',
                          port25_ok=True, rbl_ok=True,
                          rbl_hits=json.dumps([]), ports_ok=True, passed=True,
                          detail=json.dumps({'ptr': {'ok': True}}))
    db.session.add(row)
    db.session.commit()
    d = row.to_dict()
    for key in ('id', 'hostname', 'server_ip', 'ptr_ok', 'ptr_value', 'port25_ok',
                'rbl_ok', 'rbl_hits', 'ports_ok', 'passed', 'detail', 'checked_at'):
        assert key in d, key
    assert d['passed'] is True
    assert d['rbl_hits'] == []            # JSON text decoded back to a list
    assert d['detail'] == {'ptr': {'ok': True}}


# ---------------------------------------------------------------------------
# StalwartService: install / lifecycle argv
# ---------------------------------------------------------------------------

def test_install_builds_correct_docker_run(monkeypatch, linux):
    calls = []
    saved = {}

    def fake_run(cmd, timeout=None, **kwargs):
        calls.append(list(cmd))
        if cmd[:2] == ['docker', 'inspect']:
            return _proc(returncode=1, stderr='No such object')  # not installed
        return _proc(returncode=0, stdout='container123\n')

    monkeypatch.setattr(svc_mod, 'run_privileged', fake_run)
    monkeypatch.setattr(StalwartService, '_save_config',
                        classmethod(lambda cls, updates: saved.update(updates) or True))

    result = StalwartService.install('Mail.Example.COM.')
    assert result['success'] is True, result

    # Data dir created, container started.
    assert ['mkdir', '-p', svc_mod.DATA_DIR] in calls
    run_cmd = next(c for c in calls if c[:2] == ['docker', 'run'])

    # Mail ports published on the host.
    for port in ('25', '465', '587', '993'):
        assert f'{port}:{port}' in run_cmd, port

    # Admin API published on loopback ONLY — never a bare 8080:8080.
    assert f'{svc_mod.API_HOST}:{svc_mod.API_PORT}:{svc_mod.API_PORT}' in run_cmd
    assert '127.0.0.1:8080:8080' in run_cmd
    assert not any(a == '8080:8080' for a in run_cmd)

    # Official image, restart policy, data volume.
    assert svc_mod.IMAGE in run_cmd
    assert '--restart' in run_cmd
    assert f'{svc_mod.DATA_DIR}:{svc_mod.CONTAINER_DATA_DIR}' in run_cmd

    # A generated admin password was seeded into the container AND persisted.
    secret_args = [a for a in run_cmd if a.startswith('FALLBACK_ADMIN_SECRET=')]
    assert len(secret_args) == 1
    generated = secret_args[0].split('=', 1)[1]
    assert generated  # non-empty generated secret
    assert saved['admin_password'] == generated
    assert saved['hostname'] == 'mail.example.com'  # normalized (lowercased, no dot)


def test_install_requires_hostname(monkeypatch, linux):
    monkeypatch.setattr(
        svc_mod, 'run_privileged',
        lambda *a, **kw: pytest.fail('docker must not run on invalid input'))
    assert StalwartService.install('')['success'] is False
    assert StalwartService.install('   ')['success'] is False


def test_install_refuses_when_container_exists(monkeypatch, linux):
    monkeypatch.setattr(
        svc_mod, 'run_privileged',
        lambda cmd, timeout=None, **kw: _proc(returncode=0, stdout='true\n'))
    result = StalwartService.install('mail.example.com')
    assert result['success'] is False
    assert 'already exists' in result['error']


def test_uninstall_keep_data_vs_purge(monkeypatch, linux):
    calls = []

    def fake_run(cmd, timeout=None, **kwargs):
        calls.append(list(cmd))
        return _proc(returncode=0)

    monkeypatch.setattr(svc_mod, 'run_privileged', fake_run)
    monkeypatch.setattr(StalwartService, '_save_config',
                        classmethod(lambda cls, updates: True))

    result = StalwartService.uninstall(keep_data=True)
    assert result['success'] is True
    assert ['docker', 'rm', '-f', svc_mod.CONTAINER_NAME] in calls
    assert not any(c[:1] == ['rm'] for c in calls)  # data dir untouched

    calls.clear()
    result = StalwartService.uninstall(keep_data=False)
    assert result['success'] is True
    assert ['rm', '-rf', svc_mod.DATA_DIR] in calls


def test_windows_is_unsupported(monkeypatch):
    monkeypatch.setattr(svc_mod.os, 'name', 'nt')
    assert StalwartService.is_installed() is False
    result = StalwartService.install('mail.example.com')
    assert result['success'] is False
    assert 'Windows' in result['error']
    status = StalwartService.get_status()
    assert status['installed'] is False
    assert status['running'] is False
    # _api short-circuits on Windows without touching the network.
    api = StalwartService._api('GET', '/principal')
    assert api['success'] is False
    assert 'Windows' in api['error']


# ---------------------------------------------------------------------------
# StalwartService: status + admin API choke-point
# ---------------------------------------------------------------------------

def test_status_running_reads_version(monkeypatch, linux):
    monkeypatch.setattr(
        svc_mod, 'run_privileged',
        lambda cmd, timeout=None, **kw: _proc(returncode=0, stdout='true\n'))
    monkeypatch.setattr(
        svc_mod.requests, 'request',
        lambda method, url, **kw: FakeResponse(200, {'version': '0.11.1'}))
    status = StalwartService.get_status()
    assert status['installed'] is True
    assert status['running'] is True
    assert status['version'] == '0.11.1'
    assert status['engine'] == 'stalwart'
    assert status['admin_api'] == f'{svc_mod.API_HOST}:{svc_mod.API_PORT}'


def test_status_not_installed(monkeypatch, linux):
    monkeypatch.setattr(
        svc_mod, 'run_privileged',
        lambda cmd, timeout=None, **kw: _proc(returncode=1, stderr='No such object'))
    status = StalwartService.get_status()
    assert status['installed'] is False
    assert status['running'] is False


def test_api_uses_basic_auth_and_returns_data(monkeypatch, linux):
    seen = {}

    def fake_request(method, url, auth=None, json=None, timeout=None):
        seen.update(method=method, url=url, auth=auth, json=json)
        return FakeResponse(200, {'ok': True})

    monkeypatch.setattr(svc_mod.requests, 'request', fake_request)
    res = StalwartService._api('POST', '/principal', {'name': 'a@b.co'})
    assert res['success'] is True
    assert res['data'] == {'ok': True}
    assert seen['method'] == 'POST'
    assert seen['url'] == svc_mod.API_BASE + '/principal'
    assert seen['auth'] == (svc_mod.ADMIN_USER, CFG['admin_password'])


def test_api_error_status_is_clean(monkeypatch, linux):
    monkeypatch.setattr(
        svc_mod.requests, 'request',
        lambda *a, **kw: FakeResponse(422, {'error': 'principal exists'}))
    res = StalwartService._api('POST', '/principal', {})
    assert res['success'] is False
    assert res['status_code'] == 422
    assert 'principal exists' in res['error']


def test_api_unreachable_is_clean(monkeypatch, linux):
    def boom(*a, **kw):
        raise svc_mod.requests.RequestException('connection refused')
    monkeypatch.setattr(svc_mod.requests, 'request', boom)
    res = StalwartService._api('GET', '/principal')
    assert res['success'] is False
    assert 'unreachable' in res['error']


def test_api_requires_admin_password(monkeypatch, linux):
    monkeypatch.setattr(StalwartService, '_config', classmethod(lambda cls: {}))
    monkeypatch.setattr(
        svc_mod.requests, 'request',
        lambda *a, **kw: pytest.fail('API must not be called without a password'))
    res = StalwartService._api('GET', '/principal')
    assert res['success'] is False
    assert 'password is not configured' in res['error']


# ---------------------------------------------------------------------------
# StalwartService: best-effort reconcile methods (never raise)
# ---------------------------------------------------------------------------

def test_reconcile_methods_skip_when_not_installed(monkeypatch, linux):
    monkeypatch.setattr(StalwartService, 'is_installed', classmethod(lambda cls: False))
    monkeypatch.setattr(
        svc_mod.requests, 'request',
        lambda *a, **kw: pytest.fail('no API call when engine is absent'))
    for res in (StalwartService.upsert_account('a@b.co', password='x'),
                StalwartService.upsert_domain('b.co'),
                StalwartService.delete_account('a@b.co'),
                StalwartService.set_password('a@b.co', 'x'),
                StalwartService.flush_queue()):
        assert res['success'] is False
        assert res.get('skipped') is True
    # Queue introspection degrades to an empty list, not an error.
    q = StalwartService.list_queue()
    assert q == {'success': True, 'messages': []}


def test_reconcile_upsert_account_success_and_error(monkeypatch, linux):
    monkeypatch.setattr(StalwartService, 'is_installed', classmethod(lambda cls: True))

    calls = []

    def ok_api(cls, method, path, payload=None):
        calls.append((method, path, payload))
        return {'success': True, 'data': None}
    monkeypatch.setattr(StalwartService, '_api', classmethod(ok_api))
    res = StalwartService.upsert_account('alice@example.com', password='pw',
                                         quota_mb=100, display_name='Alice')
    assert res == {'success': True, 'email': 'alice@example.com'}
    method, path, payload = calls[0]
    assert method == 'POST'
    assert path == svc_mod.EP_PRINCIPAL
    assert payload['type'] == 'individual'
    assert payload['name'] == 'alice@example.com'
    assert payload['secrets'] == ['pw']
    assert payload['quota'] == 100 * 1024 * 1024

    monkeypatch.setattr(
        StalwartService, '_api',
        classmethod(lambda cls, m, p, payload=None: {'success': False, 'error': 'boom'}))
    res = StalwartService.upsert_account('bob@example.com')
    assert res['success'] is False
    assert 'boom' in res['error']


def test_list_queue_shapes(monkeypatch, linux):
    monkeypatch.setattr(StalwartService, 'is_installed', classmethod(lambda cls: True))
    monkeypatch.setattr(
        StalwartService, '_api',
        classmethod(lambda cls, m, p, payload=None: {'success': True,
                                                     'data': [{'id': 1}, {'id': 2}]}))
    res = StalwartService.list_queue()
    assert res['success'] is True
    assert res['messages'] == [{'id': 1}, {'id': 2}]

    # A dict payload with items is unwrapped; an API failure degrades to [].
    monkeypatch.setattr(
        StalwartService, '_api',
        classmethod(lambda cls, m, p, payload=None: {'success': True,
                                                     'data': {'items': [{'id': 9}]}}))
    assert StalwartService.list_queue()['messages'] == [{'id': 9}]
    monkeypatch.setattr(
        StalwartService, '_api',
        classmethod(lambda cls, m, p, payload=None: {'success': False, 'error': 'down'}))
    res = StalwartService.list_queue()
    assert res['messages'] == []
    assert res['note'] == 'down'


# ---------------------------------------------------------------------------
# blueprint routes
# ---------------------------------------------------------------------------

@pytest.fixture
def mail_app(app):
    """Register the extension blueprint on the test app (name-guarded)."""
    if 'mail' not in app.blueprints:
        app.register_blueprint(bp_mod.mail_bp, url_prefix='/api/v1/mail')
    return app


@pytest.fixture
def mail_client(mail_app):
    return mail_app.test_client()


def test_routes_require_auth(mail_client):
    assert mail_client.get('/api/v1/mail/status').status_code == 401
    assert mail_client.post('/api/v1/mail/install', json={}).status_code == 401
    assert mail_client.get('/api/v1/mail/domains').status_code == 401
    assert mail_client.post('/api/v1/mail/domains', json={}).status_code == 401
    assert mail_client.get('/api/v1/mail/queue').status_code == 401


def test_status_route(mail_client, auth_headers, monkeypatch):
    monkeypatch.setattr(
        bp_mod.MailService, 'get_status',
        classmethod(lambda cls: {
            'installed': True, 'running': True, 'version': '0.11',
            'engine': 'stalwart', 'preflight': None, 'domains_count': 0,
            'docs_url': svc_mod.DOCS_URL,
        }))
    resp = mail_client.get('/api/v1/mail/status', headers=auth_headers)
    assert resp.status_code == 200
    data = resp.get_json()
    assert data['installed'] is True
    assert data['engine'] == 'stalwart'


def test_preflight_get_route(mail_client, auth_headers, monkeypatch):
    monkeypatch.setattr(
        bp_mod.PreflightService, 'latest',
        classmethod(lambda cls: {'passed': True, 'hostname': 'mail.example.com'}))
    resp = mail_client.get('/api/v1/mail/preflight', headers=auth_headers)
    assert resp.status_code == 200
    assert resp.get_json()['preflight']['passed'] is True


def test_preflight_post_route(mail_client, auth_headers, monkeypatch):
    captured = {}

    def fake_run(cls, hostname, server_ip=None):
        captured.update(hostname=hostname, server_ip=server_ip)
        return {'passed': False, 'hostname': hostname}
    monkeypatch.setattr(bp_mod.PreflightService, 'run', classmethod(fake_run))
    resp = mail_client.post('/api/v1/mail/preflight',
                            json={'hostname': 'mail.example.com', 'server_ip': '1.2.3.4'},
                            headers=auth_headers)
    assert resp.status_code == 200
    assert captured['hostname'] == 'mail.example.com'
    assert captured['server_ip'] == '1.2.3.4'

    # hostname is required.
    resp = mail_client.post('/api/v1/mail/preflight', json={}, headers=auth_headers)
    assert resp.status_code == 400
    assert 'error' in resp.get_json()


def test_install_route(mail_client, auth_headers, monkeypatch):
    captured = {}

    def fake_install(cls, hostname):
        captured['hostname'] = hostname
        return {'success': True, 'message': 'ok', 'container': svc_mod.CONTAINER_NAME}
    monkeypatch.setattr(bp_mod.StalwartService, 'install', classmethod(fake_install))
    resp = mail_client.post('/api/v1/mail/install',
                            json={'hostname': 'mail.example.com'}, headers=auth_headers)
    assert resp.status_code == 201
    assert captured['hostname'] == 'mail.example.com'

    resp = mail_client.post('/api/v1/mail/install', json={}, headers=auth_headers)
    assert resp.status_code == 400
    assert 'error' in resp.get_json()


def test_domains_routes_happy_path(mail_client, auth_headers, monkeypatch):
    monkeypatch.setattr(
        bp_mod.MailService, 'list_domains',
        classmethod(lambda cls: [{'id': 1, 'name': 'example.com'}]))
    resp = mail_client.get('/api/v1/mail/domains', headers=auth_headers)
    assert resp.status_code == 200
    assert resp.get_json()['domains'][0]['name'] == 'example.com'

    captured = {}

    def fake_add(cls, name, catch_all_target=None):
        captured.update(name=name, catch_all_target=catch_all_target)
        return {'success': True, 'domain': {'id': 1, 'name': name}}
    monkeypatch.setattr(bp_mod.MailService, 'add_domain', classmethod(fake_add))
    resp = mail_client.post('/api/v1/mail/domains',
                            json={'name': 'example.com', 'catch_all_target': 'root@example.com'},
                            headers=auth_headers)
    assert resp.status_code == 201
    assert captured == {'name': 'example.com', 'catch_all_target': 'root@example.com'}

    # name is required.
    resp = mail_client.post('/api/v1/mail/domains', json={}, headers=auth_headers)
    assert resp.status_code == 400
    assert 'error' in resp.get_json()


def test_add_domain_service_error_is_400(mail_client, auth_headers, monkeypatch):
    monkeypatch.setattr(
        bp_mod.MailService, 'add_domain',
        classmethod(lambda cls, name, catch_all_target=None: {
            'success': False, 'error': 'Domain example.com already exists'}))
    resp = mail_client.post('/api/v1/mail/domains',
                            json={'name': 'example.com'}, headers=auth_headers)
    assert resp.status_code == 400
    assert 'already exists' in resp.get_json()['error']


def test_mailbox_create_validation(mail_client, auth_headers, monkeypatch):
    captured = {}

    def fake_add(cls, domain_id, local_part, password, quota_mb=0, display_name=None):
        captured.update(domain_id=domain_id, local_part=local_part, password=password)
        return {'success': True, 'mailbox': {'id': 1, 'local_part': local_part}}
    monkeypatch.setattr(bp_mod.MailService, 'add_mailbox', classmethod(fake_add))

    # Missing password -> 400 before the service runs.
    resp = mail_client.post('/api/v1/mail/domains/1/mailboxes',
                            json={'local_part': 'alice'}, headers=auth_headers)
    assert resp.status_code == 400
    assert captured == {}

    # Missing local_part -> 400.
    resp = mail_client.post('/api/v1/mail/domains/1/mailboxes',
                            json={'password': 'x'}, headers=auth_headers)
    assert resp.status_code == 400

    # Happy path -> 201, password forwarded to the service (never persisted).
    resp = mail_client.post('/api/v1/mail/domains/1/mailboxes',
                            json={'local_part': 'alice', 'password': 's3cret'},
                            headers=auth_headers)
    assert resp.status_code == 201
    assert captured['local_part'] == 'alice'
    assert captured['password'] == 's3cret'


def test_queue_route_503_when_not_installed(mail_client, auth_headers, monkeypatch):
    monkeypatch.setattr(bp_mod.StalwartService, 'is_installed', classmethod(lambda cls: False))
    resp = mail_client.get('/api/v1/mail/queue', headers=auth_headers)
    assert resp.status_code == 503
    assert 'error' in resp.get_json()


def test_queue_route_ok_when_installed(mail_client, auth_headers, monkeypatch):
    monkeypatch.setattr(bp_mod.StalwartService, 'is_installed', classmethod(lambda cls: True))
    monkeypatch.setattr(
        bp_mod.StalwartService, 'list_queue',
        classmethod(lambda cls: {'success': True, 'messages': [{'id': 1}]}))
    resp = mail_client.get('/api/v1/mail/queue', headers=auth_headers)
    assert resp.status_code == 200
    assert resp.get_json()['messages'] == [{'id': 1}]
