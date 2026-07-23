"""Themes platform tests (plan 60).

Proves the backend gate: server-side token validation on import, the admin
gate, bundled-seed listing, panel-default selection, and the UNAUTHENTICATED
pre-auth GET /public/active channel.
"""


def _dev_headers(app):
    """A non-admin (developer) user's auth headers."""
    from app import db
    from app.models import User
    from flask_jwt_extended import create_access_token
    from werkzeug.security import generate_password_hash
    with app.app_context():
        u = User(
            email='dev@test.local', username='devuser',
            password_hash=generate_password_hash('x'),
            role=User.ROLE_DEVELOPER, is_active=True,
        )
        db.session.add(u)
        db.session.commit()
        token = create_access_token(identity=u.id)
    return {'Authorization': f'Bearer {token}'}


VALID_THEME = {
    'schema_version': 1,
    'slug': 'test-theme',
    'name': 'Test Theme',
    'author': 'tester',
    'base': 'dark',
    'tokens': {'dark': {'--surface': '#123456', '--text': '#ffffff', '--radius': '12px'}},
    'accent': '#88c0d0',
    'preview': ['#111111', '#222222', '#333333', '#444444'],
}


def test_public_active_is_unauthenticated_and_defaults_to_stock(client):
    """The pre-auth channel needs no token and returns the stock look by default."""
    resp = client.get('/api/v1/themes/public/active')
    assert resp.status_code == 200
    data = resp.get_json()
    assert data['slug'] == 'default'
    assert data['tokens'] == {}


def test_installed_requires_auth(client):
    assert client.get('/api/v1/themes/installed').status_code == 401


def test_installed_lists_bundled_seeds(client, auth_headers):
    resp = client.get('/api/v1/themes/installed', headers=auth_headers)
    assert resp.status_code == 200
    data = resp.get_json()
    slugs = {t['slug'] for t in data['themes']}
    # The bundled seeds ship with the panel and always list.
    assert {'default', 'nord-deep', 'paper', 'phosphor'}.issubset(slugs)
    assert data['default'] == 'default'


def test_import_valid_theme_stores_and_lists(client, auth_headers):
    resp = client.post('/api/v1/themes/import', json=VALID_THEME, headers=auth_headers)
    assert resp.status_code == 201, resp.get_json()
    stored = resp.get_json()
    assert stored['slug'] == 'test-theme'
    assert stored['tokens']['dark']['--surface'] == '#123456'
    assert stored['source'] == 'import'

    listing = client.get('/api/v1/themes/installed', headers=auth_headers).get_json()
    assert 'test-theme' in {t['slug'] for t in listing['themes']}


def test_import_sanitizes_malicious_token_values(client, auth_headers):
    """url()/CSS-breakout values are dropped server-side; clean tokens survive."""
    payload = {
        **VALID_THEME,
        'slug': 'sneaky',
        'tokens': {'dark': {
            '--surface': 'url(https://evil.example/x.png)',   # exfil vector
            '--text': '#fff}html{display:none',                # CSS breakout
            '--border': '#23272f',                              # legitimate
            '--evil': '#000000',                                # not whitelisted
        }},
    }
    resp = client.post('/api/v1/themes/import', json=payload, headers=auth_headers)
    assert resp.status_code == 201, resp.get_json()
    tokens = resp.get_json()['tokens']['dark']
    assert tokens == {'--border': '#23272f'}
    assert '--surface' not in tokens and '--text' not in tokens and '--evil' not in tokens


def test_import_rejects_theme_with_no_valid_tokens(client, auth_headers):
    payload = {**VALID_THEME, 'slug': 'all-bad', 'tokens': {'dark': {'--surface': 'url(x)'}}}
    resp = client.post('/api/v1/themes/import', json=payload, headers=auth_headers)
    assert resp.status_code == 400


