import { useState, useEffect, useCallback } from 'react';
import {
    Network, Plus, Trash2, Globe, Lock, ShieldCheck, ExternalLink,
    ArrowRight, HardDrive, Cloud, AlertTriangle,
} from 'lucide-react';
import api from '../services/api';
import { useToast } from '../contexts/ToastContext';
import EmptyState from '../components/EmptyState';
import Spinner from '../components/Spinner';
import Modal from '../components/Modal';
import { Pill } from '@/components/ds';
import { useTopbarActions } from '@/hooks/useTopbarActions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
    Select,
    SelectTrigger,
    SelectContent,
    SelectItem,
    SelectValue,
} from '@/components/ui/select';

// Tunnel / service status → status-pill tone.
const PILL_KIND = {
    up: 'green',
    published: 'green',
    pending: 'amber',
    degraded: 'amber',
    down: 'red',
    error: 'red',
};
const pillKind = (status) => PILL_KIND[status] || 'gray';

const EMPTY_FORM = {
    privateServerId: '',
    edgeServerId: '',
    hostname: '',
    port: '',
    requireAuth: false,
    authUsername: '',
    authPassword: '',
    ssl: true,
};

const RemoteAccess = () => {
    const toast = useToast();
    const [tunnels, setTunnels] = useState([]);
    const [services, setServices] = useState({}); // tunnelId -> [service]
    const [servers, setServers] = useState([]);
    const [loading, setLoading] = useState(true);

    const [wizardOpen, setWizardOpen] = useState(false);
    const [wizardTunnel, setWizardTunnel] = useState(null); // preset when adding to an existing tunnel
    const [form, setForm] = useState(EMPTY_FORM);
    const [submitting, setSubmitting] = useState(false);

    const [teardown, setTeardown] = useState(null); // tunnel pending teardown

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [tRes, sRes] = await Promise.all([api.getTunnels(), api.getServers()]);
            const list = tRes.tunnels || [];
            setTunnels(list);
            setServers(sRes.servers || sRes || []);
            const entries = await Promise.all(
                list.map((t) =>
                    api
                        .getTunnelServices(t.id)
                        .then((r) => [t.id, r.services || []])
                        .catch(() => [t.id, []])
                )
            );
            setServices(Object.fromEntries(entries));
        } catch (e) {
            toast.error(e.message || 'Failed to load tunnels');
        } finally {
            setLoading(false);
        }
    }, [toast]);

    useEffect(() => {
        load();
    }, [load]);

    const openWizard = (tunnel = null) => {
        setWizardTunnel(tunnel);
        setForm({
            ...EMPTY_FORM,
            edgeServerId: tunnel ? tunnel.edge_server_id : '',
            privateServerId: tunnel ? tunnel.private_server_id : '',
        });
        setWizardOpen(true);
    };

    const closeWizard = () => {
        if (submitting) return;
        setWizardOpen(false);
        setWizardTunnel(null);
        setForm(EMPTY_FORM);
    };

    const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

    const wizardValid =
        form.hostname.trim() &&
        form.port &&
        (wizardTunnel ||
            (form.edgeServerId && form.privateServerId && form.edgeServerId !== form.privateServerId)) &&
        (!form.requireAuth || (form.authUsername.trim() && form.authPassword));

    const submitWizard = async () => {
        if (!wizardValid || submitting) return;
        setSubmitting(true);
        try {
            // Ensure a tunnel between the two servers (reuse an existing one).
            let tunnelId = wizardTunnel?.id;
            if (!tunnelId) {
                const existing = tunnels.find(
                    (t) =>
                        t.edge_server_id === form.edgeServerId &&
                        t.private_server_id === form.privateServerId
                );
                if (existing) {
                    tunnelId = existing.id;
                } else {
                    const created = await api.createTunnel({
                        edge_server_id: form.edgeServerId,
                        private_server_id: form.privateServerId,
                    });
                    tunnelId = created.id;
                }
            }
            const svc = await api.publishTunnelService(tunnelId, {
                hostname: form.hostname.trim(),
                port: Number(form.port),
                require_auth: form.requireAuth,
                auth_username: form.authUsername.trim() || undefined,
                auth_password: form.authPassword || undefined,
                ssl: form.ssl,
            });
            toast.success(`Exposed ${svc.hostname}`);
            closeWizard();
            load();
        } catch (e) {
            toast.error(e.message || 'Failed to expose service');
        } finally {
            setSubmitting(false);
        }
    };

    const confirmTeardown = async () => {
        if (!teardown) return;
        try {
            await api.deleteTunnel(teardown.id);
            toast.success('Tunnel torn down');
            setTeardown(null);
            load();
        } catch (e) {
            toast.error(e.message || 'Failed to tear down tunnel');
        }
    };

    const unpublish = async (tunnelId, svc) => {
        try {
            await api.unpublishTunnelService(tunnelId, svc.id);
            toast.success(`Removed ${svc.hostname}`);
            load();
        } catch (e) {
            toast.error(e.message || 'Failed to remove service');
        }
    };

    // Header action lives in the shared Servers top bar (this page is a tab in
    // the Servers group), so the page renders no header of its own.
    useTopbarActions(
        () => (
            <Button size="sm" onClick={() => openWizard(null)} disabled={loading}>
                <Plus size={15} /> Expose a Local Service
            </Button>
        ),
        [loading]
    );

    return (
        <div className="sk-tabgroup__inner ra-page">
            <p className="ra-intro">
                Expose a service running on a private machine (behind NAT, no port-forwarding) to a
                public hostname over a WireGuard tunnel between two of your agents.
            </p>

            {loading ? (
                <div className="ra-loading">
                    <Spinner />
                </div>
            ) : tunnels.length === 0 ? (
                <EmptyState
                    icon={Network}
                    title="No tunnels yet"
                    description="Pick a public-IP edge server and a private host, and ServerKit will pair them over WireGuard and publish your service — no router changes needed."
                    action={
                        <Button onClick={() => openWizard(null)}>
                            <Plus size={16} /> Expose a Local Service
                        </Button>
                    }
                />
            ) : (
                <div className="ra-list">
                    {tunnels.map((t) => {
                        const svcs = services[t.id] || [];
                        return (
                            <section key={t.id} className="ra-tunnel">
                                <div className="ra-tunnel__head">
                                    <div className="ra-tunnel__info">
                                        <div className="ra-tunnel__route">
                                            <span className="ra-node">
                                                <span className="ra-node__ico"><HardDrive size={14} /></span>
                                                {t.private_server_name || t.private_server_id}
                                            </span>
                                            <ArrowRight className="ra-arrow" size={16} />
                                            <span className="ra-node">
                                                <span className="ra-node__ico"><Cloud size={14} /></span>
                                                {t.edge_server_name || t.edge_server_id}
                                            </span>
                                            <Pill kind={pillKind(t.status)}>{t.status || 'unknown'}</Pill>
                                        </div>
                                        <div className="ra-tunnel__meta">
                                            <span>{t.subnet}</span>
                                            <span className="ra-dot">·</span>
                                            <span>{t.interface_name}</span>
                                            <span className="ra-dot">·</span>
                                            <span>UDP {t.listen_port}</span>
                                            <span className="ra-dot">·</span>
                                            <span>
                                                {t.last_handshake_at
                                                    ? `handshake ${new Date(t.last_handshake_at).toLocaleString()}`
                                                    : 'no handshake yet'}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="ra-tunnel__actions">
                                        <Button variant="outline" size="sm" onClick={() => openWizard(t)}>
                                            <Plus size={15} /> Expose service
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="text-red-600"
                                            onClick={() => setTeardown(t)}
                                            title="Tear down tunnel"
                                        >
                                            <Trash2 size={15} />
                                        </Button>
                                    </div>
                                </div>

                                {!t.last_handshake_at && t.status !== 'up' && (
                                    <div className="ra-tunnel__warn">
                                        <AlertTriangle size={14} />
                                        <span>
                                            No handshake yet — if this persists, the private host&apos;s outbound UDP
                                            to the edge may be blocked (a relay is needed).
                                        </span>
                                    </div>
                                )}

                                <div className="ra-svcs">
                                    {svcs.length === 0 ? (
                                        <p className="ra-svcs__empty">No services exposed on this tunnel yet.</p>
                                    ) : (
                                        svcs.map((svc) => (
                                            <div key={svc.id} className="ra-svc">
                                                <div className="ra-svc__main">
                                                    <Globe className="ra-svc__ico" size={15} />
                                                    {svc.url ? (
                                                        <a
                                                            className="ra-svc__host"
                                                            href={svc.url}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                        >
                                                            {svc.hostname}
                                                            <ExternalLink size={12} />
                                                        </a>
                                                    ) : (
                                                        <span className="ra-svc__host">{svc.hostname}</span>
                                                    )}
                                                    <span className="ra-svc__port">→ :{svc.port}</span>
                                                    <span className="ra-svc__flags">
                                                        {svc.require_auth && (
                                                            <Lock size={13} aria-label="Basic auth" />
                                                        )}
                                                        {svc.ssl_enabled && (
                                                            <ShieldCheck
                                                                size={13}
                                                                className="ra-flag--ssl"
                                                                aria-label="HTTPS"
                                                            />
                                                        )}
                                                    </span>
                                                </div>
                                                <div className="ra-svc__right">
                                                    <Pill kind={pillKind(svc.status)}>
                                                        {svc.status || 'unknown'}
                                                    </Pill>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="text-red-600"
                                                        onClick={() => unpublish(t.id, svc)}
                                                    >
                                                        Remove
                                                    </Button>
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </section>
                        );
                    })}
                </div>
            )}

            {/* Expose-a-service wizard */}
            <Modal
                open={wizardOpen}
                onClose={closeWizard}
                title="Expose a Local Service"
                size="lg"
                footer={
                    <>
                        <Button variant="outline" onClick={closeWizard} disabled={submitting}>
                            Cancel
                        </Button>
                        <Button onClick={submitWizard} disabled={!wizardValid || submitting}>
                            {submitting ? 'Publishing…' : 'Publish'}
                        </Button>
                    </>
                }
            >
                <div className="space-y-4">
                    {!wizardTunnel && (
                        <>
                            <div className="space-y-1.5">
                                <Label>Private host (where the service runs)</Label>
                                <Select value={form.privateServerId} onValueChange={(v) => setField('privateServerId', v)}>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Select a server" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {servers.map((s) => (
                                            <SelectItem key={s.id} value={s.id}>
                                                {s.name}{s.ip_address ? ` (${s.ip_address})` : ''}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-1.5">
                                <Label>Edge server (public IP — fronts the tunnel)</Label>
                                <Select value={form.edgeServerId} onValueChange={(v) => setField('edgeServerId', v)}>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Select a server" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {servers.map((s) => (
                                            <SelectItem key={s.id} value={s.id}>
                                                {s.name}{s.ip_address ? ` (${s.ip_address})` : ''}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <p className="text-xs text-muted-foreground">
                                    A tunnel between these two is created (or reused) automatically.
                                </p>
                            </div>
                        </>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div className="sm:col-span-2 space-y-1.5">
                            <Label>Public hostname</Label>
                            <Input
                                placeholder="jellyfin.example.com"
                                value={form.hostname}
                                onChange={(e) => setField('hostname', e.target.value)}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label>Service port</Label>
                            <Input
                                type="number"
                                placeholder="8096"
                                value={form.port}
                                onChange={(e) => setField('port', e.target.value)}
                            />
                        </div>
                    </div>

                    <div className="flex items-center justify-between">
                        <div>
                            <Label>HTTPS (Let&apos;s Encrypt)</Label>
                            <p className="text-xs text-muted-foreground">Obtain a certificate on the edge.</p>
                        </div>
                        <Switch checked={form.ssl} onCheckedChange={(v) => setField('ssl', v)} />
                    </div>

                    <div className="flex items-center justify-between">
                        <div>
                            <Label>Require login (basic auth)</Label>
                            <p className="text-xs text-muted-foreground">Put a username/password in front of the service.</p>
                        </div>
                        <Switch checked={form.requireAuth} onCheckedChange={(v) => setField('requireAuth', v)} />
                    </div>

                    {form.requireAuth && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                                <Label>Username</Label>
                                <Input
                                    value={form.authUsername}
                                    onChange={(e) => setField('authUsername', e.target.value)}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label>Password</Label>
                                <Input
                                    type="password"
                                    value={form.authPassword}
                                    onChange={(e) => setField('authPassword', e.target.value)}
                                />
                            </div>
                        </div>
                    )}
                </div>
            </Modal>

            {/* Tear-down confirmation */}
            <Modal
                open={!!teardown}
                onClose={() => setTeardown(null)}
                title="Tear down tunnel?"
                size="sm"
                footer={
                    <>
                        <Button variant="outline" onClick={() => setTeardown(null)}>
                            Cancel
                        </Button>
                        <Button variant="destructive" onClick={confirmTeardown}>
                            Tear down
                        </Button>
                    </>
                }
            >
                <p className="text-sm text-muted-foreground">
                    This removes the WireGuard tunnel{teardown ? ` between ${teardown.private_server_name || teardown.private_server_id} and ${teardown.edge_server_name || teardown.edge_server_id}` : ''} and any services published over it. The agents&apos; interfaces are brought down.
                </p>
            </Modal>
        </div>
    );
};

export default RemoteAccess;
