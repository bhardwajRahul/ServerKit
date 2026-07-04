"""serverkit-mail extension tests — preflight, activation gate, DKIM/DNS, jail.

Loads the builtin backend exactly like production
(``plugin_service._ensure_builtin_backend_importable`` -> dashed package
``app.plugins.serverkit-mail``) and imports the models module at test-module top
level so its tables register before the ``app`` fixture's ``db.create_all()``.

Proves the safety-critical behaviors:

* PreflightService: all-pass -> ``passed`` + a persisted row; an RBL hit or a
  blocked port 25 -> ``passed=False`` with the failing check surfaced;
  Windows/dev -> skipped and never raises; ``latest()`` returns the newest row.
* The activation gate: ``MailService.set_domain_active(id, True)`` is REFUSED
  without a passing preflight and ALLOWED with ``force=True`` (audit path).
* DkimDnsService: DKIM keygen -> a ``v=DKIM1; k=rsa; p=...`` TXT value + stored
  keys; the pure ``build_records`` shapes; ``deploy_dns`` calls
  ``DNSProviderService.set_record`` with the exact record types/names/values and
  ``source='mail'``, and the no-provider path returns manual instructions.
* MailJailService: unavailable on Windows; enable writes a ``serverkit-mail-*``
  jail via a stubbed ``run_privileged(['tee', ...])`` and never raises.
"""
import importlib
import json
import os
from types import SimpleNamespace

import pytest

from app.services import plugin_service

SLUG = 'serverkit-mail'
EXT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    'builtin-extensions', SLUG,
)


def _load_ext():
    assert plugin_service._ensure_builtin_backend_importable(SLUG), (
        f'builtin extension backend not importable from {EXT_DIR}')
    models = importlib.import_module(f'app.plugins.{SLUG}.models')
    preflight = importlib.import_module(f'app.plugins.{SLUG}.preflight_service')
    dns = importlib.import_module(f'app.plugins.{SLUG}.dns_mail_service')
    mailsvc = importlib.import_module(f'app.plugins.{SLUG}.mail_service')
    jail = importlib.import_module(f'app.plugins.{SLUG}.mail_jail_service')
    return models, preflight, dns, mailsvc, jail


models_mod, preflight_mod, dns_mod, mailsvc_mod, jail_mod = _load_ext()
PreflightService = preflight_mod.PreflightService
DkimDnsService = dns_mod.DkimDnsService
MailService = mailsvc_mod.MailService
MailJailService = jail_mod.MailJailService
MailDomain = models_mod.MailDomain
PreflightResult = models_mod.PreflightResult


def _proc(returncode=0, stdout='', stderr=''):
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


def _patch_checks(monkeypatch, *, ptr=(True, 'mail.example.com', None),
                  port25=(True, None), rbl=(True, [], None), ports=(True, None)):
    """Stub every individual preflight helper so run() is hermetic."""
    monkeypatch.setattr(PreflightService, '_check_ptr',
                        staticmethod(lambda hostname, server_ip: ptr))
    monkeypatch.setattr(PreflightService, '_check_port25',
                        staticmethod(lambda: port25))
    monkeypatch.setattr(PreflightService, '_check_rbl',
                        classmethod(lambda cls, server_ip: rbl))
    monkeypatch.setattr(PreflightService, '_check_local_ports',
                        staticmethod(lambda: ports))
    # Keep the verdict OS-independent even though the machine may be Windows.
    monkeypatch.setattr(preflight_mod.os, 'name', 'posix')


# ---------------------------------------------------------------------------
# preflight
# ---------------------------------------------------------------------------

def test_preflight_all_pass_persists_row(app, monkeypatch):
    _patch_checks(monkeypatch)
    result = PreflightService.run('mail.example.com', server_ip='203.0.113.5')
    assert result['passed'] is True
    assert result['ptr_ok'] is True
    assert result['port25_ok'] is True
    assert result['rbl_ok'] is True
    # A row was persisted and is the latest.
    assert PreflightResult.query.count() == 1
    latest = PreflightService.latest()
    assert latest['passed'] is True
    assert latest['hostname'] == 'mail.example.com'


