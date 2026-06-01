"""Tests for the workspace scoping foundation (#33 core)."""
import pytest


def _mk_user(db, username, role='admin'):
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


# ---- ensure_default_workspace --------------------------------------------

def test_ensure_default_workspace_idempotent(app):
    from app.services.workspace_service import WorkspaceService
    from app.models.workspace import Workspace
    ws1 = WorkspaceService.ensure_default_workspace()
    ws2 = WorkspaceService.ensure_default_workspace()
    assert ws1.id == ws2.id
    assert Workspace.query.filter_by(slug='default').count() == 1
    # Quota columns must be concrete ints (0), never NULL — the model does int math on them.
    assert ws1.max_users == 0


# ---- resolve_workspace_id -------------------------------------------------

def test_resolve_workspace_id_branches(app):
    from app import db
    from app.services.workspace_service import WorkspaceService

    admin = _mk_user(db, 'r_admin', 'admin')
    owner = _mk_user(db, 'r_owner', 'developer')
    outsider = _mk_user(db, 'r_outsider', 'developer')

    # No active context.
    assert WorkspaceService.resolve_workspace_id(outsider, None) == (None, None)
    assert WorkspaceService.resolve_workspace_id(outsider, '') == (None, None)
    assert WorkspaceService.resolve_workspace_id(outsider, 'all') == (None, None)

    # Malformed / missing.
    wsid, err = WorkspaceService.resolve_workspace_id(outsider, 'abc')
    assert wsid is None and err[1] == 400
    wsid, err = WorkspaceService.resolve_workspace_id(outsider, 99999)
    assert wsid is None and err[1] == 404

    # A workspace owned by `owner` (creator becomes owner-member).
    ws = WorkspaceService.create_workspace({'name': 'Acme'}, owner.id)

    # A non-member non-admin is denied.
    wsid, err = WorkspaceService.resolve_workspace_id(outsider, ws.id)
    assert wsid is None and err[1] == 403

    # An admin who is NOT a member is allowed (admin bypass).
    wsid, err = WorkspaceService.resolve_workspace_id(admin, ws.id)
    assert wsid == ws.id and err is None

    # A member is allowed.
    WorkspaceService.add_member(ws.id, outsider.id, 'member')
    wsid, err = WorkspaceService.resolve_workspace_id(outsider, ws.id)
    assert wsid == ws.id and err is None


def test_resolve_rejects_deactivated_user_on_workspace_path(app):
    from app import db
    from app.services.workspace_service import WorkspaceService

    admin = _mk_user(db, 'd_admin', 'admin')
    ws = WorkspaceService.create_workspace({'name': 'DW'}, admin.id)
    member = _mk_user(db, 'd_member', 'developer')
    WorkspaceService.add_member(ws.id, member.id, 'member')
    member.is_active = False
    db.session.commit()

    # Requesting a workspace as a deactivated account is rejected...
    wsid, err = WorkspaceService.resolve_workspace_id(member, ws.id)
    assert wsid is None and err[1] == 403
    # ...but the no-context path is unchanged (no new behavior there).
    assert WorkspaceService.resolve_workspace_id(member, None) == (None, None)


# ---- scope_query ----------------------------------------------------------

def test_scope_query_branches(app):
    from app import db
    from app.services.workspace_service import WorkspaceService
    from app.models import Application

    admin = _mk_user(db, 'q_admin', 'admin')
    dev = _mk_user(db, 'q_dev', 'developer')
    a1 = Application(name='a1', app_type='php', user_id=dev.id, workspace_id=1)
    a2 = Application(name='a2', app_type='php', user_id=admin.id, workspace_id=2)
    db.session.add_all([a1, a2])
    db.session.commit()

    def names(q):
        return {a.name for a in q.all()}

    # Active workspace context -> filter by workspace_id.
    q = WorkspaceService.scope_query(Application.query, Application, dev, workspace_id=1, owner_attr='user_id')
    assert names(q) == {'a1'}

    # No context, non-admin, owner_attr -> own rows only (prior behavior).
    q = WorkspaceService.scope_query(Application.query, Application, dev, workspace_id=None, owner_attr='user_id')
    assert names(q) == {'a1'}

    # No context, admin -> everything (prior behavior).
    q = WorkspaceService.scope_query(Application.query, Application, admin, workspace_id=None, owner_attr='user_id')
    assert names(q) == {'a1', 'a2'}

    # No context, owner_attr=None (a global resource like servers) -> everything, even for a non-admin.
    q = WorkspaceService.scope_query(Application.query, Application, dev, workspace_id=None, owner_attr=None)
    assert names(q) == {'a1', 'a2'}


# ---- API: applications ----------------------------------------------------

def test_get_apps_scoping_api(app, client):
    from app import db
    from app.services.workspace_service import WorkspaceService
    from app.models import Application

    admin = _mk_user(db, 'api_admin', 'admin')
    dev = _mk_user(db, 'api_dev', 'developer')
    ws = WorkspaceService.create_workspace({'name': 'WS1'}, admin.id)
    other = WorkspaceService.create_workspace({'name': 'WS2'}, admin.id)
    db.session.add_all([
        Application(name='in-ws', app_type='php', user_id=dev.id, workspace_id=ws.id),
        Application(name='other-ws', app_type='php', user_id=dev.id, workspace_id=other.id),
    ])
    db.session.commit()

    # No context: dev sees its own apps regardless of workspace (prior behavior preserved).
    r = client.get('/api/v1/apps', headers=_token(dev.id))
    assert r.status_code == 200
    assert {a['name'] for a in r.get_json()['apps']} == {'in-ws', 'other-ws'}

    # Requesting a workspace the dev isn't a member of -> 403.
    r = client.get('/api/v1/apps', headers={**_token(dev.id), 'X-Workspace-Id': str(ws.id)})
    assert r.status_code == 403

    # Once a member, the list is filtered to that workspace.
    WorkspaceService.add_member(ws.id, dev.id, 'member')
    r = client.get('/api/v1/apps', headers={**_token(dev.id), 'X-Workspace-Id': str(ws.id)})
    assert r.status_code == 200
    assert {a['name'] for a in r.get_json()['apps']} == {'in-ws'}


