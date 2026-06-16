import { useState, useEffect, useCallback } from 'react';
import { Network, Plus, Trash2, Globe, Lock, ShieldCheck, ExternalLink } from 'lucide-react';
import api from '../services/api';
import { useToast } from '../contexts/ToastContext';
import Spinner from '../components/Spinner';
import Modal from '../components/Modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
    Select,
    SelectTrigger,
    SelectContent,
    SelectItem,
    SelectValue,
} from '@/components/ui/select';

const STATUS_STYLES = {
    up: 'text-green-600 border-green-500/40',
    pending: 'text-yellow-600 border-yellow-500/40',
    degraded: 'text-yellow-600 border-yellow-500/40',
    published: 'text-green-600 border-green-500/40',
    down: 'text-red-600 border-red-500/40',
    error: 'text-red-600 border-red-500/40',
};

function StatusBadge({ status }) {
    const cls = STATUS_STYLES[status] || 'text-muted-foreground border-border';
    return (
        <Badge variant="outline" className={cls}>
            {status || 'unknown'}
        </Badge>
    );
}

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

    return (
        <div className="p-6 max-w-6xl mx-auto">
            <div className="flex items-start justify-between gap-4 mb-6">
                <div>
                    <h1 className="text-2xl font-semibold flex items-center gap-2">
                        <Network className="w-6 h-6 text-primary" />
                        Remote Access
                    </h1>
                    <p className="text-muted-foreground mt-1 max-w-2xl">
                        Expose a service running on a private machine (behind NAT, no port-forwarding) to a public
                        hostname over a WireGuard tunnel between two of your agents.
                    </p>
                </div>
                <Button onClick={() => openWizard(null)} disabled={loading}>
                    <Plus className="w-4 h-4 mr-1" />
                    Expose a Local Service
                </Button>
            </div>

            {loading ? (
                <div className="flex justify-center py-16">
                    <Spinner />
                </div>
            ) : tunnels.length === 0 ? (
                <Card>
                    <CardContent className="py-16 flex flex-col items-center text-center gap-3">
                        <Network className="w-10 h-10 text-muted-foreground" />
                        <h2 className="text-lg font-medium">No tunnels yet</h2>
                        <p className="text-muted-foreground max-w-md">
                            Pick a public-IP edge server and a private host, and ServerKit will pair them over
                            WireGuard and publish your service — no router changes needed.
                        </p>
                        <Button onClick={() => openWizard(null)} className="mt-2">
                            <Plus className="w-4 h-4 mr-1" />
                            Expose a Local Service
                        </Button>
                    </CardContent>
                </Card>
            ) : (
                <div className="space-y-4">
                    {tunnels.map((t) => (
                        <Card key={t.id}>
                            <CardContent className="p-5">
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="font-medium">{t.private_server_name || t.private_server_id}</span>
                                            <span className="text-muted-foreground">→</span>
                                            <span className="font-medium">{t.edge_server_name || t.edge_server_id}</span>
                                            <StatusBadge status={t.status} />
                                        </div>
                                        <div className="text-sm text-muted-foreground mt-1">
                                            {t.subnet} · {t.interface_name} · UDP {t.listen_port}
                                            {t.last_handshake_at ? ` · handshake ${new Date(t.last_handshake_at).toLocaleString()}` : ' · no handshake yet'}
                                        </div>
                                        {!t.last_handshake_at && t.status !== 'up' && (
                                            <p className="text-xs text-yellow-600 mt-1">
                                                No handshake yet — if this persists, the private host&apos;s outbound UDP to the edge may be blocked (a relay is needed).
                                            </p>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        <Button variant="outline" size="sm" onClick={() => openWizard(t)}>
                                            <Plus className="w-4 h-4 mr-1" />
                                            Expose service
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="text-red-600"
                                            onClick={() => setTeardown(t)}
                                            title="Tear down tunnel"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </Button>
                                    </div>
                                </div>

                                <div className="mt-4 border-t border-border pt-3">
                                    {(services[t.id] || []).length === 0 ? (
                                        <p className="text-sm text-muted-foreground">No services exposed on this tunnel.</p>
                                    ) : (
                                        <ul className="space-y-2">
                                            {(services[t.id] || []).map((svc) => (
                                                <li key={svc.id} className="flex items-center justify-between gap-3">
                                                    <div className="flex items-center gap-2 min-w-0">
                                                        <Globe className="w-4 h-4 text-muted-foreground shrink-0" />
                                                        {svc.url ? (
                                                            <a
                                                                href={svc.url}
                                                                target="_blank"
                                                                rel="noreferrer"
                                                                className="text-primary hover:underline truncate inline-flex items-center gap-1"
                                                            >
                                                                {svc.hostname}
                                                                <ExternalLink className="w-3 h-3" />
                                                            </a>
                                                        ) : (
                                                            <span className="truncate">{svc.hostname}</span>
                                                        )}
                                                        <span className="text-muted-foreground text-sm">→ :{svc.port}</span>
                                                        {svc.require_auth && <Lock className="w-3 h-3 text-muted-foreground" title="Basic auth" />}
                                                        {svc.ssl_enabled && <ShieldCheck className="w-3 h-3 text-green-600" title="HTTPS" />}
                                                        <StatusBadge status={svc.status} />
                                                    </div>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="text-red-600 shrink-0"
                                                        onClick={() => unpublish(t.id, svc)}
                                                    >
                                                        Remove
                                                    </Button>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    ))}
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
