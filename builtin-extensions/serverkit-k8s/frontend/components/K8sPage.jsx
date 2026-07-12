import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
    ShipWheel, RefreshCw, Plus, Trash2, Server, Boxes, Network,
    Layers, RotateCw, ScrollText, Star, Cable, FileCode, X,
} from 'lucide-react';
import api from '@/services/api';
import { PageTopbar, Pill } from '@/components/ds';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Modal from '@/components/Modal';
import ConfirmDialog from '@/components/ConfirmDialog';
import EmptyState from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';

import '../styles/k8s.scss';

// Route-driven tabs (manifest maps /k8s and /k8s/:tab to this component).
const TABS = [
    { slug: 'overview', to: '/k8s', label: 'Overview', end: true },
    { slug: 'workloads', to: '/k8s/workloads', label: 'Workloads' },
    { slug: 'pods', to: '/k8s/pods', label: 'Pods' },
    { slug: 'services', to: '/k8s/services', label: 'Services' },
    { slug: 'nodes', to: '/k8s/nodes', label: 'Nodes' },
    { slug: 'apply', to: '/k8s/apply', label: 'Apply' },
    { slug: 'clusters', to: '/k8s/clusters', label: 'Clusters' },
];
const VALID_TABS = TABS.map((t) => t.slug);

const phasePill = (phase) => {
    const kind = phase === 'Running' || phase === 'Succeeded' || phase === 'Active'
        ? 'green'
        : phase === 'Pending' ? 'amber' : phase === 'Failed' ? 'red' : 'gray';
    return <Pill kind={kind}>{phase || 'Unknown'}</Pill>;
};