def test_preflight_rbl_hit_fails(app, monkeypatch):
    _patch_checks(monkeypatch, rbl=(False, ['zen.spamhaus.org'], 'Listed on: zen.spamhaus.org'))
    result = PreflightService.run('mail.example.com', server_ip='203.0.113.5')
    assert result['passed'] is False
    assert result['rbl_ok'] is False
    assert 'zen.spamhaus.org' in result['rbl_hits']
    assert result['detail']['rbl']['hits'] == ['zen.spamhaus.org']


def test_preflight_blocked_port25_fails(app, monkeypatch):
    _patch_checks(monkeypatch, port25=(False, 'provider blocks port 25'))
    result = PreflightService.run('mail.example.com', server_ip='203.0.113.5')
    assert result['passed'] is False
    assert result['port25_ok'] is False
    assert result['detail']['port25']['ok'] is False


def test_preflight_windows_skips_and_never_raises(app, monkeypatch):
    # Do NOT stub the checks; force the real OS gate to skip host-dependent work.
    monkeypatch.setattr(preflight_mod.os, 'name', 'nt')
    result = PreflightService.run('mail.example.com', server_ip='203.0.113.5')
    assert result['passed'] is False  # skipped checks never green-light sending
    assert 'dev_note' in result['detail']


def test_preflight_latest_returns_newest(app, monkeypatch):
    from app import db
    from datetime import datetime, timedelta
    old = PreflightResult(hostname='old.example.com', passed=False,
                          checked_at=datetime.utcnow() - timedelta(hours=2))
    new = PreflightResult(hostname='new.example.com', passed=True,
                          checked_at=datetime.utcnow())
    db.session.add_all([old, new])
    db.session.commit()
    latest = PreflightService.latest()
    assert latest['hostname'] == 'new.example.com'


def test_preflight_latest_none_when_empty(app):
    assert PreflightService.latest() is None


# ---------------------------------------------------------------------------
# activation gate (the key safety property)
# ---------------------------------------------------------------------------

def _make_domain(active=False):
    from app import db
    row = MailDomain(name='gate.example.com', is_active=active, sync_state='pending')
    db.session.add(row)
    db.session.commit()
    return row


def test_activation_refused_without_passing_preflight(app):
    row = _make_domain()
    result = MailService.set_domain_active(row.id, True)
    assert result['success'] is False
    assert result['code'] == 'preflight_required'
    # The domain stays inactive.
    from app import db
    db.session.refresh(row)
    assert row.is_active is False


def test_activation_allowed_with_force_and_audits(app, monkeypatch):
    row = _make_domain()
    audits = []
    monkeypatch.setattr(
        MailService, '_audit',
        staticmethod(lambda action, target_id, details: audits.append(
            (action, target_id, details))))
    result = MailService.set_domain_active(row.id, True, force=True)
    assert result['success'] is True
    from app import db
    db.session.refresh(row)
    assert row.is_active is True
    # The force override was recorded on the audit ledger.
    assert audits and audits[0][0] == 'mail.domain.activate_forced'
    assert audits[0][1] == row.id


def test_activation_allowed_with_passing_preflight(app):
    from app import db
    db.session.add(PreflightResult(hostname='gate.example.com', passed=True))
    db.session.commit()
    row = _make_domain()
    result = MailService.set_domain_active(row.id, True)  # no force needed
    assert result['success'] is True
    db.session.refresh(row)
    assert row.is_active is True


def test_deactivation_is_never_gated(app):
    row = _make_domain(active=True)
    result = MailService.set_domain_active(row.id, False)
    assert result['success'] is True
    from app import db
    db.session.refresh(row)
    assert row.is_active is False


# ---------------------------------------------------------------------------
# DKIM keygen + record builder
# ---------------------------------------------------------------------------

