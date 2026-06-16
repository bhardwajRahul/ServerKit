import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Globe, Plus, ShieldCheck, RefreshCw, Trash2, ExternalLink,
    AlertTriangle, Clock, Lock, Search, ChevronRight, Network as NetworkIcon,
} from 'lucide-react';
import api from '../services/api';
import { useToast } from '../contexts/ToastContext';
import EmptyState from '../components/EmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Select, SelectTrigger, SelectContent, SelectItem, SelectValue,
} from '@/components/ui/select';
import { PageTopbar, MetricCard, SegControl, Pill, Drawer } from '@/components/ds';
import { DOMAIN_TABS } from '../components/domains/domainTabs';
import RegistrarPortfolio from '../components/domains/RegistrarPortfolio';

const Domains = () => {
    const toast = useToast();
    const navigate = useNavigate();
    const [domains, setDomains] = useState([]);
    const [apps, setApps] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [filter, setFilter] = useState('all');
    const [drawerDomain, setDrawerDomain] = useState(null);

    // Inline DNS records for the open drawer domain
    const [dnsRecords, setDnsRecords] = useState([]);
    const [dnsLoading, setDnsLoading] = useState(false);
    const [dnsError, setDnsError] = useState('');
    const [dnsHasZone, setDnsHasZone] = useState(true);

    // Modal states
    const [showAddModal, setShowAddModal] = useState(false);
    const [showSslModal, setShowSslModal] = useState(false);
    const [selectedDomain, setSelectedDomain] = useState(null);

    // Form states
    const [domainName, setDomainName] = useState('');
    const [selectedAppId, setSelectedAppId] = useState('');
    const [isPrimary, setIsPrimary] = useState(false);
    const [sslEmail, setSslEmail] = useState('');
    const [actionLoading, setActionLoading] = useState(false);

    useEffect(() => {
        loadData();
    }, []);

    // Load DNS records for the domain shown in the drawer. A domain has no zone
    // reference, so we match it to a DNS zone by name; unmanaged domains have no
    // zone and fall back to the empty/hint state rather than erroring.
    useEffect(() => {
        if (!drawerDomain) return;
        let cancelled = false;
        const domainName = drawerDomain.name;

        async function loadDnsRecords() {
            setDnsLoading(true);
            setDnsError('');
            setDnsRecords([]);
            setDnsHasZone(true);
            try {
                const zonesData = await api.getDNSZones();
                const zone = (zonesData.zones || []).find(z => z.domain === domainName);
                if (cancelled) return;
                if (!zone) {
                    setDnsHasZone(false);
                    return;
                }
                const recordsData = await api.getDNSRecords(zone.id);
                if (cancelled) return;
                setDnsRecords(recordsData.records || []);
            } catch {
                if (!cancelled) setDnsError('Failed to load DNS records');
            } finally {
                if (!cancelled) setDnsLoading(false);
            }
        }

        loadDnsRecords();
        return () => { cancelled = true; };
    }, [drawerDomain]);

    async function loadData() {
        try {
            setLoading(true);
            const timeout = (promise, ms) => Promise.race([
                promise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('Request timeout')), ms)),
            ]);
            const [domainsData, appsData] = await Promise.all([
                timeout(api.getDomains(), 10000).catch(() => ({ domains: [] })),
                timeout(api.getApps(), 10000).catch(() => ({ apps: [] })),
            ]);
            setDomains(domainsData.domains || []);
            setApps(appsData.apps || []);
        } catch (err) {
            setError('Failed to load data');
            console.error(err);
        } finally {
            setLoading(false);
        }
    }

    async function handleAddDomain(e) {
        e.preventDefault();
        if (!domainName || !selectedAppId) return;
        try {
            setActionLoading(true);
            await api.createDomain({
                name: domainName,
                application_id: parseInt(selectedAppId),
                is_primary: isPrimary,
            });
            setShowAddModal(false);
            setDomainName('');
            setSelectedAppId('');
            setIsPrimary(false);
            loadData();
        } catch (err) {
            setError(err.message);
        } finally {
            setActionLoading(false);
        }
    }

    async function handleDeleteDomain(domain) {
        if (!confirm(`Are you sure you want to delete ${domain.name}?`)) return;
        try {
            await api.deleteDomain(domain.id);
            loadData();
        } catch (err) {
            setError(err.message);
        }
    }

    async function handleEnableSsl(e) {
        e.preventDefault();
        if (!selectedDomain || !sslEmail) return;
        try {
            setActionLoading(true);
            await api.enableSsl(selectedDomain.id, sslEmail);
            setShowSslModal(false);
            setSslEmail('');
            setSelectedDomain(null);
            loadData();
        } catch (err) {
            setError(err.message);
        } finally {
            setActionLoading(false);
        }
    }

    async function handleDisableSsl(domain) {
        if (!confirm(`Disable SSL for ${domain.name}?`)) return;
        try {
            await api.disableSsl(domain.id);
            loadData();
        } catch (err) {
            setError(err.message);
        }
    }

    async function handleRenewSsl(domain) {
        try {
            setActionLoading(true);
            await api.renewDomainSsl(domain.id);
            loadData();
        } catch (err) {
            setError(err.message);
        } finally {
            setActionLoading(false);
        }
    }

    async function handleVerifyDomain(domain) {
        try {
            const result = await api.verifyDomain(domain.id);
            if (result.verified) {
                toast.success(`Domain verified! IP: ${result.ip_address}`);
            } else {
                toast.error(`Domain verification failed: ${result.error}`);
            }
        } catch (err) {
            setError(err.message);
        }
    }

    function getAppName(appId) {
        const app = apps.find(a => a.id === appId);
        return app ? app.name : 'Unknown';
    }

    // ── SSL state helpers ────────────────────────────────────
    function sslDays(d) {
        if (!d.ssl_enabled || !d.ssl_expires_at) return null;
        const ms = new Date(d.ssl_expires_at).getTime() - Date.now();
        if (Number.isNaN(ms)) return null;
        return Math.max(0, Math.round(ms / 86400000));
    }
    function sslState(d) {
        if (!d.ssl_enabled) return 'none';
        const days = sslDays(d);
        return days != null && days < 30 ? 'expiring' : 'valid';
    }
    function sslPill(d) {
        const st = sslState(d);
        const days = sslDays(d);
        if (st === 'valid') return <Pill kind="green">{days != null ? `Valid · ${days}d` : 'Valid'}</Pill>;
        if (st === 'expiring') return <Pill kind="amber">Expires {days}d</Pill>;
        return <Pill kind="gray">No SSL</Pill>;
    }

    const sslActiveCount = domains.filter(d => d.ssl_enabled).length;
    const expiringCount = domains.filter(d => sslState(d) === 'expiring').length;
    const attentionCount = domains.filter(d => !d.ssl_enabled).length;

    const shown = domains.filter(d => (
        filter === 'all' ? true
            : filter === 'ssl' ? sslState(d) === 'expiring'
                : filter === 'issues' ? !d.ssl_enabled : true
    ));

    return (
        <div className="page-container domains-page">
            <PageTopbar
                icon={<Globe size={18} />}
                title="Domains"
                tabs={DOMAIN_TABS}
                actions={(
                    <>
                        <Button variant="outline" size="sm" onClick={loadData}>
                            <RefreshCw size={15} /> Check DNS
                        </Button>
                        <Button size="sm" onClick={() => setShowAddModal(true)}>
                            <Plus size={15} /> Add domain
                        </Button>
                    </>
                )}
            />

            <RegistrarPortfolio />

            {error && (
                <div className="error-banner">
                    {error}
                    <button onClick={() => setError('')} style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
                </div>
            )}

            {loading ? (
                <EmptyState loading title="Loading domains..." />
            ) : domains.length === 0 ? (
                <EmptyState
                    icon={Globe}
                    title="No domains configured"
                    description="Add a domain to your application to get started."
                    action={<Button onClick={() => setShowAddModal(true)}><Plus size={16} /> Add Domain</Button>}
                />
            ) : (
                <div className="domains-body">
                    <div className="dom-kpis">
                        <MetricCard tone="accent" icon={<Globe size={16} />} value={domains.length} label="Domains" />
                        <MetricCard tone="green" icon={<Lock size={16} />} value={sslActiveCount} label="SSL active" />
                        <MetricCard tone="amber" icon={<Clock size={16} />} value={expiringCount} label="Expiring ≤30d" />
                        <MetricCard tone="red" icon={<AlertTriangle size={16} />} value={attentionCount} label="Needs attention" />
                    </div>

                    <div className="dom-listhead">
                        <h2 className="dom-listhead__title">All domains</h2>
                        <SegControl
                            value={filter}
                            onChange={setFilter}
                            options={[
                                { value: 'all', label: 'All' },
                                { value: 'ssl', label: 'Expiring SSL' },
                                { value: 'issues', label: 'Attention' },
                            ]}
                        />
                    </div>

                    {shown.length === 0 ? (
                        <div className="dom-empty">No domains match this filter.</div>
                    ) : (
                        <div className="dom-card">
                            <table className="sk-dtable">
                                <thead>
                                    <tr>
                                        <th>Domain</th>
                                        <th>Linked site</th>
                                        <th>SSL</th>
                                        <th>Auto-renew</th>
                                        <th>Status</th>
                                        <th style={{ width: 30 }} />
                                    </tr>
                                </thead>
                                <tbody>
                                    {shown.map(d => (
                                        <tr key={d.id} className="is-clickable" onClick={() => setDrawerDomain(d)}>
                                            <td>
                                                <div className="sk-cell-name">
                                                    <span className="dom-fav"><Globe size={15} /></span>
                                                    <span>
                                                        {d.name}
                                                        {d.is_primary && <span className="dom-primary">Primary</span>}
                                                    </span>
                                                </div>
                                            </td>
                                            <td>
                                                {d.application_id
                                                    ? <span className="sk-tag">{getAppName(d.application_id)}</span>
                                                    : <span className="dom-dash">—</span>}
                                            </td>
                                            <td>{sslPill(d)}</td>
                                            <td>
                                                {d.ssl_enabled
                                                    ? (d.ssl_auto_renew ? <Pill kind="green">on</Pill> : <Pill kind="gray">off</Pill>)
                                                    : <span className="dom-dash">—</span>}
                                            </td>
                                            <td><Pill kind={d.ssl_enabled ? 'green' : 'amber'}>{d.ssl_enabled ? 'active' : 'unconfigured'}</Pill></td>
                                            <td><ChevronRight size={16} className="dom-chev" /></td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {/* ── Detail drawer ──────────────────────────────── */}
            <Drawer
                open={!!drawerDomain}
                onOpenChange={(open) => { if (!open) setDrawerDomain(null); }}
                icon={<Globe size={18} />}
                iconColor="var(--accent-bright)"
                title={drawerDomain?.name || ''}
                subtitle={drawerDomain
                    ? `${drawerDomain.application_id ? getAppName(drawerDomain.application_id) : 'unlinked'} · ${sslState(drawerDomain)}`
                    : ''}
                width={640}
            >
                {drawerDomain && (
                    <div className="dom-drawer">
                        <div className="dom-drawer__actions">
                            <Button variant="outline" size="sm" asChild>
                                <a href={`${drawerDomain.ssl_enabled ? 'https' : 'http'}://${drawerDomain.name}`} target="_blank" rel="noopener noreferrer">
                                    <ExternalLink size={14} /> Visit
                                </a>
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => handleVerifyDomain(drawerDomain)}>
                                <Search size={14} /> Verify DNS
                            </Button>
                            {drawerDomain.ssl_enabled ? (
                                <>
                                    <Button variant="outline" size="sm" disabled={actionLoading} onClick={() => handleRenewSsl(drawerDomain)}>
                                        <RefreshCw size={14} /> Renew SSL
                                    </Button>
                                    <Button variant="outline" size="sm" onClick={() => handleDisableSsl(drawerDomain)}>
                                        <Lock size={14} /> Disable SSL
                                    </Button>
                                </>
                            ) : (
                                <Button size="sm" onClick={() => { setSelectedDomain(drawerDomain); setShowSslModal(true); setDrawerDomain(null); }}>
                                    <Lock size={14} /> Enable SSL
                                </Button>
                            )}
                        </div>

                        <div className="dom-specs">
                            <div className="sk-spec-card">
                                <div className="sk-spec-card__label">SSL certificate</div>
                                <div style={{ marginTop: 8 }}>{sslPill(drawerDomain)}</div>
                                <div className="sk-spec-card__sub">
                                    {drawerDomain.ssl_enabled
                                        ? (drawerDomain.ssl_expires_at ? `Expires ${new Date(drawerDomain.ssl_expires_at).toLocaleDateString()}` : "Let's Encrypt")
                                        : 'Not issued'}
                                </div>
                            </div>
                            <div className="sk-spec-card">
                                <div className="sk-spec-card__label">Linked site</div>
                                <div className="sk-spec-card__value">{drawerDomain.application_id ? getAppName(drawerDomain.application_id) : 'Unlinked'}</div>
                                <div className="sk-spec-card__sub">{drawerDomain.is_primary ? 'Primary domain' : 'Alias'}</div>
                            </div>
                            <div className="sk-spec-card">
                                <div className="sk-spec-card__label">Status</div>
                                <div style={{ marginTop: 8 }}>
                                    <Pill kind={drawerDomain.ssl_enabled ? 'green' : 'amber'}>{drawerDomain.ssl_enabled ? 'active' : 'unconfigured'}</Pill>
                                </div>
                                <div className="sk-spec-card__sub">Auto-renew {drawerDomain.ssl_auto_renew ? 'on' : 'off'}</div>
                            </div>
                        </div>

                        <div className="dom-drawer__section dom-dns">
                            <h3 className="dom-drawer__sectiontitle">
                                DNS records
                                {dnsHasZone && !dnsLoading && !dnsError && (
                                    <span className="dom-dns__count">· {dnsRecords.length}</span>
                                )}
                            </h3>

                            {dnsLoading ? (
                                <p className="dom-drawer__hint">Loading DNS records…</p>
                            ) : dnsError ? (
                                <p className="dom-drawer__hint dom-dns__error">{dnsError}</p>
                            ) : !dnsHasZone ? (
                                <p className="dom-drawer__hint">No DNS records — this domain isn&apos;t managed in DNS Zones.</p>
                            ) : dnsRecords.length === 0 ? (
                                <p className="dom-drawer__hint">No DNS records.</p>
                            ) : (
                                <div className="dom-dns__table">
                                    <table className="sk-dtable">
                                        <thead>
                                            <tr>
                                                <th className="dom-dns__col-type">Type</th>
                                                <th>Name</th>
                                                <th>Value</th>
                                                <th className="dom-dns__col-ttl">TTL</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {dnsRecords.map(rec => (
                                                <tr key={rec.id}>
                                                    <td>
                                                        <span className={`dns-rtype dns-rtype--${(rec.record_type || '').toLowerCase()}`}>
                                                            {rec.record_type}
                                                        </span>
                                                    </td>
                                                    <td className="sk-cell-mono">{rec.name}</td>
                                                    <td className="sk-cell-mono dom-dns__value">
                                                        {rec.priority ? `${rec.priority} ` : ''}{rec.content}
                                                    </td>
                                                    <td className="sk-cell-mono">{rec.ttl}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}

                            <Button variant="outline" size="sm" onClick={() => navigate('/dns')}>
                                <NetworkIcon size={14} /> Manage DNS records
                            </Button>
                        </div>

                        <div className="dom-drawer__danger">
                            <Button variant="outline" size="sm" className="dom-delete-btn" onClick={() => { handleDeleteDomain(drawerDomain); setDrawerDomain(null); }}>
                                <Trash2 size={14} /> Delete domain
                            </Button>
                        </div>
                    </div>
                )}
            </Drawer>

            {/* ── Add Domain Modal ───────────────────────────── */}
            {showAddModal && (
                <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
                    <div className="modal" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2>Add Domain</h2>
                            <button className="modal-close" onClick={() => setShowAddModal(false)}>×</button>
                        </div>
                        <form onSubmit={handleAddDomain}>
                            <div className="form-group">
                                <Label>Domain Name</Label>
                                <Input type="text" placeholder="example.com" value={domainName} onChange={e => setDomainName(e.target.value)} required />
                            </div>
                            <div className="form-group">
                                <Label>Application</Label>
                                <Select value={selectedAppId} onValueChange={setSelectedAppId} required>
                                    <SelectTrigger><SelectValue placeholder="Select an application" /></SelectTrigger>
                                    <SelectContent>
                                        {apps.map(app => (
                                            <SelectItem key={app.id} value={String(app.id)}>{app.name}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="form-group">
                                <label className="checkbox-label">
                                    <Checkbox checked={isPrimary} onCheckedChange={setIsPrimary} />
                                    Set as primary domain
                                </label>
                            </div>
                            <div className="modal-actions">
                                <Button type="button" variant="outline" onClick={() => setShowAddModal(false)}>Cancel</Button>
                                <Button type="submit" disabled={actionLoading}>{actionLoading ? 'Adding...' : 'Add Domain'}</Button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* ── Enable SSL Modal ───────────────────────────── */}
            {showSslModal && selectedDomain && (
                <div className="modal-overlay" onClick={() => setShowSslModal(false)}>
                    <div className="modal" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2>Enable SSL Certificate</h2>
                            <button className="modal-close" onClick={() => setShowSslModal(false)}>×</button>
                        </div>
                        <form onSubmit={handleEnableSsl}>
                            <div className="ssl-info-box">
                                <ShieldCheck size={32} />
                                <div>
                                    <h4>Free SSL from Let&apos;s Encrypt</h4>
                                    <p>A free SSL certificate will be obtained for <strong>{selectedDomain.name}</strong></p>
                                </div>
                            </div>
                            <div className="form-group">
                                <Label>Email Address</Label>
                                <Input type="email" placeholder="admin@example.com" value={sslEmail} onChange={e => setSslEmail(e.target.value)} required />
                                <p className="hint">Required for certificate expiration notifications</p>
                            </div>
                            <div className="modal-actions">
                                <Button type="button" variant="outline" onClick={() => setShowSslModal(false)}>Cancel</Button>
                                <Button type="submit" disabled={actionLoading}>{actionLoading ? 'Obtaining Certificate...' : 'Enable SSL'}</Button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
};

export default Domains;