def test_workspace_context_never_broadens_access(app, client):
    """A member activating a workspace must NOT see another user's app that lives
    in the same workspace — scoping only narrows within the user's own rows."""
    from app import db
    from app.services.workspace_service import WorkspaceService
    from app.models import Application

    admin = _mk_user(db, 'esc_admin', 'admin')
    me = _mk_user(db, 'esc_me', 'developer')
    other = _mk_user(db, 'esc_other', 'developer')
    ws = WorkspaceService.create_workspace({'name': 'Shared'}, admin.id)
    WorkspaceService.add_member(ws.id, me.id, 'member')
    db.session.add_all([
        Application(name='mine', app_type='php', user_id=me.id, workspace_id=ws.id),
        Application(name='theirs', app_type='php', user_id=other.id, workspace_id=ws.id),
    ])
    db.session.commit()

    # `me` is a member of the shared workspace but must still only see its own app.
    r = client.get('/api/v1/apps', headers={**_token(me.id), 'X-Workspace-Id': str(ws.id)})
    assert r.status_code == 200
    assert {a['name'] for a in r.get_json()['apps']} == {'mine'}

    # An admin, by contrast, sees everything in the workspace.
    r = client.get('/api/v1/apps', headers={**_token(admin.id), 'X-Workspace-Id': str(ws.id)})
    assert {a['name'] for a in r.get_json()['apps']} == {'mine', 'theirs'}


def test_create_app_stamps_workspace(app, client):
    from app.services.workspace_service import WorkspaceService
    from app import db

    dev = _mk_user(db, 'cre_dev', 'developer')

    # No context -> stamped with the default workspace.
    r = client.post('/api/v1/apps', headers=_token(dev.id), json={'name': 'newapp', 'app_type': 'php'})
    assert r.status_code == 201
    assert r.get_json()['app']['workspace_id'] == WorkspaceService.ensure_default_workspace().id

    # With a workspace context (member) -> stamped with that workspace.
    admin = _mk_user(db, 'cre_admin', 'admin')
    ws = WorkspaceService.create_workspace({'name': 'CreWS'}, admin.id)
    WorkspaceService.add_member(ws.id, dev.id, 'member')
    r = client.post('/api/v1/apps', headers={**_token(dev.id), 'X-Workspace-Id': str(ws.id)},
                    json={'name': 'wsapp', 'app_type': 'php'})
    assert r.status_code == 201
    assert r.get_json()['app']['workspace_id'] == ws.id


# ---- migration backfill (raw SQL, run against real SQLite) ----------------

def test_migration_backfill_attaches_resources_and_members(app):
    import importlib.util
    import os
    from app import db
    from app.models import Application, Server
    from app.models.workspace import Workspace, WorkspaceMember

    u1 = _mk_user(db, 'bf_u1', 'admin')
    u2 = _mk_user(db, 'bf_u2', 'developer')
    db.session.add_all([
        Application(name='bf-app', app_type='php', user_id=u1.id),
        Server(name='bf-srv', registered_by=u1.id),
    ])
    db.session.commit()

    # Load the migration module by path (its name starts with a digit) and run
    # the backfill against the live connection — exercising the actual raw SQL.
    path = os.path.join(os.path.dirname(os.path.dirname(__file__)),
                        'migrations', 'versions', '015_workspace_scope.py')
    spec = importlib.util.spec_from_file_location('mig015', path)
    mig = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mig)

    mig._backfill(db.session.connection())
    db.session.commit()

    default = Workspace.query.filter_by(slug='default').first()
    assert default is not None
    assert Application.query.filter_by(name='bf-app').first().workspace_id == default.id
    assert Server.query.filter_by(name='bf-srv').first().workspace_id == default.id
    assert WorkspaceMember.query.filter_by(workspace_id=default.id, user_id=u1.id).first() is not None
    assert WorkspaceMember.query.filter_by(workspace_id=default.id, user_id=u2.id).first() is not None

    # Idempotent: a second run creates no duplicate members and doesn't error.
    mig._backfill(db.session.connection())
    db.session.commit()
    assert WorkspaceMember.query.filter_by(workspace_id=default.id, user_id=u1.id).count() == 1
    assert Workspace.query.filter_by(slug='default').count() == 1


# ---- API: servers ---------------------------------------------------------

def test_servers_list_global_without_context(app, client):
    from app import db
    from app.models import Server

    admin = _mk_user(db, 'srv_admin', 'admin')
    dev = _mk_user(db, 'srv_dev', 'developer')
    db.session.add(Server(name='srv-a', registered_by=admin.id))
    db.session.commit()

    # Servers are global today: a non-admin with no workspace context still sees them.
    r = client.get('/api/v1/servers', headers=_token(dev.id))
    assert r.status_code == 200
    assert any(s['name'] == 'srv-a' for s in r.get_json())