def test_generate_dkim_stores_keys_and_txt_value(app):
    from app import db
    row = MailDomain(name='dkim.example.com')
    db.session.add(row)
    db.session.commit()

    result = DkimDnsService.generate_dkim(row)
    assert result['success'] is True, result
    assert result['selector'] == 'serverkit'
    assert result['dkim_value'].startswith('v=DKIM1; k=rsa; p=')

    db.session.refresh(row)
    assert row.dkim_private_key and 'PRIVATE KEY' in row.dkim_private_key
    assert row.dkim_public_key
    # The stored public key round-trips into the same TXT value.
    assert result['dkim_value'].endswith(row.dkim_public_key)


def test_build_records_shapes():
    domain = MailDomain(name='Example.COM', dkim_selector='serverkit',
                        dkim_public_key='PUBKEYB64')
    records = DkimDnsService.build_records(domain, server_ip='203.0.113.5')
    by_type = {}
    for r in records:
        by_type.setdefault(r['type'], []).append(r)

    mx = by_type['MX'][0]
    assert mx['name'] == 'example.com'
    assert mx['value'] == '10 mail.example.com'
    assert mx['priority'] == 10

    txts = {r['name']: r['value'] for r in by_type['TXT']}
    assert txts['example.com'] == 'v=spf1 mx a ~all'
    assert txts['_dmarc.example.com'].startswith('v=DMARC1; p=quarantine')
    assert txts['serverkit._domainkey.example.com'] == 'v=DKIM1; k=rsa; p=PUBKEYB64'

    a = by_type['A'][0]
    assert a['name'] == 'mail.example.com'
    assert a['value'] == '203.0.113.5'


def test_build_records_omits_dkim_and_a_when_absent():
    domain = MailDomain(name='bare.example.com', dkim_selector='serverkit',
                        dkim_public_key=None)
    records = DkimDnsService.build_records(domain, server_ip=None)
    names = {(r['type'], r['name']) for r in records}
    assert ('A', 'mail.bare.example.com') not in names
    assert not any(r['name'].startswith('serverkit._domainkey') for r in records)


# ---------------------------------------------------------------------------
# DNS deployment via DNSProviderService
# ---------------------------------------------------------------------------

def _patch_provider(monkeypatch, zone=('cfg', 'zone')):
    """Patch DNSProviderService.find_zone_for_domain + set_record; return the
    captured set_record calls."""
    from app.services.dns_provider_service import DNSProviderService
    calls = []

    config = SimpleNamespace(id=7, name='cloudflare')
    zone_dict = {'id': 'zone-abc', 'name': 'example.com'}

    monkeypatch.setattr(DNSProviderService, 'find_zone_for_domain',
                        classmethod(lambda cls, name: (config, zone_dict)))

    def fake_set_record(cls, provider_id, zone_id, record_type, name, value,
                        ttl=3600, proxied=False, priority=None, source='provider'):
        calls.append({'provider_id': provider_id, 'zone_id': zone_id,
                      'type': record_type, 'name': name, 'value': value,
                      'priority': priority, 'source': source})
        return {'success': True}
    monkeypatch.setattr(DNSProviderService, 'set_record', classmethod(fake_set_record))
    return calls, config, zone_dict


def test_deploy_dns_pushes_exact_records(app, monkeypatch):
    from app import db
    row = MailDomain(name='example.com', dkim_selector='serverkit',
                     dkim_public_key='PUBKEYB64')
    db.session.add(row)
    db.session.commit()

    calls, config, zone = _patch_provider(monkeypatch)
    result = DkimDnsService.deploy_dns(row.id, server_ip='203.0.113.5')
    assert result['success'] is True
    assert result['deployed'] is True
    assert result['manual'] is False

    by = {(c['type'], c['name']): c for c in calls}
    # Every write is tagged source='mail' for the ownership ledger.
    assert all(c['source'] == 'mail' for c in calls)
    assert all(c['provider_id'] == 7 and c['zone_id'] == 'zone-abc' for c in calls)

    mx = by[('MX', 'example.com')]
    assert mx['value'] == '10 mail.example.com'
    assert mx['priority'] == 10
    assert by[('TXT', 'example.com')]['value'] == 'v=spf1 mx a ~all'
    assert by[('TXT', '_dmarc.example.com')]['value'].startswith('v=DMARC1; p=quarantine')
    assert by[('TXT', 'serverkit._domainkey.example.com')]['value'] == \
        'v=DKIM1; k=rsa; p=PUBKEYB64'
    assert by[('A', 'mail.example.com')]['value'] == '203.0.113.5'

    # The deployment ledger was recorded on the row.
    db.session.refresh(row)
    assert row.dns_deployed is True
    ledger = json.loads(row.dns_last_result)
    assert ledger['all_ok'] is True
    assert ledger['provider'] == 'cloudflare'


