"""Cloudflare operations API — zone settings (SSL/TLS, Speed, Caching, Security)
and one-click hardening, on top of the existing Cloudflare DNS connection.

Zones are addressed by their ServerKit ``DNSZone`` id (same as the ``/dns`` API);
the service resolves the Cloudflare credential + zone id server-side. Reads are
available to any authenticated user; writes require admin. Every mutating call is
captured by the global audit fallback (method, route args, sanitized body).
"""
from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity

from app.services.cloudflare_service import CloudflareService, CloudflareError

cloudflare_bp = Blueprint('cloudflare', __name__)


def _require_admin():
    """Return the current user if admin, else ``None``."""
    from app.models.user import User
    user = User.query.get(get_jwt_identity())
    return user if (user and user.is_admin) else None


def _service_response(res):
    """Map a service result dict to JSON. A failed *provider* call (reached
    Cloudflare, got an error back) is a 502; resolution errors are raised as
    CloudflareError upstream and handled separately as 400s."""
    if not res.get('success'):
        return jsonify({'error': res.get('error', 'Cloudflare request failed')}), 502
    return jsonify(res)


# ── Zone settings ────────────────────────────────────────────────────────────

@cloudflare_bp.route('/zones/<int:zone_id>/settings', methods=['GET'])
@jwt_required()
def get_zone_settings(zone_id):
    try:
        res = CloudflareService.get_settings(zone_id)
    except CloudflareError as e:
        return jsonify({'error': str(e)}), 400
    return _service_response(res)


@cloudflare_bp.route('/zones/<int:zone_id>/settings/apply-preset', methods=['POST'])
@jwt_required()
def apply_preset(zone_id):
    if not _require_admin():
        return jsonify({'error': 'Admin access required'}), 403
    try:
        res = CloudflareService.apply_recommended(zone_id)
    except CloudflareError as e:
        return jsonify({'error': str(e)}), 400
    # A preset is best-effort across many toggles; return 200 with the per-setting
    # report even when the plan gated some (the UI surfaces partial success).
    return jsonify(res)


@cloudflare_bp.route('/zones/<int:zone_id>/settings/<setting_id>', methods=['GET'])
@jwt_required()
def get_zone_setting(zone_id, setting_id):
    try:
        res = CloudflareService.get_setting(zone_id, setting_id)
    except CloudflareError as e:
        return jsonify({'error': str(e)}), 400
    return _service_response(res)


@cloudflare_bp.route('/zones/<int:zone_id>/settings/<setting_id>', methods=['PATCH'])
@jwt_required()
def update_zone_setting(zone_id, setting_id):
    if not _require_admin():
        return jsonify({'error': 'Admin access required'}), 403
    data = request.get_json(silent=True) or {}
    if 'value' not in data:
        return jsonify({'error': 'A "value" field is required'}), 400
    try:
        res = CloudflareService.update_setting(zone_id, setting_id, data['value'])
    except CloudflareError as e:
        return jsonify({'error': str(e)}), 400
    return _service_response(res)
