"""High-level operations for the serverkit-k8s extension.

This is the layer the blueprint calls. It owns:

- CRUD for saved cluster connections (:class:`K8sCluster` rows), including the
  single-default invariant.
- ``test_connection`` -- probe ``kubectl version`` and cache the result on the row.
- Read helpers (nodes, namespaces, workloads, pods, logs, services, ingresses,
  overview) that run ``kubectl get ... -o json`` and **normalize** the verbose
  Kubernetes objects down to the small flat dicts the UI actually consumes.
- Mutations (scale, restart, delete, apply) as thin ``kubectl`` wrappers.

Nothing here trusts the cluster to stay reachable: every read that hits the
cluster is wrapped by the blueprint and surfaces a clean error rather than a
stack trace.
"""
import json
import logging
from datetime import datetime

from app import db

from .models import K8sCluster
from . import kubectl_service
from .kubectl_service import KubectlError

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------
# CRUD
# --------------------------------------------------------------------------
def list_clusters():
    return [c.to_dict() for c in K8sCluster.query.order_by(K8sCluster.name.asc()).all()]


def get_cluster(cluster_id):
    return K8sCluster.query.get(cluster_id)


def get_default_cluster():
    return (K8sCluster.query.filter_by(is_default=True).first()
            or K8sCluster.query.order_by(K8sCluster.id.asc()).first())


def create_cluster(name, kubeconfig, context=None, make_default=False):
    name = (name or '').strip()
    if not name:
        raise ValueError('A cluster name is required.')
    if not (kubeconfig or '').strip():
        raise ValueError('A kubeconfig is required.')
    if K8sCluster.query.filter_by(name=name).first():
        raise ValueError(f'A cluster named "{name}" already exists.')

    cluster = K8sCluster(name=name, context=(context or None) or None)
    cluster.set_kubeconfig(kubeconfig)

    # First cluster is default automatically; otherwise honor the flag.
    if make_default or K8sCluster.query.count() == 0:
        _clear_default()
        cluster.is_default = True

    db.session.add(cluster)
    db.session.commit()
    return cluster


def update_cluster(cluster_id, name=None, kubeconfig=None, context=None):
    cluster = get_cluster(cluster_id)
    if not cluster:
        raise ValueError('Cluster not found.')
    if name is not None:
        name = name.strip()
        if not name:
            raise ValueError('A cluster name is required.')
        existing = K8sCluster.query.filter_by(name=name).first()
        if existing and existing.id != cluster.id:
            raise ValueError(f'A cluster named "{name}" already exists.')
        cluster.name = name
    if kubeconfig is not None and kubeconfig.strip():
        cluster.set_kubeconfig(kubeconfig)
    if context is not None:
        cluster.context = context.strip() or None
    db.session.commit()
    return cluster


def delete_cluster(cluster_id):
    cluster = get_cluster(cluster_id)
    if not cluster:
        raise ValueError('Cluster not found.')
    was_default = cluster.is_default
    db.session.delete(cluster)
    db.session.commit()
    # Promote another cluster to default if we removed the default one.
    if was_default:
        nxt = K8sCluster.query.order_by(K8sCluster.id.asc()).first()
        if nxt:
            nxt.is_default = True
            db.session.commit()
    return True


def set_default(cluster_id):
    cluster = get_cluster(cluster_id)
    if not cluster:
        raise ValueError('Cluster not found.')
    _clear_default()
    cluster.is_default = True
    db.session.commit()
    return cluster


def _clear_default():
    for c in K8sCluster.query.filter_by(is_default=True).all():
        c.is_default = False


# --------------------------------------------------------------------------
# Connectivity
# --------------------------------------------------------------------------
def test_connection(cluster):
    """Probe the cluster and cache the result on the row. Never raises."""
    result = {'ok': False, 'server_version': None, 'error': None}
    try:
        data = kubectl_service.run_json(cluster, ['version', '-o', 'json'], timeout=15)
        server = (data or {}).get('serverVersion') or {}
        version = server.get('gitVersion')
        if not version:
            raise KubectlError('cluster did not report a server version (unreachable?)')
        result['ok'] = True
        result['server_version'] = version
    except KubectlError as e:
        result['error'] = str(e)
    except Exception as e:  # noqa: BLE001 - defensive: never let a probe crash the request
        result['error'] = str(e)

    cluster.last_reachable = result['ok']
    cluster.last_status = json.dumps({'server_version': result['server_version'], 'error': result['error']})
    cluster.last_checked_at = datetime.utcnow()
    db.session.commit()
    return result


