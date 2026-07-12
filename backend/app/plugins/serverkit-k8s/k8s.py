"""Kubernetes API endpoints (serverkit-k8s extension).

Mounted under ``/api/v1/k8s`` via the manifest's ``url_prefix``. Thin routing
layer over :mod:`cluster_service` -- all kubectl work happens there. Reads need
viewer, mutations need admin (same split as the serverkit-mail and
serverkit-dns-server extensions).

Cluster CRUD works even when ``kubectl`` is absent so an operator can stage a
connection first; only routes that actually talk to a cluster are guarded by
``_kubectl_or_error`` (503 when the binary is missing).
"""
from flask import Blueprint, jsonify, request

from app.middleware.rbac import admin_required, viewer_required

from . import cluster_service
from . import kubectl_service
from .kubectl_service import KubectlError

k8s_bp = Blueprint('k8s', __name__)


def _kubectl_or_error():
    if not kubectl_service.is_available():
        return jsonify({
            'error': 'kubectl is not installed on the panel host. Install kubectl '
                     'to talk to clusters.'
        }), 503
    return None


def _cluster_or_404(cluster_id):
    return cluster_service.get_cluster(cluster_id)


def _kubectl_call(fn):
    """Run a cluster read/mutation, converting KubectlError to a clean 502."""
    try:
        return jsonify(fn())
    except KubectlError as e:
        return jsonify({'error': str(e)}), 502
    except ValueError as e:
        return jsonify({'error': str(e)}), 400


# --------------------------------------------------------------------------
# Status + cluster CRUD (no kubectl required)
# --------------------------------------------------------------------------
@k8s_bp.route('/status', methods=['GET'])
@viewer_required
def status():
    default = cluster_service.get_default_cluster()
    return jsonify({
        'kubectl_available': kubectl_service.is_available(),
        'clusters': cluster_service.list_clusters(),
        'default_cluster_id': default.id if default else None,
    })


@k8s_bp.route('/clusters', methods=['GET'])
@viewer_required
def list_clusters():
    return jsonify({'clusters': cluster_service.list_clusters()})


@k8s_bp.route('/clusters', methods=['POST'])
@admin_required
def create_cluster():
    data = request.get_json(silent=True) or {}
    try:
        cluster = cluster_service.create_cluster(
            name=data.get('name'),
            kubeconfig=data.get('kubeconfig'),
            context=data.get('context'),
            make_default=bool(data.get('make_default')),
        )
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    return jsonify(cluster.to_dict()), 201


@k8s_bp.route('/clusters/<int:cluster_id>', methods=['GET'])
@viewer_required
def get_cluster(cluster_id):
    cluster = _cluster_or_404(cluster_id)
    if not cluster:
        return jsonify({'error': 'Cluster not found'}), 404
    return jsonify(cluster.to_dict())


@k8s_bp.route('/clusters/<int:cluster_id>', methods=['PUT'])
@admin_required
def update_cluster(cluster_id):
    data = request.get_json(silent=True) or {}
    try:
        cluster = cluster_service.update_cluster(
            cluster_id,
            name=data.get('name'),
            kubeconfig=data.get('kubeconfig'),
            context=data.get('context'),
        )
    except ValueError as e:
        code = 404 if 'not found' in str(e).lower() else 400
        return jsonify({'error': str(e)}), code
    return jsonify(cluster.to_dict())


@k8s_bp.route('/clusters/<int:cluster_id>', methods=['DELETE'])
@admin_required
def delete_cluster(cluster_id):
    try:
        cluster_service.delete_cluster(cluster_id)
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    return jsonify({'deleted': True})


@k8s_bp.route('/clusters/<int:cluster_id>/default', methods=['POST'])
@admin_required
def set_default(cluster_id):
    try:
        cluster = cluster_service.set_default(cluster_id)
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    return jsonify(cluster.to_dict())


# --------------------------------------------------------------------------
# Cluster-talking routes (kubectl required)
# --------------------------------------------------------------------------
@k8s_bp.route('/clusters/<int:cluster_id>/test', methods=['POST'])
@viewer_required
def test_connection(cluster_id):
    guard = _kubectl_or_error()
    if guard:
        return guard
    cluster = _cluster_or_404(cluster_id)
    if not cluster:
        return jsonify({'error': 'Cluster not found'}), 404
    return jsonify(cluster_service.test_connection(cluster))


@k8s_bp.route('/clusters/<int:cluster_id>/overview', methods=['GET'])
@viewer_required
def overview(cluster_id):
    guard = _kubectl_or_error()
    if guard:
        return guard
    cluster = _cluster_or_404(cluster_id)
    if not cluster:
        return jsonify({'error': 'Cluster not found'}), 404
    return jsonify(cluster_service.get_overview(cluster))


