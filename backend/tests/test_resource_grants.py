"""Tests for per-resource access grants (#33 — per-site ACL)."""


def _mk_user(db, username, role='developer'):
    from app.models import User
    from werkzeug.security import generate_password_hash
    u = User(email=f'{username}@t.local', username=username,
             password_hash=generate_password_hash('x'), role=role, is_active=True)
    db.session.add(u)
    db.session.commit()
    return u


def _token(user_id):
    from flask_jwt_extended import create_access_token
    return {'Authorization': f'Bearer {create_access_token(identity=user_id)}'}


def test_grant_makes_app_visible_and_accessible(app, client):
    from app import db
    from app.models import Application

    owner = _mk_user(db, 'g_owner')
    grantee = _mk_user(db, 'g_grantee')
    a = Application(name='shared-app', app_type='php', user_id=owner.id)
    db.session.add(a)
    db.session.commit()
    app_id = a.id

    # Before the grant: the grantee neither sees nor can open the app.
    r = client.get('/api/v1/apps', headers=_token(grantee.id))
    assert 'shared-app' not in {x['name'] for x in r.get_json()['apps']}
    r = client.get(f'/api/v1/apps/{app_id}', headers=_token(grantee.id))
    assert r.status_code == 403

    # Owner shares it.
    r = client.post(f'/api/v1/apps/{app_id}/grants', json={'user_id': grantee.id}, headers=_token(owner.id))
    assert r.status_code == 201

    # Now the grantee sees it in their list and can open it.
    r = client.get('/api/v1/apps', headers=_token(grantee.id))
    assert 'shared-app' in {x['name'] for x in r.get_json()['apps']}
    r = client.get(f'/api/v1/apps/{app_id}', headers=_token(grantee.id))
    assert r.status_code == 200

    # An unrelated user still can't.
    other = _mk_user(db, 'g_other')
    r = client.get(f'/api/v1/apps/{app_id}', headers=_token(other.id))
    assert r.status_code == 403


def test_grant_management_permissions(app, client):
    from app import db
    from app.models import Application

    owner = _mk_user(db, 'm_owner')
    grantee = _mk_user(db, 'm_grantee')
    stranger = _mk_user(db, 'm_stranger')
    a = Application(name='m-app', app_type='php', user_id=owner.id)
    db.session.add(a)
    db.session.commit()
    app_id = a.id

    # A non-owner non-admin can't manage sharing.
    r = client.post(f'/api/v1/apps/{app_id}/grants', json={'user_id': grantee.id}, headers=_token(stranger.id))
    assert r.status_code == 403

    # Owner grants, lists, and the owner can't be granted to themselves.
    r = client.post(f'/api/v1/apps/{app_id}/grants', json={'user_id': grantee.id}, headers=_token(owner.id))
    assert r.status_code == 201
    grant_id = r.get_json()['grant']['id']

    r = client.get(f'/api/v1/apps/{app_id}/grants', headers=_token(owner.id))
    assert r.status_code == 200 and len(r.get_json()['grants']) == 1

    r = client.post(f'/api/v1/apps/{app_id}/grants', json={'user_id': owner.id}, headers=_token(owner.id))
    assert r.status_code == 400

    # Revoke -> the grantee loses access.
    r = client.delete(f'/api/v1/apps/{app_id}/grants/{grant_id}', headers=_token(owner.id))
    assert r.status_code == 200
    r = client.get(f'/api/v1/apps/{app_id}', headers=_token(grantee.id))
    assert r.status_code == 403


def test_grant_is_idempotent(app, client):
    from app import db
    from app.models import Application
    from app.models.workspace import ResourceGrant

    owner = _mk_user(db, 'i_owner')
    grantee = _mk_user(db, 'i_grantee')
    a = Application(name='i-app', app_type='php', user_id=owner.id)
    db.session.add(a)
    db.session.commit()

    client.post(f'/api/v1/apps/{a.id}/grants', json={'user_id': grantee.id}, headers=_token(owner.id))
    client.post(f'/api/v1/apps/{a.id}/grants', json={'user_id': grantee.id}, headers=_token(owner.id))
    assert ResourceGrant.query.filter_by(resource_type='application', resource_id=a.id, user_id=grantee.id).count() == 1


def test_grant_enables_wordpress_per_site_routes(app, client):
    from app import db
    from app.models import Application, WordPressSite
    from app.services.resource_grant_service import ResourceGrantService

    owner = _mk_user(db, 'wpg_owner')
    grantee = _mk_user(db, 'wpg_grantee')
    a = Application(name='wpg-app', app_type='wordpress', user_id=owner.id)
    db.session.add(a)
    db.session.commit()
    db.session.add(WordPressSite(application_id=a.id, is_production=True))
    db.session.commit()

    # A WP per-site route (guarded by _owner_or_admin_app) is denied before the grant.
    r = client.get(f'/api/v1/wordpress/sites/{a.id}/updates', headers=_token(grantee.id))
    assert r.status_code == 403

    # After a grant, the same route is reachable — one helper covers every WP route.
    ResourceGrantService.grant(user_id=grantee.id, resource_type='application',
                               resource_id=a.id, granted_by=owner.id)
    r = client.get(f'/api/v1/wordpress/sites/{a.id}/updates', headers=_token(grantee.id))
    assert r.status_code == 200