const K8sPage = () => {
    const toast = useToast();
    const navigate = useNavigate();
    const { tab } = useParams();
    const activeTab = VALID_TABS.includes(tab) ? tab : 'overview';

    const [kubectlAvailable, setKubectlAvailable] = useState(true);
    const [clusters, setClusters] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [confirmDialog, setConfirmDialog] = useState(null);

    // Per-tab data
    const [overview, setOverview] = useState(null);
    const [namespace, setNamespace] = useState('all');
    const [namespaces, setNamespaces] = useState([]);
    const [workloadKind, setWorkloadKind] = useState('deployment');
    const [rows, setRows] = useState([]);
    const [dataLoading, setDataLoading] = useState(false);

    // Modals
    const [addClusterOpen, setAddClusterOpen] = useState(false);
    const [addForm, setAddForm] = useState({ name: '', context: '', kubeconfig: '', make_default: false });
    const [logsModal, setLogsModal] = useState(null); // {pod, namespace, container, text, loading}
    const [manifest, setManifest] = useState('');
    const [applyOutput, setApplyOutput] = useState(null);

    const selected = useMemo(
        () => clusters.find((c) => String(c.id) === String(selectedId)) || null,
        [clusters, selectedId],
    );

    // ── Cluster list ──
    const loadStatus = useCallback(async () => {
        setLoading(true);
        try {
            const data = await api.request('/k8s/status');
            setKubectlAvailable(data.kubectl_available);
            setClusters(data.clusters || []);
            setSelectedId((prev) => {
                if (prev && (data.clusters || []).some((c) => String(c.id) === String(prev))) return prev;
                return data.default_cluster_id || (data.clusters?.[0]?.id ?? null);
            });
        } catch (error) {
            toast.error(`Could not load Kubernetes status: ${error.message}`);
        } finally {
            setLoading(false);
        }
    }, [toast]);

    useEffect(() => { loadStatus(); }, [loadStatus]);

    // ── Namespaces (for the namespace filter) ──
    const loadNamespaces = useCallback(async () => {
        if (!selected || !kubectlAvailable) return;
        try {
            const data = await api.request(`/k8s/clusters/${selected.id}/namespaces`);
            setNamespaces((data.items || []).map((n) => n.name).filter(Boolean));
        } catch { /* namespace filter is optional */ }
    }, [selected, kubectlAvailable]);

    useEffect(() => { loadNamespaces(); }, [loadNamespaces]);

    // ── Tab data ──
    const loadTab = useCallback(async () => {
        if (!selected || !kubectlAvailable) { setRows([]); setOverview(null); return; }
        setDataLoading(true);
        try {
            if (activeTab === 'overview') {
                setOverview(await api.request(`/k8s/clusters/${selected.id}/overview`));
            } else if (activeTab === 'workloads') {
                const data = await api.request(`/k8s/clusters/${selected.id}/workloads?namespace=${namespace}&kind=${workloadKind}`);
                setRows(data.items || []);
            } else if (activeTab === 'pods') {
                const data = await api.request(`/k8s/clusters/${selected.id}/pods?namespace=${namespace}`);
                setRows(data.items || []);
            } else if (activeTab === 'services') {
                const data = await api.request(`/k8s/clusters/${selected.id}/services?namespace=${namespace}`);
                setRows(data.items || []);
            } else if (activeTab === 'nodes') {
                const data = await api.request(`/k8s/clusters/${selected.id}/nodes`);
                setRows(data.items || []);
            }
        } catch (error) {
            toast.error(error.message);
            setRows([]);
        } finally {
            setDataLoading(false);
        }
    }, [selected, kubectlAvailable, activeTab, namespace, workloadKind, toast]);

    useEffect(() => { loadTab(); }, [loadTab]);

    // ── Cluster actions ──
    const handleAddCluster = async () => {
        if (!addForm.name.trim() || !addForm.kubeconfig.trim()) {
            toast.error('Name and kubeconfig are required.');
            return;
        }
        setBusy(true);
        try {
            await api.request('/k8s/clusters', { method: 'POST', body: addForm });
            toast.success(`Cluster "${addForm.name}" added`);
            setAddClusterOpen(false);
            setAddForm({ name: '', context: '', kubeconfig: '', make_default: false });
            await loadStatus();
        } catch (error) {
            toast.error(`Could not add cluster: ${error.message}`);
        } finally {
            setBusy(false);
        }
    };

    const handleDeleteCluster = (cluster) => {
        setConfirmDialog({
            title: `Remove ${cluster.name}?`,
            message: 'This deletes the stored connection and its kubeconfig from the panel. The cluster itself is not touched.',
            confirmText: 'Remove',
            variant: 'destructive',
            onConfirm: async () => {
                setConfirmDialog(null);
                try {
                    await api.request(`/k8s/clusters/${cluster.id}`, { method: 'DELETE' });
                    toast.success('Cluster removed');
                    await loadStatus();
                } catch (error) {
                    toast.error(error.message);
                }
            },
            onCancel: () => setConfirmDialog(null),
        });
    };

    const handleSetDefault = async (cluster) => {
        try {
            await api.request(`/k8s/clusters/${cluster.id}/default`, { method: 'POST' });
            await loadStatus();
        } catch (error) {
            toast.error(error.message);
        }
    };

    const handleTest = async (cluster) => {
        setBusy(true);
        try {
            const res = await api.request(`/k8s/clusters/${cluster.id}/test`, { method: 'POST' });
            if (res.ok) toast.success(`Reachable — ${res.server_version}`);
            else toast.error(`Unreachable: ${res.error}`);
            await loadStatus();
        } catch (error) {
            toast.error(error.message);
        } finally {
            setBusy(false);
        }
    };

    // ── Workload actions ──
    const handleScale = (w, delta) => {
        const next = Math.max(0, (w.desired || 0) + delta);
        return doScale(w, next);
    };

    const doScale = async (w, replicas) => {
        setBusy(true);
        try {
            await api.request(`/k8s/clusters/${selected.id}/deployments/${w.namespace}/${w.name}/scale`,
                { method: 'POST', body: { replicas } });
            toast.success(`Scaled ${w.name} to ${replicas}`);
            await loadTab();
        } catch (error) {
            toast.error(error.message);
        } finally {
            setBusy(false);
        }
    };

    const handleRestart = async (w) => {
        setBusy(true);
        try {
            await api.request(`/k8s/clusters/${selected.id}/deployments/${w.namespace}/${w.name}/restart`,
                { method: 'POST' });
            toast.success(`Restart triggered for ${w.name}`);
        } catch (error) {
            toast.error(error.message);
        } finally {
            setBusy(false);
        }
    };

    const handleDeleteResource = (kind, row) => {
        setConfirmDialog({
            title: `Delete ${kind} ${row.name}?`,
            message: `This removes ${row.name} from namespace ${row.namespace} on the live cluster.`,
            confirmText: 'Delete',
            variant: 'destructive',
            onConfirm: async () => {
                setConfirmDialog(null);
                try {
                    await api.request(`/k8s/clusters/${selected.id}/delete-resource`,
                        { method: 'POST', body: { kind, name: row.name, namespace: row.namespace } });
                    toast.success(`${kind} ${row.name} deleted`);
                    await loadTab();
                } catch (error) {
                    toast.error(error.message);
                }
            },
            onCancel: () => setConfirmDialog(null),
        });
    };

    // ── Pod logs ──
    const openLogs = async (pod) => {
        const container = pod.containers?.[0] || '';
        setLogsModal({ pod: pod.name, namespace: pod.namespace, container, text: '', loading: true });
        try {
            const q = container ? `?container=${container}&tail=200` : '?tail=200';
            const data = await api.request(`/k8s/clusters/${selected.id}/pods/${pod.namespace}/${pod.name}/logs${q}`);
            setLogsModal((m) => m && ({ ...m, text: data.logs || '(no output)', loading: false }));
        } catch (error) {
            setLogsModal((m) => m && ({ ...m, text: `Error: ${error.message}`, loading: false }));
        }
    };

    // ── Apply ──
    const handleApply = async () => {
        if (!manifest.trim()) { toast.error('Paste a manifest first.'); return; }
        setBusy(true);
        setApplyOutput(null);
        try {
            const res = await api.request(`/k8s/clusters/${selected.id}/apply`, { method: 'POST', body: { manifest } });
            setApplyOutput(res.output || '(applied)');
            toast.success('Manifest applied');
        } catch (error) {
            setApplyOutput(`Error: ${error.message}`);
            toast.error(error.message);
        } finally {
            setBusy(false);
        }
    };

    // ── Renderers ──
    const NamespaceFilter = () => (
        <div className="k8s-filter">
            <Label>Namespace</Label>
            <select className="k8s-select" value={namespace} onChange={(e) => setNamespace(e.target.value)}>
                <option value="all">All namespaces</option>
                {namespaces.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
        </div>
    );

    const renderOverview = () => {
        if (dataLoading && !overview) return <EmptyState loading title="Querying cluster..." />;
        if (!overview) return <EmptyState icon={ShipWheel} title="No data" description="Select a reachable cluster." />;
        if (!overview.reachable) {
            return (
                <div className="card">
                    <div className="card-body">
                        <EmptyState icon={Cable} title="Cluster unreachable"
                            description={overview.error || 'kubectl could not reach the API server with the stored kubeconfig.'} />
                        <div className="k8s-center">
                            <Button variant="outline" size="sm" onClick={() => handleTest(selected)}>
                                <RefreshCw size={14} /> Retry
                            </Button>
                        </div>
                    </div>
                </div>
            );
        }
        const c = overview.counts;
        const cards = [
            { label: 'Server', value: overview.server_version, icon: ShipWheel },
            { label: 'Nodes ready', value: `${c.nodes_ready}/${c.nodes}`, icon: Server },
            { label: 'Namespaces', value: c.namespaces, icon: Layers },
            { label: 'Pods running', value: `${c.pods_running}/${c.pods}`, icon: Boxes },
            { label: 'Deployments', value: c.deployments, icon: Network },
        ];
        return (
            <div className="k8s-kpis">
                {cards.map((k) => (
                    <div className="card k8s-kpi" key={k.label}>
                        <div className="card-body">
                            <div className="k8s-kpi__icon"><k.icon size={18} /></div>
                            <div className="k8s-kpi__val">{k.value ?? '—'}</div>
                            <div className="k8s-kpi__label">{k.label}</div>
                        </div>
                    </div>
                ))}
            </div>
        );
    };

    const renderWorkloads = () => (
        <div className="card sec-flush">
            <div className="card-header">
                <h3>Workloads</h3>
                <div className="card-actions k8s-toolbar">
                    <select className="k8s-select" value={workloadKind} onChange={(e) => setWorkloadKind(e.target.value)}>
                        <option value="deployment">Deployments</option>
                        <option value="statefulset">StatefulSets</option>
                        <option value="daemonset">DaemonSets</option>
                    </select>
                    <NamespaceFilter />
                </div>
            </div>
            <div className="card-body">
                {dataLoading ? <EmptyState loading title="Loading workloads..." />
                    : rows.length === 0 ? <EmptyState icon={Network} title="No workloads" description="Nothing found in this namespace." />
                        : (
                            <table className="sk-dtable">
                                <thead>
                                    <tr><th>Name</th><th>Namespace</th><th>Replicas</th><th>Status</th><th>Image</th><th /></tr>
                                </thead>
                                <tbody>
                                    {rows.map((w) => (
                                        <tr key={`${w.namespace}/${w.name}`}>
                                            <td className="sk-cell-mono">{w.name}</td>
                                            <td>{w.namespace}</td>
                                            <td>
                                                {workloadKind === 'deployment' ? (
                                                    <span className="k8s-scale">
                                                        <Button variant="secondary" size="sm" disabled={busy} onClick={() => handleScale(w, -1)}>−</Button>
                                                        <span className="k8s-scale__n">{w.ready}/{w.desired}</span>
                                                        <Button variant="secondary" size="sm" disabled={busy} onClick={() => handleScale(w, +1)}>+</Button>
                                                    </span>
                                                ) : <span className="sk-cell-mono">{w.ready}/{w.desired}</span>}
                                            </td>
                                            <td><Pill kind={w.healthy ? 'green' : 'amber'}>{w.healthy ? 'healthy' : 'degraded'}</Pill></td>
                                            <td className="sk-cell-mono k8s-truncate" title={(w.images || []).join(', ')}>{(w.images || [])[0] || '—'}</td>
                                            <td className="k8s-row-actions">
                                                {workloadKind === 'deployment' && (
                                                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => handleRestart(w)} title="Rolling restart">
                                                        <RotateCw size={14} />
                                                    </Button>
                                                )}
                                                <Button variant="destructive" size="sm" disabled={busy} onClick={() => handleDeleteResource(workloadKind, w)}>
                                                    <Trash2 size={14} />
                                                </Button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
            </div>
        </div>
    );

    const renderPods = () => (
        <div className="card sec-flush">
            <div className="card-header">
                <h3>Pods</h3>
                <div className="card-actions"><NamespaceFilter /></div>
            </div>
            <div className="card-body">
                {dataLoading ? <EmptyState loading title="Loading pods..." />
                    : rows.length === 0 ? <EmptyState icon={Boxes} title="No pods" description="Nothing running in this namespace." />
                        : (
                            <table className="sk-dtable">
                                <thead>
                                    <tr><th>Name</th><th>Namespace</th><th>Ready</th><th>Status</th><th>Restarts</th><th>Node</th><th /></tr>
                                </thead>
                                <tbody>
                                    {rows.map((p) => (
                                        <tr key={`${p.namespace}/${p.name}`}>
                                            <td className="sk-cell-mono k8s-truncate" title={p.name}>{p.name}</td>
                                            <td>{p.namespace}</td>
                                            <td className="sk-cell-mono">{p.ready}</td>
                                            <td>{phasePill(p.phase)}</td>
                                            <td className="sk-cell-mono">{p.restarts > 0 ? <Pill kind="amber">{p.restarts}</Pill> : 0}</td>
                                            <td className="sk-cell-mono k8s-truncate">{p.node || '—'}</td>
                                            <td className="k8s-row-actions">
                                                <Button variant="secondary" size="sm" onClick={() => openLogs(p)} title="Logs">
                                                    <ScrollText size={14} />
                                                </Button>
                                                <Button variant="destructive" size="sm" disabled={busy} onClick={() => handleDeleteResource('pod', p)}>
                                                    <Trash2 size={14} />
                                                </Button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
            </div>
        </div>
    );

    const renderServices = () => (
        <div className="card sec-flush">
            <div className="card-header">
                <h3>Services</h3>
                <div className="card-actions"><NamespaceFilter /></div>
            </div>
            <div className="card-body">
                {dataLoading ? <EmptyState loading title="Loading services..." />
                    : rows.length === 0 ? <EmptyState icon={Cable} title="No services" />
                        : (
                            <table className="sk-dtable">
                                <thead>
                                    <tr><th>Name</th><th>Namespace</th><th>Type</th><th>Cluster IP</th><th>External</th><th>Ports</th></tr>
                                </thead>
                                <tbody>
                                    {rows.map((s) => (
                                        <tr key={`${s.namespace}/${s.name}`}>
                                            <td className="sk-cell-mono">{s.name}</td>
                                            <td>{s.namespace}</td>
                                            <td><Pill kind={s.type === 'LoadBalancer' ? 'green' : 'gray'}>{s.type}</Pill></td>
                                            <td className="sk-cell-mono">{s.cluster_ip || '—'}</td>
                                            <td className="sk-cell-mono">{s.external_ip || '—'}</td>
                                            <td className="sk-cell-mono">{(s.ports || []).join(', ') || '—'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
            </div>
        </div>
    );

    const renderNodes = () => (
        <div className="card sec-flush">
            <div className="card-header"><h3>Nodes</h3></div>
            <div className="card-body">
                {dataLoading ? <EmptyState loading title="Loading nodes..." />
                    : rows.length === 0 ? <EmptyState icon={Server} title="No nodes" />
                        : (
                            <table className="sk-dtable">
                                <thead>
                                    <tr><th>Name</th><th>Status</th><th>Roles</th><th>Version</th><th>OS</th><th>CPU</th><th>Memory</th></tr>
                                </thead>
                                <tbody>
                                    {rows.map((n) => (
                                        <tr key={n.name}>
                                            <td className="sk-cell-mono">{n.name}</td>
                                            <td><Pill kind={n.ready ? 'green' : 'red'}>{n.ready ? 'Ready' : 'NotReady'}</Pill></td>
                                            <td>{(n.roles || []).join(', ')}</td>
                                            <td className="sk-cell-mono">{n.kubelet_version || '—'}</td>
                                            <td className="k8s-truncate" title={n.os_image}>{n.os_image || '—'}</td>
                                            <td className="sk-cell-mono">{n.cpu || '—'}</td>
                                            <td className="sk-cell-mono">{n.memory || '—'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
            </div>
        </div>
    );

    const renderApply = () => (
        <div className="card">
            <div className="card-header"><h3>Apply manifest</h3></div>
            <div className="card-body k8s-apply">
                <p className="text-muted">
                    Paste a Kubernetes YAML or JSON manifest. It is sent to the selected cluster with
                    <code> kubectl apply -f -</code>. Admin only.
                </p>
                <textarea
                    className="k8s-textarea"
                    rows={16}
                    spellCheck={false}
                    placeholder={'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: demo'}
                    value={manifest}
                    onChange={(e) => setManifest(e.target.value)}
                />
                <div className="k8s-apply__actions">
                    <Button variant="default" size="sm" disabled={busy || !selected} onClick={handleApply}>
                        <FileCode size={14} /> Apply
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => { setManifest(''); setApplyOutput(null); }}>Clear</Button>
                </div>
                {applyOutput != null && <pre className="k8s-output">{applyOutput}</pre>}
            </div>
        </div>
    );

    const renderClusters = () => (
        <div className="card sec-flush">
            <div className="card-header">
                <h3>Clusters</h3>
                <div className="card-actions">
                    <Button variant="default" size="sm" onClick={() => setAddClusterOpen(true)}>
                        <Plus size={14} /> Add cluster
                    </Button>
                </div>
            </div>
            <div className="card-body">
                {clusters.length === 0 ? (
                    <EmptyState icon={ShipWheel} title="No clusters yet"
                        description="Add a cluster by pasting its kubeconfig to start managing workloads." />
                ) : (
                    <table className="sk-dtable">
                        <thead>
                            <tr><th>Name</th><th>Context</th><th>Reachable</th><th>Server</th><th>Last checked</th><th /></tr>
                        </thead>
                        <tbody>
                            {clusters.map((c) => (
                                <tr key={c.id}>
                                    <td className="sk-cell-mono">
                                        {c.is_default && <Star size={12} className="k8s-default-star" title="Default" />} {c.name}
                                    </td>
                                    <td className="sk-cell-mono">{c.context || '—'}</td>
                                    <td>
                                        {c.last_reachable == null
                                            ? <Pill kind="gray">unknown</Pill>
                                            : <Pill kind={c.last_reachable ? 'green' : 'red'}>{c.last_reachable ? 'yes' : 'no'}</Pill>}
                                    </td>
                                    <td className="sk-cell-mono">{c.status?.server_version || '—'}</td>
                                    <td className="sk-cell-mono">{c.last_checked_at ? new Date(c.last_checked_at).toLocaleString() : '—'}</td>
                                    <td className="k8s-row-actions">
                                        <Button variant="secondary" size="sm" disabled={busy || !kubectlAvailable} onClick={() => handleTest(c)}>Test</Button>
                                        {!c.is_default && <Button variant="secondary" size="sm" onClick={() => handleSetDefault(c)}>Set default</Button>}
                                        <Button variant="destructive" size="sm" onClick={() => handleDeleteCluster(c)}><Trash2 size={14} /></Button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );

    // ── Page shell ──
    if (loading) {
        return (
            <div className="page-container page-container--full-bleed sk-tabgroup k8s-page">
                <PageTopbar icon={<ShipWheel size={18} />} title="Kubernetes" />
                <div className="sk-tabgroup__content">
                    <div className="sk-tabgroup__inner">
                        <EmptyState loading title="Loading Kubernetes..." />
                    </div>
                </div>
            </div>
        );
    }

    const topbarTabs = TABS.map(({ to, label, end }) => ({ to, label, end }));
    const needsCluster = activeTab !== 'clusters' && clusters.length === 0;

    return (
        <div className="page-container page-container--full-bleed sk-tabgroup k8s-page">
            <PageTopbar
                icon={<ShipWheel size={18} />}
                title="Kubernetes"
                tabs={topbarTabs}
                actions={
                    <div className="k8s-topbar-actions">
                        {clusters.length > 0 && activeTab !== 'clusters' && (
                            <select className="k8s-select" value={selectedId ?? ''} onChange={(e) => setSelectedId(e.target.value)}>
                                {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                        )}
                        <Button variant="outline" size="sm" onClick={() => { loadStatus(); loadTab(); }}>
                            <RefreshCw size={14} /> Refresh
                        </Button>
                    </div>
                }
            />

            <div className="sk-tabgroup__content">
                <div className="sk-tabgroup__inner">
                    {!kubectlAvailable && (
                        <div className="card k8s-warn">
                            <div className="card-body">
                                <strong>kubectl is not installed on the panel host.</strong> You can still add and
                                store cluster connections, but live cluster data and actions are unavailable until
                                <code> kubectl</code> is on the panel host PATH.
                            </div>
                        </div>
                    )}

                    {needsCluster ? (
                        <div className="card">
                            <div className="card-body">
                                <EmptyState icon={ShipWheel} title="No clusters connected"
                                    description="Add a cluster on the Clusters tab by pasting its kubeconfig." />
                                <div className="k8s-center">
                                    <Button variant="default" size="sm" onClick={() => navigate('/k8s/clusters')}>
                                        <Plus size={14} /> Go to Clusters
                                    </Button>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <>
                            {activeTab === 'overview' && renderOverview()}
                            {activeTab === 'workloads' && renderWorkloads()}
                            {activeTab === 'pods' && renderPods()}
                            {activeTab === 'services' && renderServices()}
                            {activeTab === 'nodes' && renderNodes()}
                            {activeTab === 'apply' && renderApply()}
                            {activeTab === 'clusters' && renderClusters()}
                        </>
                    )}
                </div>
            </div>

            {/* Add cluster modal */}
            <Modal open={addClusterOpen} onClose={() => setAddClusterOpen(false)} title="Add Kubernetes cluster">
                <div className="k8s-form">
                    <div className="form-group">
                        <Label>Name</Label>
                        <Input type="text" value={addForm.name} placeholder="prod-eu"
                            onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))} />
                    </div>
                    <div className="form-group">
                        <Label>Context (optional)</Label>
                        <Input type="text" value={addForm.context} placeholder="Leave blank for the kubeconfig's current-context"
                            onChange={(e) => setAddForm((f) => ({ ...f, context: e.target.value }))} />
                    </div>
                    <div className="form-group">
                        <Label>Kubeconfig</Label>
                        <textarea className="k8s-textarea" rows={10} spellCheck={false}
                            placeholder="Paste the full kubeconfig YAML here"
                            value={addForm.kubeconfig}
                            onChange={(e) => setAddForm((f) => ({ ...f, kubeconfig: e.target.value }))} />
                        <p className="text-muted">Stored encrypted with the panel key. Never shown again after saving.</p>
                    </div>
                    <label className="k8s-checkbox">
                        <input type="checkbox" checked={addForm.make_default}
                            onChange={(e) => setAddForm((f) => ({ ...f, make_default: e.target.checked }))} />
                        Make this the default cluster
                    </label>
                </div>
                <div className="modal-footer">
                    <Button variant="outline" onClick={() => setAddClusterOpen(false)}>Cancel</Button>
                    <Button variant="default" onClick={handleAddCluster} disabled={busy}>Add cluster</Button>
                </div>
            </Modal>

            {/* Logs modal */}
            <Modal open={!!logsModal} onClose={() => setLogsModal(null)}
                title={logsModal ? `Logs · ${logsModal.pod}` : 'Logs'}>
                {logsModal?.loading
                    ? <EmptyState loading title="Fetching logs..." />
                    : <pre className="k8s-logs">{logsModal?.text}</pre>}
                <div className="modal-footer">
                    <Button variant="outline" onClick={() => setLogsModal(null)}><X size={14} /> Close</Button>
                </div>
            </Modal>

            {confirmDialog && (
                <ConfirmDialog
                    title={confirmDialog.title}
                    message={confirmDialog.message}
                    confirmText={confirmDialog.confirmText}
                    variant={confirmDialog.variant}
                    onConfirm={confirmDialog.onConfirm}
                    onCancel={confirmDialog.onCancel}
                />
            )}
        </div>
    );
};

export default K8sPage;
