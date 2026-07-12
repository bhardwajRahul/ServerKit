"""serverkit-k8s extension tests — manifest, models, kubectl engine, service, blueprint.

Loads the builtin the way production does:
``plugin_service._ensure_builtin_backend_importable`` registers
``builtin-extensions/serverkit-k8s/backend`` as the dashed package
``app.plugins.serverkit-k8s``. The models module is imported at module top so
its ``ext_serverkit_k8s_*`` table registers on ``db.metadata`` before the ``app``
fixture runs ``db.create_all()``.

Proven here: manifest validity + permissions + entry point + lifecycle keys +
frontend export; the K8sCluster model (encryption round-trip, ``to_dict`` never
leaks the kubeconfig, single-default invariant); the kubectl engine (argv build,
temp-file materialize + guaranteed cleanup, error mapping); the cluster_service
normalizers turning canned ``kubectl -o json`` into compact UI dicts; and the
blueprint RBAC + kubectl-availability guards.
"""
import importlib
import json
import os
from types import SimpleNamespace

import pytest

from app.services import plugin_service

SLUG = 'serverkit-k8s'
EXT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    'builtin-extensions', SLUG,
)


def _load_ext():
    assert plugin_service._ensure_builtin_backend_importable(SLUG), (
        f'builtin extension backend not importable from {EXT_DIR}')
    models = importlib.import_module(f'app.plugins.{SLUG}.models')
    kubectl = importlib.import_module(f'app.plugins.{SLUG}.kubectl_service')
    cluster = importlib.import_module(f'app.plugins.{SLUG}.cluster_service')
    bp = importlib.import_module(f'app.plugins.{SLUG}.k8s')
    return models, kubectl, cluster, bp


models_mod, kubectl_mod, cluster_mod, bp_mod = _load_ext()
K8sCluster = models_mod.K8sCluster


def _proc(returncode=0, stdout='', stderr=''):
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


def _mk_cluster(app, name='c1', kubeconfig='apiVersion: v1\nkind: Config\n', context=None, default=False):
    from app import db
    c = K8sCluster(name=name, context=context, is_default=default)
    c.set_kubeconfig(kubeconfig)
    db.session.add(c)
    db.session.commit()
    return c


# ---------------------------------------------------------------------------
# manifest
# ---------------------------------------------------------------------------
def _manifest():
    with open(os.path.join(EXT_DIR, 'plugin.json'), encoding='utf-8') as f:
        return json.load(f)


def test_manifest_passes_validator():
    m = _manifest()
    assert plugin_service._validate_manifest(m) is True
    assert m['name'] == SLUG
    assert m['category'] == 'deployment'
    assert m['entry_point'] == 'k8s:k8s_bp'
    assert m['url_prefix'] == '/api/v1/k8s'
    assert m['models'] == 'models:register'
    nav = m['contributions']['nav'][0]
    assert nav['route'] == '/k8s' and nav['id'] == 'k8s'
    routes = m['contributions']['routes']
    assert {'path': 'k8s', 'component': 'K8sPage'} in routes
    assert m['contributions']['page_titles']['/k8s'] == 'Kubernetes'


def test_manifest_permissions_are_known():
    from app.plugins_sdk import permissions as sdk_perms
    assert sdk_perms.unknown_permissions(_manifest()['permissions']) == []


def test_manifest_description_has_no_em_or_en_dash():
    desc = _manifest().get('description', '')
    assert '—' not in desc and '–' not in desc


def test_lifecycle_hook_keys_resolve():
    lifecycle = _manifest()['lifecycle']
    assert set(lifecycle) <= {'install', 'upgrade', 'uninstall'}
    assert 'install' in lifecycle and 'uninstall' in lifecycle
    for ref in lifecycle.values():
        module_name, func_name = ref.split(':')
        mod = importlib.import_module(f'app.plugins.{SLUG}.{module_name}')
        assert callable(getattr(mod, func_name, None)), ref


