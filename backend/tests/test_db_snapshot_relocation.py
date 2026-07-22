"""DatabaseSnapshot + SyncJob relocation (plan 52 Phase 1).

The two models moved from ``app.models.wordpress_site`` to a neutral
``app.models.db_snapshot`` module. This locks the import-compatibility contract
so the ~6 existing ``from app.models.wordpress_site import DatabaseSnapshot``
callers (apps API, db_sync/environment services, jobs) keep working, and that the
move was pure — same classes, same tables.
"""
from app.models import db_snapshot, wordpress_site
from app.models.db_snapshot import DatabaseSnapshot, SyncJob


def test_models_live_in_db_snapshot_module():
    assert DatabaseSnapshot.__module__ == 'app.models.db_snapshot'
    assert SyncJob.__module__ == 'app.models.db_snapshot'


def test_wordpress_site_reexports_same_classes():
    # Back-compat: the old import path resolves to the exact same class objects.
    assert wordpress_site.DatabaseSnapshot is DatabaseSnapshot
    assert wordpress_site.SyncJob is SyncJob


def test_tables_unchanged():
    # Pure module move — table names must not have shifted.
    assert db_snapshot.DatabaseSnapshot.__tablename__ == 'database_snapshots'
    assert db_snapshot.SyncJob.__tablename__ == 'sync_jobs'
