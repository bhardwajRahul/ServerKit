"""Cloudflare zone operations beyond DNS records.

ServerKit already connects Cloudflare as a DNS provider (``DNSProviderConfig`` +
the shared :class:`~app.services.dns.cloudflare.CloudflareClient`). This service
builds the *operations* surface on top of that same connection — starting with
zone settings (SSL/TLS, Speed, Caching, Security) and a one-click hardening
preset — so auth, encryption-at-rest, and credential resolution are reused, not
re-implemented.

A zone is addressed by its ServerKit ``DNSZone`` id (the same integer the rest of
the ``/dns`` API uses); credential + Cloudflare zone id are resolved server-side
via :meth:`DNSZoneService._resolve_credential`, the canonical resolver.
"""
import logging

logger = logging.getLogger(__name__)


class CloudflareError(Exception):
    """A caller-facing problem resolving a zone (not found, not Cloudflare, no
    connected credential). Mapped to a 400 by the API layer."""


class CloudflareService:
    """Zone settings + hardening on a connected Cloudflare zone."""

    # Curated subset of Cloudflare zone settings ServerKit surfaces, grouped for
    # the UI. Each setting: ``id`` (Cloudflare setting id), ``label``, ``type``
    # (toggle | select | hsts) and, for selects, ``options`` ({value, label}).
    # The page renders straight from this metadata; current values + the
    # ``editable`` (plan-gating) flag come from the live settings response.
    SETTING_GROUPS = [
        {
            'key': 'ssl',
            'label': 'SSL/TLS',
            'settings': [
                {'id': 'ssl', 'label': 'SSL/TLS encryption mode', 'type': 'select',
                 'help': 'How Cloudflare connects to your origin. "Full (strict)" '
                         'is the most secure and requires a valid origin certificate.',
                 'options': [
                     {'value': 'off', 'label': 'Off (not secure)'},
                     {'value': 'flexible', 'label': 'Flexible'},
                     {'value': 'full', 'label': 'Full'},
                     {'value': 'strict', 'label': 'Full (strict)'},
                 ]},
                {'id': 'always_use_https', 'label': 'Always use HTTPS', 'type': 'toggle',
                 'help': 'Redirect every HTTP request to HTTPS.'},
                {'id': 'automatic_https_rewrites', 'label': 'Automatic HTTPS rewrites',
                 'type': 'toggle',
                 'help': 'Rewrite insecure http:// links to https:// to avoid mixed content.'},
                {'id': 'min_tls_version', 'label': 'Minimum TLS version', 'type': 'select',
                 'options': [
                     {'value': '1.0', 'label': 'TLS 1.0'},
                     {'value': '1.1', 'label': 'TLS 1.1'},
                     {'value': '1.2', 'label': 'TLS 1.2 (recommended)'},
                     {'value': '1.3', 'label': 'TLS 1.3'},
                 ]},
                {'id': 'tls_1_3', 'label': 'TLS 1.3', 'type': 'toggle',
                 'help': 'Enable the latest, fastest TLS version.'},
                {'id': 'security_header', 'label': 'HTTP Strict Transport Security (HSTS)',
                 'type': 'hsts',
                 'help': 'Tell browsers to only ever connect over HTTPS. Enable only once '
                         'HTTPS works everywhere — it is hard to undo before max-age expires.'},
            ],
        },
        {
            'key': 'speed',
            'label': 'Speed',
            'settings': [
                {'id': 'brotli', 'label': 'Brotli compression', 'type': 'toggle',
                 'help': 'Compress responses with Brotli for supporting browsers.'},
                {'id': 'early_hints', 'label': 'Early Hints', 'type': 'toggle',
                 'help': 'Send 103 Early Hints so browsers can preload assets sooner.'},
                {'id': 'http3', 'label': 'HTTP/3 (with QUIC)', 'type': 'toggle'},
            ],
        },
        {
            'key': 'caching',
            'label': 'Caching',
            'settings': [
                {'id': 'cache_level', 'label': 'Caching level', 'type': 'select',
                 'options': [
                     {'value': 'bypass', 'label': 'Bypass'},
                     {'value': 'basic', 'label': 'Basic'},
                     {'value': 'simplified', 'label': 'Simplified'},
                     {'value': 'aggressive', 'label': 'Aggressive (recommended)'},
                     {'value': 'cache_everything', 'label': 'Cache everything'},
                 ]},
                {'id': 'browser_cache_ttl', 'label': 'Browser cache TTL', 'type': 'select',
                 'options': [
                     {'value': 0, 'label': 'Respect existing headers'},
                     {'value': 1800, 'label': '30 minutes'},
                     {'value': 3600, 'label': '1 hour'},
                     {'value': 14400, 'label': '4 hours'},
                     {'value': 28800, 'label': '8 hours'},
                     {'value': 86400, 'label': '1 day'},
                     {'value': 604800, 'label': '1 week'},
                 ]},
                {'id': 'development_mode', 'label': 'Development mode', 'type': 'toggle',
                 'help': 'Temporarily bypass the cache while you work. Auto-expires after 3 hours.'},
                {'id': 'always_online', 'label': 'Always Online', 'type': 'toggle',
                 'help': 'Serve a cached copy of your site if your origin is unreachable.'},
            ],
        },
        {
            'key': 'security',
            'label': 'Security',
            'settings': [
                {'id': 'security_level', 'label': 'Security level', 'type': 'select',
                 'options': [
                     {'value': 'off', 'label': 'Off'},
                     {'value': 'essentially_off', 'label': 'Essentially off'},
                     {'value': 'low', 'label': 'Low'},
                     {'value': 'medium', 'label': 'Medium'},
                     {'value': 'high', 'label': 'High'},
                     {'value': 'under_attack', 'label': "I'm under attack"},
                 ]},
                {'id': 'browser_check', 'label': 'Browser integrity check', 'type': 'toggle',
                 'help': 'Block requests from common malicious bots and crawlers.'},
                {'id': 'challenge_ttl', 'label': 'Challenge passage', 'type': 'select',
                 'help': 'How long a visitor stays verified after passing a challenge.',
                 'options': [
                     {'value': 300, 'label': '5 minutes'},
                     {'value': 900, 'label': '15 minutes'},
                     {'value': 1800, 'label': '30 minutes'},
                     {'value': 3600, 'label': '1 hour'},
                     {'value': 7200, 'label': '2 hours'},
                     {'value': 10800, 'label': '3 hours'},
                     {'value': 14400, 'label': '4 hours'},
                     {'value': 28800, 'label': '8 hours'},
                     {'value': 86400, 'label': '1 day'},
                 ]},
            ],
        },
    ]

    # One-click hardening (plan §Phase 1 Actions): Full (strict), Always HTTPS,
    # HSTS (6 months), TLS 1.2 floor + 1.3, Brotli, HTTP/3, 4h browser cache.
    RECOMMENDED_PRESET = [
        ('ssl', 'strict'),
        ('always_use_https', 'on'),
        ('automatic_https_rewrites', 'on'),
        ('min_tls_version', '1.2'),
        ('tls_1_3', 'on'),
        ('brotli', 'on'),
        ('http3', 'on'),
        ('browser_cache_ttl', 14400),
        ('security_header', {'strict_transport_security': {
            'enabled': True, 'max_age': 15552000,
            'include_subdomains': True, 'preload': False, 'nosniff': True}}),
    ]

    @staticmethod
    def _zone_and_client(zone_id):
        """Resolve ``(zone, CloudflareClient)`` for a ServerKit DNS zone id, or raise
        :class:`CloudflareError` with a user-facing reason. Credential resolution
        reuses the canonical resolver so the connection store is the single source
        of truth."""
        from app.services.dns_zone_service import DNSZoneService
        from app.services.dns import CloudflareClient

        zone = DNSZoneService.get_zone(zone_id)
        if not zone:
            raise CloudflareError('Zone not found')
        if (zone.provider or '').lower() != 'cloudflare':
            raise CloudflareError('This zone is not managed by Cloudflare')
        credential = DNSZoneService._resolve_credential(zone)
        if not credential:
            raise CloudflareError('No connected Cloudflare credential resolves for this zone')
        if not zone.provider_zone_id:
            raise CloudflareError("Cloudflare hasn't been matched to this domain yet — "
                                  'open the DNS zone once to link it, then retry')
        return zone, CloudflareClient(credential)

    @staticmethod
    def _zone_dict(zone):
        return {'id': zone.id, 'domain': zone.domain,
                'provider_zone_id': zone.provider_zone_id}

    @classmethod
    def get_settings(cls, zone_id):
        """Live zone settings, indexed by id, plus the UI grouping metadata."""
        zone, client = cls._zone_and_client(zone_id)
        res = client.get_zone_settings(zone.provider_zone_id)
        if not res.get('success'):
            return {'success': False, 'error': res.get('error', 'Failed to load zone settings')}
        by_id = {s.get('id'): s for s in (res.get('result') or []) if isinstance(s, dict)}
        return {'success': True, 'zone': cls._zone_dict(zone),
                'groups': cls.SETTING_GROUPS, 'settings': by_id}

    @classmethod
    def get_setting(cls, zone_id, setting_id):
        zone, client = cls._zone_and_client(zone_id)
        res = client.get_zone_setting(zone.provider_zone_id, setting_id)
        if not res.get('success'):
            return {'success': False, 'error': res.get('error', 'Failed to load setting')}
        return {'success': True, 'setting': res.get('result')}

    @classmethod
    def update_setting(cls, zone_id, setting_id, value):
        zone, client = cls._zone_and_client(zone_id)
        res = client.update_zone_setting(zone.provider_zone_id, setting_id, value)
        if not res.get('success'):
            return {'success': False, 'error': res.get('error', 'Update failed')}
        return {'success': True, 'setting': res.get('result')}

    @classmethod
    def apply_recommended(cls, zone_id):
        """Apply the recommended hardening preset, returning a per-setting report so
        the UI can show which toggles the plan allowed and which it gated."""
        zone, client = cls._zone_and_client(zone_id)
        results = []
        for setting_id, value in cls.RECOMMENDED_PRESET:
            res = client.update_zone_setting(zone.provider_zone_id, setting_id, value)
            results.append({'setting': setting_id,
                            'success': bool(res.get('success')),
                            'error': None if res.get('success') else res.get('error')})
        applied = sum(1 for r in results if r['success'])
        return {'success': applied > 0, 'applied': applied,
                'total': len(results), 'results': results}