def test_entry_point_resolves_to_blueprint():
    assert getattr(bp_mod, 'k8s_bp', None) is not None
    assert bp_mod.k8s_bp.name == 'k8s'


def test_models_register_returns_model_list():
    from app import db
    assert models_mod.register(db) == [K8sCluster]


def test_frontend_exports_route_component():
    index = os.path.join(EXT_DIR, 'frontend', 'index.jsx')
    if not os.path.isfile(index):
        pytest.skip('serverkit-k8s frontend/index.jsx not present in this build')
    with open(index, encoding='utf-8') as f:
        src = f.read()
    assert 'export { default as K8sPage }' in src
    assert 'export default' not in src


# ---------------------------------------------------------------------------
# model
# ---------------------------------------------------------------------------
def test_cluster_persists_and_to_dict_hides_kubeconfig(app):
    c = _mk_cluster(app, name='prod', context='ctx-a')
    d = c.to_dict()
    assert d['name'] == 'prod'
    assert d['context'] == 'ctx-a'
    # The secret must never appear in the serialized form (any key or value).
    assert 'kubeconfig' not in d
    assert 'kubeconfig_encrypted' not in d
    blob = json.dumps(d)
    assert 'apiVersion' not in blob


def test_kubeconfig_encryption_round_trips(app):
    secret = 'apiVersion: v1\nclusters:\n- name: x\n'
    c = _mk_cluster(app, name='enc', kubeconfig=secret)
    # Round-trips back to plaintext...
    assert c.get_kubeconfig() == secret
    # ...and (when a key is configured) is not stored verbatim.
    from app.utils.crypto import is_encryption_configured
    if is_encryption_configured():
        assert c.kubeconfig_encrypted != secret


def test_name_is_unique(app):
    from app import db
    _mk_cluster(app, name='dup')
    dupe = K8sCluster(name='dup')
    dupe.set_kubeconfig('x')
    db.session.add(dupe)
    with pytest.raises(Exception):
        db.session.commit()
    db.session.rollback()


# ---------------------------------------------------------------------------
# cluster_service CRUD + invariants
# ---------------------------------------------------------------------------
def test_create_first_cluster_is_default(app):
    c = cluster_mod.create_cluster('a', 'kc')
    assert c.is_default is True


def test_set_default_is_exclusive(app):
    a = cluster_mod.create_cluster('a', 'kc')
    b = cluster_mod.create_cluster('b', 'kc')
    assert a.is_default and not b.is_default
    cluster_mod.set_default(b.id)
    from app import db
    db.session.refresh(a)
    db.session.refresh(b)
    assert b.is_default and not a.is_default


def test_delete_default_promotes_another(app):
    a = cluster_mod.create_cluster('a', 'kc')
    b = cluster_mod.create_cluster('b', 'kc')
    cluster_mod.delete_cluster(a.id)  # a was default
    from app import db
    db.session.refresh(b)
    assert b.is_default is True


def test_create_rejects_blank_name_and_kubeconfig(app):
    with pytest.raises(ValueError):
        cluster_mod.create_cluster('', 'kc')
    with pytest.raises(ValueError):
        cluster_mod.create_cluster('x', '')


# ---------------------------------------------------------------------------
# kubectl engine
# ---------------------------------------------------------------------------
def test_build_argv_with_and_without_context():
    no_ctx = SimpleNamespace(context=None)
    assert kubectl_mod.build_argv(no_ctx, ['get', 'pods']) == ['kubectl', 'get', 'pods']
    with_ctx = SimpleNamespace(context='prod')
    assert kubectl_mod.build_argv(with_ctx, ['get', 'nodes']) == [
        'kubectl', '--context', 'prod', 'get', 'nodes']


