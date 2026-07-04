"""DNS provider connections (Cloudflare, Route 53, DigitalOcean, GoDaddy).

These routes back the Settings -> Connections DNS tiles and the wildcard-TLS
flows, so they are core — a panel without the serverkit-email extension must
still be able to connect a DNS provider. They keep the historical
/api/v1/email/dns-providers paths (the routes originally lived in the email
API before the extraction) so existing frontends keep working.
"""
from flask import Blueprint, request, jsonify

from app.middleware.rbac import admin_required, viewer_required
from app.services.dns_provider_service import DNSProviderService

dns_providers_bp = Blueprint('dns_providers', __name__)


@dns_providers_bp.route('/dns-providers', methods=['GET'])
@viewer_required
def list_dns_providers():
    """List configured DNS providers."""
    providers = DNSProviderService.list_providers()
    return jsonify({'providers': providers}), 200


@dns_providers_bp.route('/dns-providers', methods=['POST'])
@admin_required
def add_dns_provider():
    """Add a DNS provider."""
    data = request.get_json()
    if not data or not data.get('name') or not data.get('provider') or not data.get('api_key'):
        return jsonify({'success': False, 'error': 'Name, provider, and api_key are required'}), 400
    result = DNSProviderService.add_provider(
        name=data['name'],
        provider=data['provider'],
        api_key=data['api_key'],
        api_secret=data.get('api_secret'),
        api_email=data.get('api_email'),
        is_default=data.get('is_default', False),
    )
    return jsonify(result), 201 if result.get('success') else 400


@dns_providers_bp.route('/dns-providers/<int:provider_id>', methods=['DELETE'])
@admin_required
def remove_dns_provider(provider_id):
    """Remove a DNS provider."""
    result = DNSProviderService.remove_provider(provider_id)
    return jsonify(result), 200 if result.get('success') else 400


@dns_providers_bp.route('/dns-providers/<int:provider_id>/test', methods=['POST'])
@admin_required
def test_dns_provider(provider_id):
    """Test DNS provider connection."""
    result = DNSProviderService.test_connection(provider_id)
    return jsonify(result), 200 if result.get('success') else 400


@dns_providers_bp.route('/dns-providers/<int:provider_id>/zones', methods=['GET'])
@viewer_required
def list_dns_zones(provider_id):
    """List DNS zones from a provider."""
    result = DNSProviderService.list_zones(provider_id)
    return jsonify(result), 200 if result.get('success') else 400
