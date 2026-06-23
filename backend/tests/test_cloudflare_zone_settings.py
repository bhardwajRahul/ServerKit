"""Proving tests for Cloudflare zone settings (Phase 1 of the Cloudflare ops roadmap).

Covers the generic v4 ``request`` helper on the shared client (envelope
normalization), the zone-settings methods, and ``CloudflareService`` orchestration
— credential/zone resolution guards, settings indexing, and the recommended
hardening preset's per-setting reporting.

Cloudflare HTTP is stubbed by monkeypatching ``requests.request`` on the client's
imported ``requests`` module (the generic helper uses ``requests.request``).
"""
import pytest


class _Resp:
    def __init__(self, js, status=200):
        self._js = js
        self.status_code = status

    def json(self):
        return self._js


def _client(token='tok'):
    from app.services.dns import cloudflare as cf
    from app.services.dns.base import DnsCredential
    return cf.CloudflareClient(DnsCredential(provider='cloudflare', token=token))


# ── generic request() envelope normalization ─────────────────────────────────

def test_request_passes_success_through(monkeypatch):
    from app.services.dns import cloudflare as cf
    monkeypatch.setattr(cf.requests, 'request',
                        lambda *a, **k: _Resp({'success': True,
                                               'result': [{'id': 'ssl', 'value': 'full'}]}))
    res = _client().get_zone_settings('zoneA')
    assert res['success'] is True and res['result'][0]['id'] == 'ssl'


def test_request_extracts_first_error(monkeypatch):
    from app.services.dns import cloudflare as cf
    monkeypatch.setattr(cf.requests, 'request',
                        lambda *a, **k: _Resp({'success': False,
                                               'errors': [{'message': 'Invalid zone'}]}))
    res = _client().get_zone_setting('zoneA', 'ssl')
    assert res['success'] is False and res['error'] == 'Invalid zone'


def test_request_handles_transport_error(monkeypatch):
    from app.services.dns import cloudflare as cf

    def boom(*a, **k):
        raise RuntimeError('network down')
    monkeypatch.setattr(cf.requests, 'request', boom)
    res = _client().get_zone_settings('zoneA')
    assert res['success'] is False and 'network down' in res['error']


def test_request_handles_non_json(monkeypatch):
    from app.services.dns import cloudflare as cf

    class _Bad(_Resp):
        def json(self):
            raise ValueError('no json')
    monkeypatch.setattr(cf.requests, 'request', lambda *a, **k: _Bad({}, status=502))
    res = _client().get_zone_settings('zoneA')
    assert res['success'] is False and '502' in res['error']


def test_update_zone_setting_patches_value(monkeypatch):
    from app.services.dns import cloudflare as cf
    seen = {}

    def capture(method, url, headers=None, json=None, params=None, timeout=None):
        seen.update(method=method, url=url, json=json)
        return _Resp({'success': True, 'result': {'id': 'ssl', 'value': 'strict'}})
    monkeypatch.setattr(cf.requests, 'request', capture)
    res = _client().update_zone_setting('zoneA', 'ssl', 'strict')
    assert res['success'] is True
    assert seen['method'] == 'PATCH'
    assert seen['url'].endswith('/zones/zoneA/settings/ssl')
    assert seen['json'] == {'value': 'strict'}


# ── service: zone resolution guards ──────────────────────────────────────────

def _make_cf_zone(domain='example.com', provider='cloudflare', zid='zoneABC', token='tok'):
    from app import db
    from app.models.dns_zone import DNSZone
    zone = DNSZone(domain=domain, provider=provider, provider_zone_id=zid)
    if token:
        zone.provider_config = {'api_token': token}
    db.session.add(zone)
    db.session.commit()
    return zone


def test_service_rejects_non_cloudflare_zone(app):
    from app.services.cloudflare_service import CloudflareService, CloudflareError
    zone = _make_cf_zone(provider='manual', token=None)
    with pytest.raises(CloudflareError):
        CloudflareService.get_settings(zone.id)


def test_service_rejects_missing_zone(app):
    from app.services.cloudflare_service import CloudflareService, CloudflareError
    with pytest.raises(CloudflareError):
        CloudflareService.get_settings(99999)


def test_service_rejects_zone_without_provider_zone_id(app):
    from app.services.cloudflare_service import CloudflareService, CloudflareError
    zone = _make_cf_zone(zid=None)
    with pytest.raises(CloudflareError):
        CloudflareService.get_settings(zone.id)


# ── service: settings + preset ───────────────────────────────────────────────

def test_service_get_settings_indexes_by_id(app, monkeypatch):
    from app.services.dns import cloudflare as cf
    from app.services.cloudflare_service import CloudflareService
    zone = _make_cf_zone()
    monkeypatch.setattr(cf.requests, 'request',
                        lambda *a, **k: _Resp({'success': True, 'result': [
                            {'id': 'ssl', 'value': 'full', 'editable': True},
                            {'id': 'brotli', 'value': 'on', 'editable': True}]}))
    res = CloudflareService.get_settings(zone.id)
    assert res['success'] is True
    assert res['settings']['ssl']['value'] == 'full'
    assert res['zone']['domain'] == 'example.com'
    assert any(g['key'] == 'ssl' for g in res['groups'])


def test_service_update_setting_surfaces_provider_error(app, monkeypatch):
    from app.services.dns import cloudflare as cf
    from app.services.cloudflare_service import CloudflareService
    zone = _make_cf_zone()
    monkeypatch.setattr(cf.requests, 'request',
                        lambda *a, **k: _Resp({'success': False,
                                               'errors': [{'message': 'not editable on plan'}]}))
    res = CloudflareService.update_setting(zone.id, 'http3', 'on')
    assert res['success'] is False and 'not editable' in res['error']


def test_service_apply_preset_reports_each(app, monkeypatch):
    from app.services.dns import cloudflare as cf
    from app.services.cloudflare_service import CloudflareService
    zone = _make_cf_zone()

    def capture(method, url, headers=None, json=None, params=None, timeout=None):
        ok = not url.endswith('/http3')   # fail one to prove partial reporting
        return _Resp({'success': ok,
                      'errors': [] if ok else [{'message': 'not on plan'}],
                      'result': {}})
    monkeypatch.setattr(cf.requests, 'request', capture)
    res = CloudflareService.apply_recommended(zone.id)
    assert res['total'] == len(CloudflareService.RECOMMENDED_PRESET)
    assert res['applied'] == res['total'] - 1
    assert any(r['setting'] == 'http3' and not r['success'] for r in res['results'])
