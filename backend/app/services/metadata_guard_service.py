"""Cloud metadata egress guard.

Blocks app containers from reaching the cloud metadata endpoint
(169.254.169.254) via the Docker forward path, protecting against
SSRF-to-instance-credentials attacks. Default-on (opt-out via the
``security_block_cloud_metadata`` setting), Linux-only, best-effort:
on unsupported hosts everything degrades gracefully to a no-op.
"""

import logging
import os

from ..utils.system import is_command_available, run_privileged

logger = logging.getLogger(__name__)

METADATA_CIDR = '169.254.169.254/32'
SETTING_KEY = 'security_block_cloud_metadata'
JOB_KIND = 'security.metadata_guard.ensure'

# nftables fallback objects (used only when iptables is absent)
NFT_TABLE = 'serverkit_metadata_guard'

_IPT_RULE = ['DOCKER-USER', '-d', METADATA_CIDR, '-j', 'DROP']


class MetadataGuardService:
    """Manage the DROP rule for the cloud metadata IP in DOCKER-USER."""

    # ------------------------------------------------------------------ #
    # Backend detection
    # ------------------------------------------------------------------ #

    @staticmethod
    def _detect_backend():
        """Return 'iptables', 'nftables', or None."""
        if os.name == 'nt':
            return None
        if is_command_available('iptables'):
            return 'iptables'
        if is_command_available('nft'):
            return 'nftables'
        return None

    # ------------------------------------------------------------------ #
    # Setting
    # ------------------------------------------------------------------ #

    @staticmethod
    def enabled_setting():
        """Read the opt-out setting (defaults to on)."""
        from .settings_service import SettingsService
        value = SettingsService.get(SETTING_KEY, True)
        if isinstance(value, str):
            return value.strip().lower() not in ('false', '0', 'no', 'off', '')
        return bool(value)

    # ------------------------------------------------------------------ #
    # Rule presence
    # ------------------------------------------------------------------ #

    @classmethod
    def _is_active(cls, backend):
        if backend == 'iptables':
            result = run_privileged(['iptables', '-C'] + _IPT_RULE)
            return result.returncode == 0
        if backend == 'nftables':
            result = run_privileged(['nft', 'list', 'table', 'inet', NFT_TABLE])
            return result.returncode == 0
        return False

    # ------------------------------------------------------------------ #
    # Core ops
    # ------------------------------------------------------------------ #

    @classmethod
    def status(cls):
        """Report support, setting, and live rule state."""
        backend = cls._detect_backend()
        info = {
            'supported': backend is not None,
            'enabled_setting': cls.enabled_setting(),
            'active': False,
            'backend': backend,
        }
        if backend is None:
            return info
        try:
            info['active'] = cls._is_active(backend)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning('metadata guard status check failed: %s', exc)
            info['error'] = str(exc)
        return info

    @classmethod
    def apply(cls):
        """Idempotently insert the metadata DROP rule."""
        backend = cls._detect_backend()
        if backend is None:
            return {'success': False, 'supported': False,
                    'error': 'No supported firewall backend (iptables/nft) on this host'}
        try:
            if cls._is_active(backend):
                return {'success': True, 'active': True, 'backend': backend}
            if backend == 'iptables':
                result = run_privileged(['iptables', '-I'] + _IPT_RULE)
                if result.returncode != 0:
                    return {'success': False, 'backend': backend,
                            'error': (result.stderr or 'iptables insert failed').strip()}
            else:
                # Best-effort nftables equivalent: dedicated table + forward
                # hook chain dropping traffic to the metadata IP.
                steps = [
                    ['nft', 'add', 'table', 'inet', NFT_TABLE],
                    ['nft', 'add', 'chain', 'inet', NFT_TABLE, 'forward',
                     '{', 'type', 'filter', 'hook', 'forward', 'priority', '-10', ';',
                     'policy', 'accept', ';', '}'],
                    ['nft', 'add', 'rule', 'inet', NFT_TABLE, 'forward',
                     'ip', 'daddr', '169.254.169.254', 'drop'],
                ]
                for cmd in steps:
                    result = run_privileged(cmd)
                    if result.returncode != 0:
                        return {'success': False, 'backend': backend,
                                'error': (result.stderr or 'nft setup failed').strip()}
            return {'success': True, 'active': True, 'backend': backend}
        except Exception as exc:
            logger.warning('metadata guard apply failed: %s', exc)
            return {'success': False, 'backend': backend, 'error': str(exc)}

    @classmethod
    def remove(cls):
        """Delete the metadata DROP rule if present."""
        backend = cls._detect_backend()
        if backend is None:
            return {'success': False, 'supported': False,
                    'error': 'No supported firewall backend (iptables/nft) on this host'}
        try:
            if not cls._is_active(backend):
                return {'success': True, 'active': False, 'backend': backend}
            if backend == 'iptables':
                result = run_privileged(['iptables', '-D'] + _IPT_RULE)
            else:
                result = run_privileged(['nft', 'delete', 'table', 'inet', NFT_TABLE])
            if result.returncode != 0:
                return {'success': False, 'backend': backend,
                        'error': (result.stderr or 'rule removal failed').strip()}
            return {'success': True, 'active': False, 'backend': backend}
        except Exception as exc:
            logger.warning('metadata guard remove failed: %s', exc)
            return {'success': False, 'backend': backend, 'error': str(exc)}

    @classmethod
    def ensure(cls):
        """Converge the live rule with the setting (apply or remove)."""
        if os.name == 'nt' or cls._detect_backend() is None:
            return {'success': True, 'supported': False, 'active': False,
                    'backend': None}
        if cls.enabled_setting():
            return cls.apply()
        return cls.remove()

    # ------------------------------------------------------------------ #
    # Jobs registration
    # ------------------------------------------------------------------ #

    @classmethod
    def register_jobs(cls):
        """Register the ensure handler so boot/schedules converge the rule."""
        from app.jobs import registry
        registry.register(JOB_KIND, cls._run_ensure_job, replace=True)

    @classmethod
    def _run_ensure_job(cls, job):  # noqa: ARG003 - job payload unused
        result = cls.ensure()
        if not result.get('success') and result.get('supported', True):
            raise RuntimeError(result.get('error') or 'metadata guard ensure failed')
        return result