def test_deploy_dns_no_provider_returns_manual(app, monkeypatch):
    from app import db
    from app.services.dns_provider_service import DNSProviderService
    row = MailDomain(name='noprovider.example.com')
    db.session.add(row)
    db.session.commit()

    monkeypatch.setattr(DNSProviderService, 'find_zone_for_domain',
                        classmethod(lambda cls, name: (None, None)))
    monkeypatch.setattr(
        DNSProviderService, 'set_record',
        classmethod(lambda *a, **kw: pytest.fail('set_record must not run without a zone')))

    result = DkimDnsService.deploy_dns(row.id, server_ip='203.0.113.5')
    assert result['success'] is True
    assert result['deployed'] is False
    assert result['manual'] is True
    assert isinstance(result['records'], list) and result['records']


def test_dns_instructions_shape(app):
    from app import db
    row = MailDomain(name='inst.example.com', dkim_selector='serverkit',
                     dkim_public_key='PUB')
    db.session.add(row)
    db.session.commit()
    out = DkimDnsService.dns_instructions(row, server_ip='203.0.113.5')
    assert out['domain'] == 'inst.example.com'
    assert out['dns_deployed'] is False
    assert out['dkim_configured'] is False  # only public key set here, no private
    assert any(r['type'] == 'MX' for r in out['records'])


def test_request_cert_skips_on_windows(monkeypatch):
    monkeypatch.setattr(dns_mod.os, 'name', 'nt')
    result = DkimDnsService.request_cert('mail.example.com')
    assert result['success'] is False
    assert result['skipped'] is True


# ---------------------------------------------------------------------------
# fail2ban jail
# ---------------------------------------------------------------------------

def test_jail_unavailable_on_windows(monkeypatch):
    monkeypatch.setattr(jail_mod.os, 'name', 'nt')
    assert MailJailService.available() is False
    # Mutating calls degrade to a skipped descriptor, never raise.
    res = MailJailService.enable_auth_jail()
    assert res['success'] is True
    assert res['skipped'] is True
    assert res['available'] is False


def test_jail_enable_writes_serverkit_mail_conf(monkeypatch):
    monkeypatch.setattr(jail_mod.os, 'name', 'posix')
    monkeypatch.setattr(jail_mod, 'is_command_available', lambda c: True)

    writes = []

    def fake_run(cmd, timeout=None, input=None, **kwargs):
        writes.append({'cmd': list(cmd), 'input': input})
        return _proc(returncode=0)
    monkeypatch.setattr(jail_mod, 'run_privileged', fake_run)

    res = MailJailService.enable_auth_jail()
    assert res['success'] is True
    assert res['jail'] == 'serverkit-mail-auth'
    assert res['path'].endswith('serverkit-mail-auth.conf')

    tee = next(w for w in writes if w['cmd'][:1] == ['tee'])
    assert tee['cmd'][1].endswith('serverkit-mail-auth.conf')
    assert '/etc/fail2ban/jail.d' in tee['cmd'][1]
    assert '[serverkit-mail-auth]' in tee['input']
    assert 'enabled = true' in tee['input']
    # fail2ban was reloaded after the write.
    assert any(w['cmd'][:2] == ['fail2ban-client', 'reload'] for w in writes)


def test_jail_status_reports_availability(monkeypatch):
    monkeypatch.setattr(jail_mod.os, 'name', 'nt')
    info = MailJailService.status()
    assert info['available'] is False
    assert info['enabled'] is False
    assert info['jail'] == 'serverkit-mail-auth'
