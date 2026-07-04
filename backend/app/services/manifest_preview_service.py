"""Manifest-powered previews (plan 17, Phase 5, #20).

A PR preview for a manifest-managed app is an apply with a namespace prefix and
a TTL: it clones the manifest-resolved config (env + the existing
pr-{pr}.{app_domain} domain) with per-preview overrides. This service produces
that resolved config; the preview provisioner consumes it. Real container
spin-up for generic apps stays best-effort (Docker-dependent) — the resolved
config is the portable unit this adds on top of the WordPress-only path.
"""

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


class ManifestPreviewService:

    @classmethod
    def build_preview_config(cls, app, preview) -> Optional[Dict[str, Any]]:
        """Resolved config for a manifest-managed app's preview, or None."""
        from app.services.manifest_apply_service import ManifestApplyService

        resolved = ManifestApplyService.resolved_for_app(app)
        if not resolved:
            return None

        # base env = the app's effective env (manifest literals + resolved refs)
        from app.services.env_service import EnvService
        try:
            env = dict(EnvService.get_effective_env(app.id))
        except Exception:
            env = {}

        # per-preview overrides
        env['SERVERKIT_PREVIEW'] = 'true'
        env['SERVERKIT_PR_NUMBER'] = str(getattr(preview, 'pr_number', '') or '')
        if getattr(preview, 'branch', None):
            env['SERVERKIT_PREVIEW_BRANCH'] = preview.branch

        return {
            'env': env,
            'domain': getattr(preview, 'domain', None),
            'port': resolved.get('port'),
            'target_server_id': cls._preview_server_id(app, resolved),
            'service': resolved.get('name'),
        }

    @staticmethod
    def _preview_server_id(app, resolved) -> Optional[str]:
        """Where the preview should run: preview settings win, then manifest server,
        then the app's own server. (ApplicationPreviewSettings.target_server_id was
        plumbed but unused — this makes it live.)"""
        try:
            from app.models.application_preview import ApplicationPreviewSettings
            settings = ApplicationPreviewSettings.query.filter_by(
                application_id=app.id).first()
            if settings and settings.target_server_id:
                return settings.target_server_id
        except Exception:
            pass
        server_ref = resolved.get('server')
        if server_ref:
            from app.services.manifest_apply_service import ManifestApplyService
            resolved_id = ManifestApplyService._resolve_server_id(server_ref)
            if resolved_id:
                return resolved_id
        return getattr(app, 'server_id', None)
