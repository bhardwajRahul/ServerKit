"""Unified connection registry — one normalized, read-only list of every
external account ServerKit is connected to (source, DNS, infra, registrar,
storage). The individual write paths still live in their own blueprints; this
is the single source of truth for "what's connected".
"""

from flask import Blueprint, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity

from app.services.connection_registry import ConnectionRegistry

connections_bp = Blueprint('connections', __name__)


@connections_bp.route('', methods=['GET'])
@connections_bp.route('/', methods=['GET'])
@jwt_required()
def list_connections():
    """List every connected external account (secret-free)."""
    raw = get_jwt_identity()
    try:
        user_id = int(raw)
    except (TypeError, ValueError):
        user_id = raw
    return jsonify({'connections': ConnectionRegistry.list_all(user_id=user_id)})