# --------------------------------------------------------------------------
# Reads (normalized)
# --------------------------------------------------------------------------
def _items(cluster, args):
    data = kubectl_service.run_json(cluster, args)
    return (data or {}).get('items', []) or []


def _ns_args(namespace):
    if namespace and namespace != 'all':
        return ['-n', namespace]
    return ['--all-namespaces']


def get_nodes(cluster):
    out = []
    for n in _items(cluster, ['get', 'nodes', '-o', 'json']):
        meta = n.get('metadata', {})
        status = n.get('status', {})
        conditions = {c.get('type'): c.get('status') for c in status.get('conditions', [])}
        ready = conditions.get('Ready') == 'True'
        info = status.get('nodeInfo', {})
        roles = [k.split('/', 1)[1] for k in meta.get('labels', {})
                 if k.startswith('node-role.kubernetes.io/')]
        out.append({
            'name': meta.get('name'),
            'ready': ready,
            'roles': roles or ['worker'],
            'kubelet_version': info.get('kubeletVersion'),
            'os_image': info.get('osImage'),
            'kernel_version': info.get('kernelVersion'),
            'container_runtime': info.get('containerRuntimeVersion'),
            'cpu': status.get('capacity', {}).get('cpu'),
            'memory': status.get('capacity', {}).get('memory'),
            'created_at': meta.get('creationTimestamp'),
        })
    return out


def get_namespaces(cluster):
    out = []
    for ns in _items(cluster, ['get', 'namespaces', '-o', 'json']):
        meta = ns.get('metadata', {})
        out.append({
            'name': meta.get('name'),
            'phase': ns.get('status', {}).get('phase'),
            'created_at': meta.get('creationTimestamp'),
        })
    return out


_WORKLOAD_KINDS = {
    'deployment': 'deployments',
    'statefulset': 'statefulsets',
    'daemonset': 'daemonsets',
}


def get_workloads(cluster, namespace='all', kind='deployment'):
    resource = _WORKLOAD_KINDS.get(kind, 'deployments')
    out = []
    for w in _items(cluster, ['get', resource] + _ns_args(namespace) + ['-o', 'json']):
        meta = w.get('metadata', {})
        spec = w.get('spec', {})
        status = w.get('status', {})
        if resource == 'daemonsets':
            desired = status.get('desiredNumberScheduled', 0)
            ready = status.get('numberReady', 0)
        else:
            desired = spec.get('replicas', 0)
            ready = status.get('readyReplicas', 0) or 0
        out.append({
            'name': meta.get('name'),
            'namespace': meta.get('namespace'),
            'kind': kind,
            'desired': desired,
            'ready': ready,
            'available': status.get('availableReplicas', ready) if resource != 'daemonsets' else status.get('numberAvailable', ready),
            'healthy': bool(desired) and ready == desired,
            'images': [c.get('image') for c in spec.get('template', {}).get('spec', {}).get('containers', [])],
            'created_at': meta.get('creationTimestamp'),
        })
    return out


def get_pods(cluster, namespace='all'):
    out = []
    for p in _items(cluster, ['get', 'pods'] + _ns_args(namespace) + ['-o', 'json']):
        meta = p.get('metadata', {})
        status = p.get('status', {})
        container_statuses = status.get('containerStatuses', []) or []
        restarts = sum(cs.get('restartCount', 0) for cs in container_statuses)
        ready_count = sum(1 for cs in container_statuses if cs.get('ready'))
        total = len(container_statuses) or len(p.get('spec', {}).get('containers', []))
        out.append({
            'name': meta.get('name'),
            'namespace': meta.get('namespace'),
            'phase': status.get('phase'),
            'ready': f'{ready_count}/{total}',
            'restarts': restarts,
            'node': p.get('spec', {}).get('nodeName'),
            'pod_ip': status.get('podIP'),
            'containers': [c.get('name') for c in p.get('spec', {}).get('containers', [])],
            'created_at': meta.get('creationTimestamp'),
        })
    return out


def get_pod_logs(cluster, namespace, pod, container=None, tail=200):
    args = ['logs', pod, '-n', namespace, '--tail', str(int(tail))]
    if container:
        args += ['-c', container]
    return kubectl_service.run(cluster, args, timeout=30)


