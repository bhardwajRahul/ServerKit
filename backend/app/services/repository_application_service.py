"""Finalize repository imports with consistent compensation on setup failure.

The caller validates and authorizes the repository/workspace before constructing
the application. Deployment configuration requires its committed ID. Mandatory
configuration failure removes that half-created record and its managed source;
optional manifest enrichment or queue failure keeps the registered application.
"""

import logging
import os
import shutil

from app import db, paths
from app.models import Application
from app.services.git_service import GitService
from app.services.build_service import BuildService

logger = logging.getLogger(__name__)


def abort_repository_creation(app):
    """Compensate a failed import, never placing half-created rows in the bin."""
    db.session.rollback()
    if app.id:
        GitService.remove_deployment(app.id)
        existing = Application.query.get(app.id)
        if existing:
            db.session.delete(existing)
            db.session.commit()
    if os.path.abspath(app.root_path).startswith(os.path.abspath(paths.APPS_DIR) + os.sep):
        shutil.rmtree(app.root_path, ignore_errors=True)


def finalize_repository_application(app, *, user_id, repo_url, branch,
                                    auto_deploy, build_options, manifest):
    """Commit and configure an authorized app, returning presentation data.

    Compensation is exposed separately so an HTTP caller can also unwind a
    failure while building its response, retaining the existing route contract.
    Non-HTTP callers should use the same compensation if finalization raises.
    """
    db.session.add(app)
    db.session.commit()
    deploy_result = GitService.configure_deployment(
        app_id=app.id, app_path=app.root_path, repo_url=repo_url,
        branch=branch, auto_deploy=auto_deploy,
    )
    if not deploy_result.get('success'):
        raise RuntimeError(deploy_result.get('error', 'Failed to configure deployment'))
    build_result = BuildService.configure_build(
        app_id=app.id, app_path=app.root_path, **build_options,
    )
    if not build_result.get('success'):
        raise RuntimeError(build_result.get('error', 'Failed to configure build'))

    manifest_summary = None
    try:
        from app.services.manifest_persistence_service import ManifestPersistenceService
        manifest_summary = ManifestPersistenceService.apply_import(
            app, manifest, user_id=user_id, source_repo=repo_url, source_ref=branch,
        )
    except Exception:
        # Enrichment has always been best-effort; creation remains usable.
        pass

    deploy_job_id = None
    try:
        from app.services.deployment_job_service import DeploymentJobService
        result = DeploymentJobService.enqueue_app_deploy(app, user_id=user_id, trigger='install')
        if result.get('success'):
            deploy_job_id = result.get('job_id')
        else:
            logger.warning('app deploy enqueue failed for app %s: %s', app.id, result.get('error'))
    except Exception as exc:
        logger.warning('app deploy enqueue failed for app %s: %s', app.id, exc)

    return {
        'deploy_result': deploy_result, 'build_config': build_result.get('config'),
        'manifest_import': manifest_summary, 'deploy_job_id': deploy_job_id,
    }