def test_run_materializes_kubeconfig_and_cleans_up(monkeypatch, app):
    c = _mk_cluster(app, name='run', kubeconfig='THE-CONFIG')
    monkeypatch.setattr(kubectl_mod, 'is_available', lambda: True)

    seen = {}

    def fake_run(argv, **kwargs):
        # --kubeconfig <path> is appended; capture it and prove the file exists now.
        assert '--kubeconfig' in argv
        path = argv[argv.index('--kubeconfig') + 1]
        seen['path'] = path
        with open(path, encoding='utf-8') as f:
            seen['contents'] = f.read()
        return _proc(returncode=0, stdout='ok')

    monkeypatch.setattr(kubectl_mod.subprocess, 'run', fake_run)
    out = kubectl_mod.run(c, ['version'])
    assert out == 'ok'
    assert seen['contents'] == 'THE-CONFIG'
    # Temp kubeconfig is deleted after the call regardless of success.
    assert not os.path.exists(seen['path'])


def test_run_raises_kubectlerror_on_nonzero(monkeypatch, app):
    c = _mk_cluster(app, name='err')
    monkeypatch.setattr(kubectl_mod, 'is_available', lambda: True)
    monkeypatch.setattr(kubectl_mod.subprocess, 'run',
                        lambda argv, **kw: _proc(returncode=1, stderr='boom'))
    with pytest.raises(kubectl_mod.KubectlError) as ei:
        kubectl_mod.run(c, ['get', 'pods'])
    assert 'boom' in str(ei.value)


def test_run_raises_when_kubectl_absent(monkeypatch, app):
    c = _mk_cluster(app, name='absent')
    monkeypatch.setattr(kubectl_mod, 'is_available', lambda: False)
    with pytest.raises(kubectl_mod.KubectlError):
        kubectl_mod.run(c, ['version'])


# ---------------------------------------------------------------------------
# cluster_service normalizers (canned kubectl -o json)
# ---------------------------------------------------------------------------
def _patch_json(monkeypatch, payload):
    monkeypatch.setattr(cluster_mod.kubectl_service, 'run_json', lambda cluster, args, **kw: payload)


NODE_JSON = {'items': [{
    'metadata': {'name': 'node-1', 'labels': {'node-role.kubernetes.io/control-plane': ''}},
    'status': {
        'conditions': [{'type': 'Ready', 'status': 'True'}],
        'nodeInfo': {'kubeletVersion': 'v1.29.0', 'osImage': 'Ubuntu 22.04'},
        'capacity': {'cpu': '4', 'memory': '8Gi'},
    },
}]}

POD_JSON = {'items': [{
    'metadata': {'name': 'web-abc', 'namespace': 'default'},
    'spec': {'nodeName': 'node-1', 'containers': [{'name': 'web'}]},
    'status': {'phase': 'Running', 'podIP': '10.0.0.5',
               'containerStatuses': [{'ready': True, 'restartCount': 2}]},
}]}

DEPLOY_JSON = {'items': [{
    'metadata': {'name': 'web', 'namespace': 'default'},
    'spec': {'replicas': 3, 'template': {'spec': {'containers': [{'image': 'nginx:1.25'}]}}},
    'status': {'readyReplicas': 3, 'availableReplicas': 3},
}]}


def test_get_nodes_normalizes(monkeypatch, app):
    c = _mk_cluster(app)
    _patch_json(monkeypatch, NODE_JSON)
    nodes = cluster_mod.get_nodes(c)
    assert nodes[0]['name'] == 'node-1'
    assert nodes[0]['ready'] is True
    assert 'control-plane' in nodes[0]['roles']
    assert nodes[0]['kubelet_version'] == 'v1.29.0'
    assert nodes[0]['cpu'] == '4'


def test_get_pods_normalizes(monkeypatch, app):
    c = _mk_cluster(app)
    _patch_json(monkeypatch, POD_JSON)
    pods = cluster_mod.get_pods(c, 'default')
    assert pods[0]['name'] == 'web-abc'
    assert pods[0]['ready'] == '1/1'
    assert pods[0]['restarts'] == 2
    assert pods[0]['phase'] == 'Running'


