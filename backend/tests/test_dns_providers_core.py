"""Proving tests: DNS provider connections are core, not extension-owned.

The /api/v1/email/dns-providers routes used to live only in the serverkit-email
extension, so a panel without it (email is gated to mail users) got a 404/405
from the Settings -> Connections DNS tiles — surfaced as a bare "Request
failed". These prove the routes exist in the core app with no plugins loaded.
"""


def test_list_dns_providers_without_email_extension(client, auth_headers):
    resp = client.get('/api/v1/email/dns-providers', headers=auth_headers)
    assert resp.status_code == 200
    assert resp.get_json() == {'providers': []}


def test_add_dns_provider_without_email_extension(client, auth_headers):
    resp = client.post('/api/v1/email/dns-providers', headers=auth_headers, json={
        'name': 'cf', 'provider': 'cloudflare', 'api_key': 'tok',
    })
    assert resp.status_code == 201
    body = resp.get_json()
    assert body.get('success') is True

    resp = client.get('/api/v1/email/dns-providers', headers=auth_headers)
    providers = resp.get_json()['providers']
    assert len(providers) == 1 and providers[0]['name'] == 'cf'


def test_add_dns_provider_validates_payload(client, auth_headers):
    resp = client.post('/api/v1/email/dns-providers', headers=auth_headers,
                       json={'name': 'cf'})
    assert resp.status_code == 400
    assert 'required' in resp.get_json()['error']
