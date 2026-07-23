"""Theme registry tests (plan 60, Phase 3).

Proves the panel-side registry pipeline: offline-tolerant fallback to the
bundled index, the admin-gated install, and a mocked end-to-end install flow
(fetch index → fetch theme.json → validate → store).
"""
import pytest

from app.services import theme_registry_service


@pytest.fixture(autouse=True)
def _reset_registry_cache():
    """The registry cache is module-level; clear it around each test."""
    theme_registry_service._cache.update(
        {'ts': 0.0, 'entries': None, 'source': None}
    )
    yield
    theme_registry_service._cache.update(
        {'ts': 0.0, 'entries': None, 'source': None}
    )


class _FakeResp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


FAKE_INDEX = {
    'schema_version': 1,
    'themes': [{
        'slug': 'aurora',
        'name': 'Aurora',
        'base': 'dark',
        'description': 'Test registry theme',
        'preview': ['#111111', '#222222', '#88c0d0', '#eeeeee'],
        'modes': ['dark'],
        'theme': 'themes/aurora/theme.json',
    }],
}

FAKE_THEME = {
    'schema_version': 1,
    'slug': 'aurora',
    'name': 'Aurora',
    'base': 'dark',
    'tokens': {'dark': {'--surface': '#123456', '--text': '#ffffff'}},
    'accent': '#88c0d0',
    'preview': ['#111111', '#222222', '#88c0d0', '#eeeeee'],
}


def _mock_requests(monkeypatch):
    def fake_get(url, *a, **k):
        if url.endswith('/theme.json'):
            return _FakeResp(FAKE_THEME)
        return _FakeResp(FAKE_INDEX)
    monkeypatch.setattr(theme_registry_service.requests, 'get', fake_get)
    monkeypatch.setenv('SERVERKIT_THEMES_REGISTRY_URL', 'https://fake.local/index.json')


def test_registry_offline_falls_back_to_bundled(client, auth_headers, monkeypatch):
    """A disabled/unreachable registry serves the bundled index, and bundled
    seed slugs are excluded from the browse catalogue (they already show)."""
    monkeypatch.setenv('SERVERKIT_THEMES_REGISTRY_URL', '')  # disabled → bundled
    resp = client.get('/api/v1/themes/registry', headers=auth_headers)
    assert resp.status_code == 200
    data = resp.get_json()
    assert data['source'] == 'bundled'
    slugs = {t['slug'] for t in data['themes']}
    assert 'nord-deep' not in slugs and 'default' not in slugs


def test_registry_lists_remote_theme(client, auth_headers, monkeypatch):
    _mock_requests(monkeypatch)
    resp = client.get('/api/v1/themes/registry', headers=auth_headers)
    assert resp.status_code == 200
    themes = resp.get_json()['themes']
    aurora = next((t for t in themes if t['slug'] == 'aurora'), None)
    assert aurora is not None
    assert aurora['installed'] is False


def test_registry_install_flow(client, auth_headers, monkeypatch):
    _mock_requests(monkeypatch)
    resp = client.post('/api/v1/themes/registry/aurora/install', headers=auth_headers)
    assert resp.status_code == 201, resp.get_json()
    stored = resp.get_json()
    assert stored['slug'] == 'aurora'
    assert stored['source'] == 'registry'
    assert stored['tokens']['dark']['--surface'] == '#123456'

    installed = client.get('/api/v1/themes/installed', headers=auth_headers).get_json()
    assert 'aurora' in {t['slug'] for t in installed['themes']}


def test_registry_install_unknown_slug_404(client, auth_headers, monkeypatch):
    _mock_requests(monkeypatch)
    resp = client.post('/api/v1/themes/registry/does-not-exist/install', headers=auth_headers)
    assert resp.status_code == 404


def test_registry_install_requires_admin(client, app, monkeypatch):
    from app import db
    from app.models import User
    from flask_jwt_extended import create_access_token
    from werkzeug.security import generate_password_hash
    _mock_requests(monkeypatch)
    with app.app_context():
        u = User(email='d2@t.local', username='d2',
                 password_hash=generate_password_hash('x'),
                 role=User.ROLE_DEVELOPER, is_active=True)
        db.session.add(u)
        db.session.commit()
        headers = {'Authorization': f'Bearer {create_access_token(identity=u.id)}'}
    resp = client.post('/api/v1/themes/registry/aurora/install', headers=headers)
    assert resp.status_code == 403


def test_registry_failure_serves_last_good_without_refetch(monkeypatch):
    """A failed refresh with a last-good cache stamps the cache timestamp, so
    the TTL applies and follow-up calls don't retry (and stall on) the network."""
    calls = []

    def flaky_get(url, *a, **k):
        calls.append(url)
        if len(calls) == 1:
            return _FakeResp(FAKE_INDEX)
        raise RuntimeError('offline')

    monkeypatch.setattr(theme_registry_service.requests, 'get', flaky_get)
    monkeypatch.setenv('SERVERKIT_THEMES_REGISTRY_URL', 'https://fake.local/index.json')

    first = theme_registry_service.refresh()
    assert [t['slug'] for t in first] == ['aurora']

    # Expire the cache, then fail the refresh: last-good entries are served
    # and the timestamp is stamped.
    theme_registry_service._cache['ts'] = 0.0
    second = theme_registry_service.refresh()
    assert [t['slug'] for t in second] == ['aurora']
    assert len(calls) == 2

    # Within the TTL the fallback is served from cache — no network retry.
    third = theme_registry_service.refresh()
    assert [t['slug'] for t in third] == ['aurora']
    assert len(calls) == 2


def test_registry_failure_without_cache_backs_off(monkeypatch):
    """With no cache to serve, a failed fetch falls back to the bundled index
    under a short failure backoff: repeated calls don't hammer upstream, and
    the registry is retried once the backoff expires."""
    calls = []

    def failing_get(url, *a, **k):
        calls.append(url)
        raise RuntimeError('offline')

    monkeypatch.setattr(theme_registry_service.requests, 'get', failing_get)
    monkeypatch.setenv('SERVERKIT_THEMES_REGISTRY_URL', 'https://fake.local/index.json')

    first = theme_registry_service.refresh()
    assert first  # bundled fallback served

    # Within the failure backoff, no second upstream attempt.
    second = theme_registry_service.refresh()
    assert second == first
    assert len(calls) == 1

    # After the failure backoff expires, the registry is retried.
    theme_registry_service._cache['ts'] -= theme_registry_service._FAILURE_TTL + 1
    theme_registry_service.refresh()
    assert len(calls) == 2
