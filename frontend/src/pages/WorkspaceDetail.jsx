import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import api from '../services/api';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';
import Spinner from '../components/Spinner';
import ConfirmDialog from '../components/ConfirmDialog';
import EmptyState from '../components/EmptyState';
import { Pill, ServiceTile, SegControl } from '@/components/ds';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
    LayoutGrid, ChevronLeft, ChevronRight, Check, Server, Box, Globe,
    Users, Settings2, Plus, Archive, ArchiveRestore, Trash2,
} from 'lucide-react';

// Mirrors WorkspaceSwitcher: the active workspace lives in localStorage and is
// sent ambiently as the X-Workspace-Id header; switching reloads so every page
// re-fetches under the new scope.
const ACTIVE_KEY = 'active_workspace_id';
const ACCENT_KEY = 'workspace_accent';

const formatSince = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
        ? null
        : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
};

const SERVER_PILL = { online: 'green', pending: 'amber', offline: 'red' };
const APP_PILL = { running: 'green', stopped: 'gray', failed: 'red' };

const WorkspaceDetail = () => {
    const { id } = useParams();
    const wsId = Number(id);
    const navigate = useNavigate();
    const toast = useToast();
    const { user } = useAuth();

    const [ws, setWs] = useState(null);
    const [members, setMembers] = useState([]);
    const [apps, setApps] = useState([]);
    const [servers, setServers] = useState([]);
    const [allUsers, setAllUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [tab, setTab] = useState('servers');
    const [showEdit, setShowEdit] = useState(false);
    const [form, setForm] = useState(null);
    const [deleteConfirm, setDeleteConfirm] = useState(false);
    const [sharingApp, setSharingApp] = useState(null);
    const [grants, setGrants] = useState([]);
    const [grantRole, setGrantRole] = useState('editor');

    const asServerList = (data) => (Array.isArray(data) ? data : (data?.servers || []));

    const load = useCallback(async () => {
        try {
            // allWorkspaces neutralizes the ambient X-Workspace-Id header so the
            // move-in pickers can see resources living in other workspaces.
            const [wsData, mData, appData, srvData, uData] = await Promise.all([
                api.getWorkspace(wsId),
                api.getWorkspaceMembers(wsId).catch(() => ({ members: [] })),
                api.getApps({ allWorkspaces: true }).catch(() => ({ apps: [] })),
                api.getServers({ allWorkspaces: true }).catch(() => []),
                api.getUsers().catch(() => ({ users: [] })),
            ]);
            setWs(wsData);
            setMembers(mData.members || []);
            setApps(appData.apps || []);
            setServers(asServerList(srvData));
            setAllUsers(uData.users || []);
        } catch (err) {
            toast.error('Failed to load workspace');
            setWs(null);
        } finally {
            setLoading(false);
        }
    }, [wsId, toast]);

    useEffect(() => { setLoading(true); load(); }, [load]);

    const isCurrent = localStorage.getItem(ACTIVE_KEY) === String(wsId);

    const setActiveWorkspace = () => {
        localStorage.setItem(ACTIVE_KEY, String(wsId));
        if (ws?.primary_color) localStorage.setItem(ACCENT_KEY, ws.primary_color);
        else localStorage.removeItem(ACCENT_KEY);
        window.location.reload();
    };

    const handleArchive = async () => {
        try {
            await api.archiveWorkspace(wsId);
            toast.success('Workspace archived');
            load();
        } catch (err) { toast.error(err.message); }
    };

    const handleRestore = async () => {
        try {
            await api.restoreWorkspace(wsId);
            toast.success('Workspace restored');
            load();
        } catch (err) { toast.error(err.message); }
    };

    const handleDelete = async () => {
        try {
            await api.deleteWorkspace(wsId);
            toast.success('Workspace deleted');
            navigate('/workspaces');
        } catch (err) { toast.error(err.message); }
    };

    const openEdit = () => {
        setForm({
            name: ws.name,
            description: ws.description || '',
            max_servers: ws.max_servers || 0,
            max_users: ws.max_users || 0,
            primary_color: ws.primary_color || '#6d7cff',
        });
        setShowEdit(true);
    };

    const handleSave = async () => {
        try {
            await api.updateWorkspace(wsId, form);
            toast.success('Workspace updated');
            setShowEdit(false);
            load();
        } catch (err) { toast.error(err.message); }
    };

    const handleAddMember = async (userId) => {
        try {
            await api.addWorkspaceMember(wsId, userId);
            toast.success('Member added');
            load();
        } catch (err) { toast.error(err.message); }
    };

    const handleRemoveMember = async (memberId) => {
        try {
            await api.removeWorkspaceMember(memberId);
            toast.success('Member removed');
            load();
        } catch (err) { toast.error(err.message); }
    };

    const handleMoveApp = async (appId, workspaceId) => {
        try {
            await api.setAppWorkspace(appId, workspaceId);
            toast.success(workspaceId ? 'Application moved in' : 'Application removed');
            const data = await api.getApps({ allWorkspaces: true });
            setApps(data.apps || []);
        } catch (err) { toast.error(err.message); }
    };

    const handleMoveServer = async (serverId, workspaceId) => {
        try {
            await api.setServerWorkspace(serverId, workspaceId);
            toast.success(workspaceId ? 'Server moved in' : 'Server removed');
            setServers(asServerList(await api.getServers({ allWorkspaces: true })));
        } catch (err) { toast.error(err.message); }
    };

    // Per-app sharing (#33 per-site ACL), re-homed from the old list-page modal.
    const loadSharing = async (appObj) => {
        try {
            const gData = await api.getAppGrants(appObj.id);
            setGrants(gData.grants || []);
            setSharingApp(appObj);
        } catch (err) { toast.error('Failed to load sharing'); }
    };

    const handleGrant = async (userId) => {
        try {
            await api.grantAppAccess(sharingApp.id, userId, grantRole);
            toast.success('Access granted');
            const gData = await api.getAppGrants(sharingApp.id);
            setGrants(gData.grants || []);
        } catch (err) { toast.error(err.message); }
    };

    const handleRevoke = async (grantId) => {
        try {
            await api.revokeAppAccess(sharingApp.id, grantId);
            toast.success('Access revoked');
            const gData = await api.getAppGrants(sharingApp.id);
            setGrants(gData.grants || []);
        } catch (err) { toast.error(err.message); }
    };

    if (loading) return <Spinner />;

    if (!ws) {
        return (
            <div className="page-container workspaces-page ws-detail">
                <Link className="ws-detail__back" to="/workspaces"><ChevronLeft size={14} /> All workspaces</Link>
                <EmptyState icon={LayoutGrid} title="Workspace not found" description="It may have been deleted, or you may not have access." />
            </div>
        );
    }

    const appsIn = apps.filter(a => a.workspace_id === wsId);
    const appsOut = apps.filter(a => a.workspace_id !== wsId);
    const srvIn = servers.filter(s => s.workspace_id === wsId);
    const srvOut = servers.filter(s => s.workspace_id !== wsId);
    const services = appsIn.filter(a => a.app_type !== 'wordpress');
    const sites = appsIn.filter(a => a.app_type === 'wordpress');
    const since = formatSince(ws.created_at);

    const tabs = [
        { key: 'servers', label: 'Servers', icon: Server, count: srvIn.length },
        { key: 'services', label: 'Services', icon: Box, count: services.length },
        { key: 'sites', label: 'Sites', icon: Globe, count: sites.length },
        { key: 'members', label: 'Members', icon: Users, count: members.length },
    ];

    const appRows = (list) => (
        list.length === 0 ? (
            <EmptyState icon={tab === 'sites' ? Globe : Box} title={`No ${tab} in this workspace yet`} description="Move one in below." />
        ) : (
            <div className="ws-detail__tablecard">
                <table className="sk-dtable">
                    <thead>
                        <tr><th>{tab === 'sites' ? 'Site' : 'Service'}</th><th>Status</th><th style={{ width: 220 }} /></tr>
                    </thead>
                    <tbody>
                        {list.map(a => (
                            <tr key={a.id} className="is-clickable" onClick={() => navigate(`/services/${a.id}`)}>
                                <td>
                                    <div className="sk-cell-name">
                                        <ServiceTile name={a.name} size={30} />
                                        <div>
                                            <div>{a.name}</div>
                                            <div className="sk-cell-sub">{a.app_type}{a.domain ? ` · ${a.domain}` : ''}</div>
                                        </div>
                                    </div>
                                </td>
                                <td><Pill kind={APP_PILL[a.status] || 'amber'}>{a.status || 'unknown'}</Pill></td>
                                <td onClick={e => e.stopPropagation()}>
                                    <div className="ws-detail__rowactions">
                                        <Button size="sm" variant="outline" onClick={() => loadSharing(a)}>Share</Button>
                                        <Button size="sm" variant="destructive" onClick={() => handleMoveApp(a.id, null)}>Remove</Button>
                                        <span className="ws-detail__manage" onClick={() => navigate(`/services/${a.id}`)}>
                                            Manage <ChevronRight size={13} />
                                        </span>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        )
    );

    const movePicker = (label, items, render, onPick) => items.length > 0 && (
        <>
            <div className="ws-pick-label">{label}</div>
            <div className="ws-pick">
                {items.map(item => (
                    <div key={item.id} className="ws-pick__item" onClick={() => onPick(item)}>
                        {render(item)}
                        <Plus size={14} className="ws-pick__plus" />
                    </div>
                ))}
            </div>
        </>
    );

    return (
        <div className="page-container workspaces-page ws-detail">
            <Link className="ws-detail__back" to="/workspaces"><ChevronLeft size={14} /> All workspaces</Link>

            <header className="ws-detail__header">
                <ServiceTile name={ws.name} size={54} gradient={ws.primary_color || undefined} className="ws-detail__tile" />
                <div className="ws-detail__info">
                    <div className="ws-detail__title">
                        <h1>{ws.name}</h1>
                        {isCurrent
                            ? <Pill kind="green">active workspace</Pill>
                            : <Pill kind={ws.status === 'active' ? 'green' : 'amber'}>{ws.status}</Pill>}
                    </div>
                    <div className="ws-detail__meta">
                        <span>/{ws.slug}</span>
                        <span className="dotsep">·</span>
                        <span>{members.length} member{members.length !== 1 ? 's' : ''}</span>
                        {since && <><span className="dotsep">·</span><span>since {since}</span></>}
                    </div>
                </div>
                <div className="ws-detail__actions">
                    {!isCurrent && ws.status === 'active' && (
                        <Button size="sm" onClick={setActiveWorkspace}><Check size={15} /> Set active</Button>
                    )}
                    <Button size="sm" variant="outline" onClick={openEdit}><Settings2 size={15} /> Settings</Button>
                    {ws.status === 'active'
                        ? <Button size="sm" variant="secondary" onClick={handleArchive}><Archive size={15} /> Archive</Button>
                        : <Button size="sm" variant="secondary" onClick={handleRestore}><ArchiveRestore size={15} /> Restore</Button>}
                    {user?.is_admin && (
                        <Button size="sm" variant="destructive" onClick={() => setDeleteConfirm(true)}><Trash2 size={15} /></Button>
                    )}
                </div>
            </header>

            {ws.description && <p className="ws-detail__desc">{ws.description}</p>}

            <div className="ws-detail__grid">
                <section className="ws-detail__card">
                    <h3>Workspace</h3>
                    <div className="sk-info-row"><span className="k">Slug</span><span className="v">/{ws.slug}</span></div>
                    <div className="sk-info-row"><span className="k">Created</span><span className="v">{since || '—'}</span></div>
                    <div className="sk-info-row"><span className="k">Max servers</span><span className="v">{ws.max_servers > 0 ? ws.max_servers : 'Unlimited'}</span></div>
                    <div className="sk-info-row"><span className="k">Max users</span><span className="v">{ws.max_users > 0 ? ws.max_users : 'Unlimited'}</span></div>
                </section>
                <section className="ws-detail__card">
                    <h3>Resources</h3>
                    <div className="ws-card__stats ws-detail__stats">
                        <div><div className="v">{srvIn.length}</div><div className="l">Servers</div></div>
                        <div><div className="v">{services.length}</div><div className="l">Services</div></div>
                        <div><div className="v">{sites.length}</div><div className="l">Sites</div></div>
                        <div><div className="v">{members.length}</div><div className="l">Members</div></div>
                    </div>
                </section>
            </div>

            <nav className="ws-detail__tabs" aria-label="Workspace sections">
                {tabs.map(t => (
                    <button
                        key={t.key}
                        type="button"
                        className={`ws-detail__tab ${tab === t.key ? 'is-active' : ''}`}
                        onClick={() => setTab(t.key)}
                    >
                        <t.icon size={15} /> {t.label} <span className="ws-detail__tabcount">{t.count}</span>
                    </button>
                ))}
            </nav>

            <div className="ws-detail__pane">
                {tab === 'servers' && (
                    <>
                        {srvIn.length === 0 ? (
                            <EmptyState icon={Server} title="No servers in this workspace yet" description="Move one in below." />
                        ) : (
                            <div className="ws-detail__tablecard">
                                <table className="sk-dtable">
                                    <thead><tr><th>Server</th><th>Status</th><th style={{ width: 160 }} /></tr></thead>
                                    <tbody>
                                        {srvIn.map(s => (
                                            <tr key={s.id} className="is-clickable" onClick={() => navigate(`/servers/${s.id}`)}>
                                                <td>
                                                    <div className="sk-cell-name">
                                                        <ServiceTile name={s.name} size={30} />
                                                        <div>
                                                            <div>{s.name}</div>
                                                            <div className="sk-cell-sub">{s.ip_address || s.hostname || ''}</div>
                                                        </div>
                                                    </div>
                                                </td>
                                                <td><Pill kind={SERVER_PILL[s.status] || 'gray'}>{s.status || 'unknown'}</Pill></td>
                                                <td onClick={e => e.stopPropagation()}>
                                                    <div className="ws-detail__rowactions">
                                                        <Button size="sm" variant="destructive" onClick={() => handleMoveServer(s.id, null)}>Remove</Button>
                                                        <span className="ws-detail__manage" onClick={() => navigate(`/servers/${s.id}`)}>
                                                            Manage <ChevronRight size={13} />
                                                        </span>
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                        {movePicker(
                            'Move a server into this workspace',
                            srvOut,
                            s => <span className="ws-pick__name">{s.name}</span>,
                            s => handleMoveServer(s.id, wsId),
                        )}
                    </>
                )}

                {(tab === 'services' || tab === 'sites') && (
                    <>
                        {appRows(tab === 'services' ? services : sites)}
                        {movePicker(
                            `Move ${tab === 'sites' ? 'a site' : 'an application'} into this workspace`,
                            appsOut.filter(a => (tab === 'sites') === (a.app_type === 'wordpress')),
                            a => <><span className="ws-pick__name">{a.name}</span><span className="sk-tag">{a.app_type}</span></>,
                            a => handleMoveApp(a.id, wsId),
                        )}
                    </>
                )}

                {tab === 'members' && (
                    <>
                        <div className="ws-detail__tablecard">
                            <table className="sk-dtable">
                                <thead><tr><th>Member</th><th>Role</th><th style={{ width: 120 }} /></tr></thead>
                                <tbody>
                                    {members.map(m => (
                                        <tr key={m.id}>
                                            <td>
                                                <div className="sk-cell-name">
                                                    <ServiceTile name={m.username || m.email || '?'} size={30} className="ws-row__av" />
                                                    <div>
                                                        <div>{m.username || m.email}</div>
                                                        {m.username && m.email && <div className="sk-cell-sub">{m.email}</div>}
                                                    </div>
                                                </div>
                                            </td>
                                            <td>
                                                {m.role === 'owner'
                                                    ? <Pill kind="green">{m.role}</Pill>
                                                    : <span className="sk-tag">{m.role}</span>}
                                            </td>
                                            <td>
                                                {m.role !== 'owner' && (
                                                    <Button size="sm" variant="destructive" onClick={() => handleRemoveMember(m.id)}>Remove</Button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {movePicker(
                            'Add a member',
                            allUsers.filter(u => !members.find(m => m.user_id === u.id)),
                            u => (
                                <>
                                    <ServiceTile name={u.username || u.email || '?'} size={24} className="ws-row__av" />
                                    <span className="ws-pick__name">{u.username || u.email}</span>
                                </>
                            ),
                            u => handleAddMember(u.id),
                        )}
                    </>
                )}
            </div>

            {showEdit && form && (
                <div className="modal-overlay" onClick={() => setShowEdit(false)}>
                    <div className="modal" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2>Workspace Settings</h2>
                            <button className="modal-close" onClick={() => setShowEdit(false)}>&times;</button>
                        </div>
                        <div className="modal-body">
                            <div className="form-group">
                                <label>Name</label>
                                <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
                            </div>
                            <div className="form-group">
                                <label>Description</label>
                                <Textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} rows={2} />
                            </div>
                            <div className="form-row">
                                <div className="form-group">
                                    <label>Max Servers (0 = unlimited)</label>
                                    <Input type="number" value={form.max_servers} onChange={e => setForm({ ...form, max_servers: parseInt(e.target.value) || 0 })} />
                                </div>
                                <div className="form-group">
                                    <label>Max Users (0 = unlimited)</label>
                                    <Input type="number" value={form.max_users} onChange={e => setForm({ ...form, max_users: parseInt(e.target.value) || 0 })} />
                                </div>
                            </div>
                            <div className="form-group">
                                <label>Brand Color</label>
                                <input
                                    type="color"
                                    className="workspace-color-input"
                                    value={form.primary_color}
                                    onChange={e => setForm({ ...form, primary_color: e.target.value })}
                                    aria-label="Workspace brand color"
                                />
                                <span className="form-hint">Recolors the panel for anyone viewing this workspace.</span>
                            </div>
                        </div>
                        <div className="modal-footer">
                            <Button variant="outline" onClick={() => setShowEdit(false)}>Cancel</Button>
                            <Button onClick={handleSave} disabled={!form.name}>Save</Button>
                        </div>
                    </div>
                </div>
            )}

            {sharingApp && (
                <div className="modal-overlay" onClick={() => setSharingApp(null)}>
                    <div className="modal" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2>Sharing: {sharingApp.name}</h2>
                            <button className="modal-close" onClick={() => setSharingApp(null)}>&times;</button>
                        </div>
                        <div className="modal-body">
                            <p className="form-hint">Grant a user access to this application (and its WordPress site, databases, and domains) without transferring ownership.</p>
                            <div className="ws-rows">
                                {grants.length === 0 && <p className="form-hint">Not shared with anyone yet.</p>}
                                {grants.map(g => (
                                    <div key={g.id} className="ws-row">
                                        <ServiceTile name={g.username || g.email || '?'} size={28} className="ws-row__av" />
                                        <div className="ws-row__id">
                                            <strong>{g.username || g.email}</strong>
                                            <span className="sk-tag">{g.role}</span>
                                        </div>
                                        <Button size="sm" variant="destructive" onClick={() => handleRevoke(g.id)}>Revoke</Button>
                                    </div>
                                ))}
                            </div>
                            <hr />
                            <h4>Grant Access</h4>
                            <div className="form-group">
                                <label>Role for new grants</label>
                                <SegControl
                                    value={grantRole}
                                    onChange={setGrantRole}
                                    options={[
                                        { value: 'editor', label: 'Editor · view + operate' },
                                        { value: 'viewer', label: 'Viewer · read-only' },
                                    ]}
                                />
                            </div>
                            <div className="ws-pick">
                                {allUsers.filter(u => u.id !== sharingApp.user_id && !grants.find(g => g.user_id === u.id)).map(u => (
                                    <div key={u.id} className="ws-pick__item" onClick={() => handleGrant(u.id)}>
                                        <ServiceTile name={u.username || u.email || '?'} size={24} className="ws-row__av" />
                                        <span className="ws-pick__name">{u.username || u.email}</span>
                                        <Plus size={14} className="ws-pick__plus" />
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {deleteConfirm && (
                <ConfirmDialog
                    title="Delete Workspace"
                    message={`Delete "${ws.name}"? All data will be lost.`}
                    onConfirm={handleDelete}
                    onCancel={() => setDeleteConfirm(false)}
                    variant="danger"
                />
            )}
        </div>
    );
};

export default WorkspaceDetail;
