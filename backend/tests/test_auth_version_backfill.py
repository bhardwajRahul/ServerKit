"""users.auth_version must never be NULL for an existing row.

Regression for the 1.9.27 dev upgrade on a live box: the startup schema sync
(`MigrationService._fix_missing_columns`) runs BEFORE alembic and added
`auth_version` as a bare nullable TEXT, so migration 097 saw the column and
skipped its `'0'` server_default. Every pre-existing user then carried a NULL
auth_version, no JWT claim could match it, and nobody could log in.
"""
import importlib.util
import os
from types import SimpleNamespace

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from app import db
from app.services.migration_service import MigrationService

_MIGRATION = os.path.join(os.path.dirname(os.path.dirname(__file__)),
                          'migrations', 'versions', '097_user_auth_version.py')


def _legacy_users_engine(tmp_path, *, with_auth_version):
    """A pre-097 users table holding one real row (plus alembic_version)."""
    engine = sa.create_engine(f'sqlite:///{tmp_path / "legacy.db"}')
    users = db.metadata.tables['users']
    legacy = sa.MetaData()
    columns = [c.copy() for c in users.columns
               if c.name != 'auth_version' or with_auth_version]
    sa.Table('users', legacy, *columns)
    legacy.create_all(engine)
    with engine.begin() as conn:
        conn.execute(sa.text(
            "INSERT INTO users (id, username, email, password_hash, role, is_active) "
            "VALUES (1, 'legacy', 'legacy@example.com', 'x', 'admin', 1)"))
    return engine


def test_startup_schema_sync_backfills_server_default(tmp_path, app):
    engine = _legacy_users_engine(tmp_path, with_auth_version=False)
    fake_db = SimpleNamespace(engine=engine, metadata=db.metadata, create_all=lambda: None)

    MigrationService._fix_missing_columns(fake_db)

    with engine.connect() as conn:
        assert conn.execute(sa.text('SELECT auth_version FROM users')).scalar() == '0'
        ddl = conn.execute(sa.text(
            "SELECT sql FROM sqlite_master WHERE name = 'users'")).scalar()
    assert "auth_version TEXT DEFAULT '0'" in ddl


def test_migration_097_backfills_a_pre_added_null_column(tmp_path, app):
    engine = _legacy_users_engine(tmp_path, with_auth_version=False)
    with engine.begin() as conn:
        # Exactly what the pre-fix schema sync produced on the live box.
        conn.execute(sa.text('ALTER TABLE users ADD COLUMN auth_version TEXT'))
        assert conn.execute(sa.text('SELECT auth_version FROM users')).scalar() is None

    spec = importlib.util.spec_from_file_location('migration_097', _MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    with engine.begin() as conn:
        ctx = MigrationContext.configure(conn)
        with Operations.context(ctx):
            module.upgrade()

    with engine.connect() as conn:
        assert conn.execute(sa.text('SELECT auth_version FROM users')).scalar() == '0'
        assert sa.inspect(conn).has_table('revoked_sessions')


def test_sqlite_default_rendering():
    def col(default):
        return sa.Column('c', sa.String(), server_default=default)

    assert MigrationService._sqlite_default(col('0')) == "'0'"
    assert MigrationService._sqlite_default(col("it's")) == "'it''s'"
    assert MigrationService._sqlite_default(col(sa.true())) is None
    assert MigrationService._sqlite_default(col(sa.text('now()'))) is None
    assert MigrationService._sqlite_default(sa.Column('c', sa.String())) is None
