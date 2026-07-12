"""Install / uninstall lifecycle hooks (serverkit-k8s extension).

Contract (per the plugin SDK): a single positional arg -- the InstalledPlugin
row. ``on_uninstall`` also accepts a ``purge`` flag. Everything here is wrapped
so a hook failure never blocks install/uninstall.

There is no engine to provision: the extension only talks to *remote* clusters
through kubectl, so install just registers a notification event and uninstall is
a no-op (the ``ext_serverkit_k8s_*`` table is dropped by the platform on
``--purge``).
"""
import logging

logger = logging.getLogger(__name__)


def on_install(plugin):
    """Register the extension's notification events. Best-effort."""
    try:
        from app.plugins_sdk import notify
        notify.register_event(
            'k8s.cluster_unreachable',
            'A Kubernetes cluster became unreachable',
            template='generic', severity='warning', category='system')
        logger.info('serverkit-k8s installed: notification events registered')
    except Exception as e:  # noqa: BLE001
        logger.warning('serverkit-k8s on_install hook error: %s', e)


def on_uninstall(plugin, purge=False):
    """Nothing to tear down -- clusters are remote and hold no local resources."""
    logger.info('serverkit-k8s on_uninstall (purge=%s): no local resources to remove', purge)