def test_import_rejects_malicious_preview_swatch(client, auth_headers):
    """Preview swatches are painted as inline CSS — an url() payload must be
    rejected, not stored."""
    payload = {
        **VALID_THEME,
        'slug': 'evil-preview',
        'preview': ['#111111', '#222222', 'url(https://evil.example/x)', '#444444'],
    }
    resp = client.post('/api/v1/themes/import', json=payload, headers=auth_headers)
    assert resp.status_code == 400


def test_import_accepts_valid_mixed_preview(client, auth_headers):
    """Hex, functional rgb()/hsl() and named colors are all legit swatches."""
    payload = {
        **VALID_THEME,
        'slug': 'mixed-preview',
        'preview': ['#88c0d0', 'rgb(136, 192, 208)', 'rebeccapurple', 'hsl(210, 50%, 40%)'],
    }
    resp = client.post('/api/v1/themes/import', json=payload, headers=auth_headers)
    assert resp.status_code == 201, resp.get_json()
    assert resp.get_json()['preview'] == payload['preview']


def test_import_tolerates_unknown_metadata_fields(client, auth_headers):
    """Unknown-but-harmless top-level metadata (license, index-only fields like
    image/modes) is ignored, not rejected and not stored."""
    payload = {
        **VALID_THEME,
        'slug': 'licensed',
        'license': 'MIT',
        'image': 'https://example.com/shot.png',
        'modes': ['dark'],
    }
    resp = client.post('/api/v1/themes/import', json=payload, headers=auth_headers)
    assert resp.status_code == 201, resp.get_json()
    stored = resp.get_json()
    assert stored['slug'] == 'licensed'
    assert 'license' not in stored and 'image' not in stored and 'modes' not in stored


def test_import_rejects_reserved_default_slug(client, auth_headers):
    payload = {**VALID_THEME, 'slug': 'default'}
    resp = client.post('/api/v1/themes/import', json=payload, headers=auth_headers)
    assert resp.status_code == 400


def test_import_requires_admin(client, app):
    resp = client.post('/api/v1/themes/import', json=VALID_THEME, headers=_dev_headers(app))
    assert resp.status_code == 403


def test_delete_installed_theme(client, auth_headers):
    client.post('/api/v1/themes/import', json=VALID_THEME, headers=auth_headers)
    resp = client.delete('/api/v1/themes/test-theme', headers=auth_headers)
    assert resp.status_code == 200
    listing = client.get('/api/v1/themes/installed', headers=auth_headers).get_json()
    assert 'test-theme' not in {t['slug'] for t in listing['themes']}


def test_bundled_theme_cannot_be_deleted(client, auth_headers):
    resp = client.delete('/api/v1/themes/nord-deep', headers=auth_headers)
    assert resp.status_code == 400


def test_set_default_flows_to_public_active(client, auth_headers):
    """Setting the panel default surfaces its tokens on the pre-auth channel."""
    client.post('/api/v1/themes/import', json=VALID_THEME, headers=auth_headers)
    resp = client.post('/api/v1/themes/default', json={'slug': 'test-theme'}, headers=auth_headers)
    assert resp.status_code == 200

    active = client.get('/api/v1/themes/public/active').get_json()
    assert active['slug'] == 'test-theme'
    assert active['tokens']['dark']['--surface'] == '#123456'


def test_set_default_rejects_unknown_theme(client, auth_headers):
    resp = client.post('/api/v1/themes/default', json={'slug': 'nope-nope'}, headers=auth_headers)
    assert resp.status_code == 400


def test_deleting_default_theme_reverts_to_stock(client, auth_headers):
    client.post('/api/v1/themes/import', json=VALID_THEME, headers=auth_headers)
    client.post('/api/v1/themes/default', json={'slug': 'test-theme'}, headers=auth_headers)
    client.delete('/api/v1/themes/test-theme', headers=auth_headers)
    active = client.get('/api/v1/themes/public/active').get_json()
    assert active['slug'] == 'default'
