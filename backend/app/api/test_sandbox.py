"""REST surface for the Test Sandbox (distro test matrix in Docker).

Mounted at /api/v1/test-sandbox (registered in app/__init__.py).
"""
from flask import Blueprint, jsonify, request

from ..middleware.rbac import admin_required, viewer_required
from ..services.test_sandbox_service import TestSandboxService

test_sandbox_bp = Blueprint('test_sandbox', __name__)


@test_sandbox_bp.route('/distros', methods=['GET'])
@viewer_required
def list_distros():
    """Distro registry + which modes each supports, plus host Docker status."""
    return jsonify({
        'distros': TestSandboxService.list_distros(),
        'docker_available': TestSandboxService.docker_available(),
    })


@test_sandbox_bp.route('/runs', methods=['GET'])
@viewer_required
def list_runs():
    limit = min(int(request.args.get('limit', 20)), 100)
    return jsonify({'runs': TestSandboxService.list_runs(limit=limit)})


@test_sandbox_bp.route('/runs', methods=['POST'])
@admin_required
def start_run():
    data = request.get_json(silent=True) or {}
    distros = data.get('distros') or []
    mode = data.get('mode', 'quick')
    try:
        from flask_jwt_extended import get_jwt_identity
        user_id = get_jwt_identity()
    except Exception:  # noqa: BLE001 — API-key callers have no JWT identity
        user_id = None
    try:
        run = TestSandboxService.start_run(distros, mode, user_id=user_id)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    except RuntimeError as exc:
        return jsonify({'error': str(exc)}), 409
    return jsonify({'run': run.to_dict()}), 202


@test_sandbox_bp.route('/runs/<int:run_id>', methods=['GET'])
@viewer_required
def get_run(run_id):
    run = TestSandboxService.get_run(run_id)
    if not run:
        return jsonify({'error': 'run not found'}), 404
    return jsonify({'run': run.to_dict()})


@test_sandbox_bp.route('/runs/<int:run_id>/cancel', methods=['POST'])
@admin_required
def cancel_run(run_id):
    if not TestSandboxService.cancel_run(run_id):
        return jsonify({'error': 'run not found or not running'}), 404
    return jsonify({'ok': True})


@test_sandbox_bp.route('/runs/<int:run_id>/logs/<distro>', methods=['GET'])
@viewer_required
def get_log(run_id, distro):
    log = TestSandboxService.get_log(run_id, distro)
    if log is None:
        return jsonify({'error': 'run or distro not found'}), 404
    return log, 200, {'Content-Type': 'text/plain; charset=utf-8'}