def _read_route(cluster_id, fn_name):
    guard = _kubectl_or_error()
    if guard:
        return guard
    cluster = _cluster_or_404(cluster_id)
    if not cluster:
        return jsonify({'error': 'Cluster not found'}), 404
    namespace = request.args.get('namespace', 'all')
    fn = getattr(cluster_service, fn_name)
    if fn_name in ('get_nodes', 'get_namespaces'):
        return _kubectl_call(lambda: {'items': fn(cluster)})
    return _kubectl_call(lambda: {'items': fn(cluster, namespace)})


@k8s_bp.route('/clusters/<int:cluster_id>/nodes', methods=['GET'])
@viewer_required
def nodes(cluster_id):
    return _read_route(cluster_id, 'get_nodes')


@k8s_bp.route('/clusters/<int:cluster_id>/namespaces', methods=['GET'])
@viewer_required
def namespaces(cluster_id):
    return _read_route(cluster_id, 'get_namespaces')


@k8s_bp.route('/clusters/<int:cluster_id>/pods', methods=['GET'])
@viewer_required
def pods(cluster_id):
    return _read_route(cluster_id, 'get_pods')


@k8s_bp.route('/clusters/<int:cluster_id>/services', methods=['GET'])
@viewer_required
def services(cluster_id):
    return _read_route(cluster_id, 'get_services')


@k8s_bp.route('/clusters/<int:cluster_id>/ingresses', methods=['GET'])
@viewer_required
def ingresses(cluster_id):
    return _read_route(cluster_id, 'get_ingresses')


@k8s_bp.route('/clusters/<int:cluster_id>/workloads', methods=['GET'])
@viewer_required
def workloads(cluster_id):
    guard = _kubectl_or_error()
    if guard:
        return guard
    cluster = _cluster_or_404(cluster_id)
    if not cluster:
        return jsonify({'error': 'Cluster not found'}), 404
    namespace = request.args.get('namespace', 'all')
    kind = request.args.get('kind', 'deployment')
    return _kubectl_call(lambda: {'items': cluster_service.get_workloads(cluster, namespace, kind)})


@k8s_bp.route('/clusters/<int:cluster_id>/pods/<namespace>/<pod>/logs', methods=['GET'])
@viewer_required
def pod_logs(cluster_id, namespace, pod):
    guard = _kubectl_or_error()
    if guard:
        return guard
    cluster = _cluster_or_404(cluster_id)
    if not cluster:
        return jsonify({'error': 'Cluster not found'}), 404
    container = request.args.get('container')
    tail = request.args.get('tail', 200)
    return _kubectl_call(lambda: {'logs': cluster_service.get_pod_logs(cluster, namespace, pod, container, tail)})


# --------------------------------------------------------------------------
# Mutations (admin + kubectl required)
# --------------------------------------------------------------------------
def _mutation_setup(cluster_id):
    guard = _kubectl_or_error()
    if guard:
        return None, guard
    cluster = _cluster_or_404(cluster_id)
    if not cluster:
        return None, (jsonify({'error': 'Cluster not found'}), 404)
    return cluster, None


@k8s_bp.route('/clusters/<int:cluster_id>/deployments/<namespace>/<name>/scale', methods=['POST'])
@admin_required
def scale(cluster_id, namespace, name):
    cluster, err = _mutation_setup(cluster_id)
    if err:
        return err
    data = request.get_json(silent=True) or {}
    return _kubectl_call(lambda: cluster_service.scale_deployment(cluster, namespace, name, data.get('replicas', 0)))


@k8s_bp.route('/clusters/<int:cluster_id>/deployments/<namespace>/<name>/restart', methods=['POST'])
@admin_required
def restart(cluster_id, namespace, name):
    cluster, err = _mutation_setup(cluster_id)
    if err:
        return err
    return _kubectl_call(lambda: cluster_service.restart_deployment(cluster, namespace, name))


@k8s_bp.route('/clusters/<int:cluster_id>/delete-resource', methods=['POST'])
@admin_required
def delete_resource(cluster_id):
    cluster, err = _mutation_setup(cluster_id)
    if err:
        return err
    data = request.get_json(silent=True) or {}
    return _kubectl_call(lambda: cluster_service.delete_resource(
        cluster, data.get('kind'), data.get('name'), data.get('namespace')))


@k8s_bp.route('/clusters/<int:cluster_id>/apply', methods=['POST'])
@admin_required
def apply(cluster_id):
    cluster, err = _mutation_setup(cluster_id)
    if err:
        return err
    data = request.get_json(silent=True) or {}
    return _kubectl_call(lambda: cluster_service.apply_manifest(cluster, data.get('manifest')))