def test_get_workloads_marks_healthy(monkeypatch, app):
    c = _mk_cluster(app)
    _patch_json(monkeypatch, DEPLOY_JSON)
    w = cluster_mod.get_workloads(c, 'default', 'deployment')
    assert w[0]['name'] == 'web'
    assert w[0]['desired'] == 3 and w[0]['ready'] == 3
    assert w[0]['healthy'] is True
    assert w[0]['images'] == ['nginx:1.25']


def test_scale_rejects_negative(monkeypatch, app):
    c = _mk_cluster(app)
    monkeypatch.setattr(cluster_mod.kubectl_service, 'run', lambda *a, **kw: '')
    with pytest.raises(ValueError):
        cluster_mod.scale_deployment(c, 'default', 'web', -1)


def test_delete_resource_rejects_unknown_kind(monkeypatch, app):
    c = _mk_cluster(app)
    monkeypatch.setattr(cluster_mod.kubectl_service, 'run', lambda *a, **kw: '')
    with pytest.raises(ValueError):
        cluster_mod.delete_resource(c, 'namespace', 'kube-system', 'kube-system')


def test_apply_rejects_empty_manifest(app):
    c = _mk_cluster(app)
    with pytest.raises(ValueError):
        cluster_mod.apply_manifest(c, '   ')


def test_test_connection_caches_result(monkeypatch, app):
    c = _mk_cluster(app, name='probe')
    monkeypatch.setattr(cluster_mod.kubectl_service, 'run_json',
                        lambda cluster, args, **kw: {'serverVersion': {'gitVersion': 'v1.29.3'}})
    res = cluster_mod.test_connection(c)
    assert res['ok'] is True and res['server_version'] == 'v1.29.3'
    assert c.last_reachable is True
    assert json.loads(c.last_status)['server_version'] == 'v1.29.3'


def test_test_connection_records_unreachable(monkeypatch, app):
    c = _mk_cluster(app, name='down')

    def boom(cluster, args, **kw):
        raise kubectl_mod.KubectlError('connection refused')
    monkeypatch.setattr(cluster_mod.kubectl_service, 'run_json', boom)
    res = cluster_mod.test_connection(c)
    assert res['ok'] is False
    assert 'refused' in res['error']
    assert c.last_reachable is False


# ---------------------------------------------------------------------------
# blueprint (RBAC + kubectl guard)
# ---------------------------------------------------------------------------
@pytest.fixture
def k8s_client(app):
    """Register the extension blueprint on the test app and return a client."""
    if 'k8s' not in app.blueprints:
        app.register_blueprint(bp_mod.k8s_bp, url_prefix='/api/v1/k8s')
    return app.test_client()


def test_status_route_lists_clusters(monkeypatch, k8s_client, auth_headers, app):
    _mk_cluster(app, name='s1', default=True)
    monkeypatch.setattr(bp_mod.kubectl_service, 'is_available', lambda: True)
    r = k8s_client.get('/api/v1/k8s/status', headers=auth_headers)
    assert r.status_code == 200
    body = r.get_json()
    assert body['kubectl_available'] is True
    assert any(c['name'] == 's1' for c in body['clusters'])


def test_read_route_503_when_kubectl_absent(monkeypatch, k8s_client, auth_headers, app):
    c = _mk_cluster(app, name='nok')
    monkeypatch.setattr(bp_mod.kubectl_service, 'is_available', lambda: False)
    r = k8s_client.get(f'/api/v1/k8s/clusters/{c.id}/nodes', headers=auth_headers)
    assert r.status_code == 503


def test_routes_require_auth(k8s_client):
    assert k8s_client.get('/api/v1/k8s/status').status_code in (401, 422)


def test_create_cluster_route(monkeypatch, k8s_client, auth_headers):
    r = k8s_client.post('/api/v1/k8s/clusters', headers=auth_headers,
                        json={'name': 'viaroute', 'kubeconfig': 'kc-blob'})
    assert r.status_code == 201
    assert r.get_json()['name'] == 'viaroute'
