import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import { useToast } from '../contexts/ToastContext';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import { LayoutGrid, Plus, ChevronRight } from 'lucide-react';
import { PageTopbar, Pill, ServiceTile } from '@/components/ds';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

// Matches WorkspaceSwitcher: the active workspace id lives in localStorage.
const ACTIVE_KEY = 'active_workspace_id';

// "since Jun 2026" card meta from the workspace's real created_at.
const formatSince = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
        ? null
        : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
};

const Workspaces = () => {
    const toast = useToast();
    const navigate = useNavigate();
    const [workspaces, setWorkspaces] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [form, setForm] = useState({ name: '', description: '', max_servers: 0, max_users: 0, primary_color: '#6d7cff' });

    const activeId = localStorage.getItem(ACTIVE_KEY);

    const loadWorkspaces = useCallback(async () => {
        try {
            const data = await api.getWorkspaces();
            setWorkspaces(data.workspaces || []);
        } catch (err) {
            toast.error('Failed to load workspaces');
        } finally {
            setLoading(false);
        }
    }, [toast]);

    useEffect(() => { loadWorkspaces(); }, [loadWorkspaces]);

    const handleCreate = async () => {
        try {
            await api.createWorkspace(form);
            toast.success('Workspace created');
            setShowCreateModal(false);
            setForm({ name: '', description: '', max_servers: 0, max_users: 0, primary_color: '#6d7cff' });
            loadWorkspaces();
        } catch (err) {
            toast.error(err.message);
        }
    };

    if (loading) return <div className="page-container workspaces-page"><Spinner /></div>;

    return (
        <div className="page-container workspaces-page">
            <PageTopbar
                icon={<LayoutGrid size={18} />}
                title="Workspaces"
                meta={`${workspaces.length} workspace${workspaces.length !== 1 ? 's' : ''}`}
                actions={(
                    <Button size="sm" onClick={() => setShowCreateModal(true)}>
                        <Plus size={16} />
                        New Workspace
                    </Button>
                )}
            />

            {workspaces.length === 0 ? (
                <EmptyState
                    icon={LayoutGrid}
                    title="No workspaces yet"
                    description="Create one to isolate servers by team or project."
                />
            ) : (
                <>
                    <div className="ws-listhead">
                        <h2>Your Workspaces</h2>
                        <span className="ws-listhead__hint">open a workspace to manage its resources</span>
                    </div>
                    <div className="ws-grid">
                        {workspaces.map(ws => {
                            const since = formatSince(ws.created_at);
                            const isCurrent = activeId === String(ws.id);
                            return (
                                <div
                                    key={ws.id}
                                    className={`ws-card is-clickable ${isCurrent ? 'active' : ''}`}
                                    role="link"
                                    tabIndex={0}
                                    onClick={() => navigate(`/workspaces/${ws.id}`)}
                                    onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/workspaces/${ws.id}`); }}
                                >
                                    <div className="ws-card__top">
                                        <ServiceTile name={ws.name} size={38} gradient={ws.primary_color || undefined} />
                                        {isCurrent
                                            ? <Pill kind="green">active</Pill>
                                            : <Pill kind={ws.status === 'active' ? 'green' : 'amber'}>{ws.status}</Pill>}
                                    </div>
                                    <div className="ws-card__name">{ws.name}</div>
                                    <div className="ws-card__meta">/{ws.slug}{since ? ` · since ${since}` : ''}</div>
                                    {ws.description && <p className="ws-card__desc">{ws.description}</p>}
                                    <div className="ws-card__stats">
                                        <div>
                                            <div className="v">{ws.member_count}</div>
                                            <div className="l">Member{ws.member_count !== 1 ? 's' : ''}</div>
                                        </div>
                                        {ws.max_servers > 0 && (
                                            <div>
                                                <div className="v">{ws.max_servers}</div>
                                                <div className="l">Max Servers</div>
                                            </div>
                                        )}
                                        {ws.max_users > 0 && (
                                            <div>
                                                <div className="v">{ws.max_users}</div>
                                                <div className="l">Max Users</div>
                                            </div>
                                        )}
                                    </div>
                                    <div className="ws-card__open">
                                        Open <ChevronRight size={14} />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </>
            )}

            {showCreateModal && (
                <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
                    <div className="modal" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2>Create Workspace</h2>
                            <button className="modal-close" onClick={() => setShowCreateModal(false)}>&times;</button>
                        </div>
                        <div className="modal-body">
                            <div className="form-group">
                                <label>Name</label>
                                <Input value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="My Team" />
                            </div>
                            <div className="form-group">
                                <label>Description</label>
                                <Textarea value={form.description} onChange={e => setForm({...form, description: e.target.value})} rows={2} />
                            </div>
                            <div className="form-row">
                                <div className="form-group">
                                    <label>Max Servers (0 = unlimited)</label>
                                    <Input type="number" value={form.max_servers} onChange={e => setForm({...form, max_servers: parseInt(e.target.value) || 0})} />
                                </div>
                                <div className="form-group">
                                    <label>Max Users (0 = unlimited)</label>
                                    <Input type="number" value={form.max_users} onChange={e => setForm({...form, max_users: parseInt(e.target.value) || 0})} />
                                </div>
                            </div>
                            <div className="form-group">
                                <label>Brand Color</label>
                                <input
                                    type="color"
                                    className="workspace-color-input"
                                    value={form.primary_color}
                                    onChange={e => setForm({...form, primary_color: e.target.value})}
                                    aria-label="Workspace brand color"
                                />
                                <span className="form-hint">Recolors the panel for anyone viewing this workspace. Leave the default for no custom branding.</span>
                            </div>
                        </div>
                        <div className="modal-footer">
                            <Button variant="outline" onClick={() => setShowCreateModal(false)}>Cancel</Button>
                            <Button onClick={handleCreate} disabled={!form.name}>Create</Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default Workspaces;