def get_services(cluster, namespace='all'):
    out = []
    for s in _items(cluster, ['get', 'services'] + _ns_args(namespace) + ['-o', 'json']):
        meta = s.get('metadata', {})
        spec = s.get('spec', {})
        ports = ['{}/{}'.format(p.get('port'), p.get('protocol', 'TCP')) for p in spec.get('ports', [])]
        ingress = s.get('status', {}).get('loadBalancer', {}).get('ingress', []) or []
        external = ', '.join(filter(None, [i.get('ip') or i.get('hostname') for i in ingress])) or None
        out.append({
            'name': meta.get('name'),
            'namespace': meta.get('namespace'),
            'type': spec.get('type'),
            'cluster_ip': spec.get('clusterIP'),
            'external_ip': external,
            'ports': ports,
            'created_at': meta.get('creationTimestamp'),
        })
    return out


def get_ingresses(cluster, namespace='all'):
    out = []
    for ing in _items(cluster, ['get', 'ingresses'] + _ns_args(namespace) + ['-o', 'json']):
        meta = ing.get('metadata', {})
        spec = ing.get('spec', {})
        hosts = [r.get('host') for r in spec.get('rules', []) if r.get('host')]
        out.append({
            'name': meta.get('name'),
            'namespace': meta.get('namespace'),
            'class': spec.get('ingressClassName'),
            'hosts': hosts,
            'created_at': meta.get('creationTimestamp'),
        })
    return out


def get_overview(cluster):
    """A compact dashboard payload. Best-effort; partial data on partial failure."""
    overview = {
        'cluster': cluster.to_dict(),
        'reachable': False,
        'server_version': None,
        'counts': {'nodes': 0, 'nodes_ready': 0, 'namespaces': 0, 'pods': 0, 'pods_running': 0, 'deployments': 0},
        'error': None,
    }
    conn = test_connection(cluster)
    overview['reachable'] = conn['ok']
    overview['server_version'] = conn['server_version']
    if not conn['ok']:
        overview['error'] = conn['error']
        return overview
    try:
        nodes = get_nodes(cluster)
        namespaces = get_namespaces(cluster)
        pods = get_pods(cluster, 'all')
        deployments = get_workloads(cluster, 'all', 'deployment')
        overview['counts'] = {
            'nodes': len(nodes),
            'nodes_ready': sum(1 for n in nodes if n['ready']),
            'namespaces': len(namespaces),
            'pods': len(pods),
            'pods_running': sum(1 for p in pods if p['phase'] == 'Running'),
            'deployments': len(deployments),
        }
    except KubectlError as e:
        overview['error'] = str(e)
    return overview


# --------------------------------------------------------------------------
# Mutations
# --------------------------------------------------------------------------
def scale_deployment(cluster, namespace, name, replicas):
    replicas = int(replicas)
    if replicas < 0:
        raise ValueError('replicas must be >= 0')
    kubectl_service.run(
        cluster,
        ['scale', 'deployment', name, '-n', namespace, f'--replicas={replicas}'],
    )
    return {'name': name, 'namespace': namespace, 'replicas': replicas}


def restart_deployment(cluster, namespace, name):
    kubectl_service.run(cluster, ['rollout', 'restart', 'deployment', name, '-n', namespace])
    return {'name': name, 'namespace': namespace, 'restarted': True}


_DELETABLE_KINDS = {'pod', 'deployment', 'statefulset', 'daemonset', 'service', 'ingress'}


def delete_resource(cluster, kind, name, namespace):
    kind = (kind or '').lower()
    if kind not in _DELETABLE_KINDS:
        raise ValueError(f'Refusing to delete unsupported resource kind "{kind}".')
    if not name or not namespace:
        raise ValueError('name and namespace are required.')
    kubectl_service.run(cluster, ['delete', kind, name, '-n', namespace])
    return {'kind': kind, 'name': name, 'namespace': namespace, 'deleted': True}


def apply_manifest(cluster, manifest_text):
    if not (manifest_text or '').strip():
        raise ValueError('An empty manifest cannot be applied.')
    out = kubectl_service.run(cluster, ['apply', '-f', '-'], input_text=manifest_text, timeout=60)
    return {'output': out.strip()}
