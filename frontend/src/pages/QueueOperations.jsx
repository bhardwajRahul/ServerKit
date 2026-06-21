import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
    Layers,
    Inbox,
    Send,
    Trash2,
    RefreshCw,
    Plus,
    Search,
    Activity,
    Folder,
    Server,
    AlertCircle,
} from 'lucide-react';
import api from '../services/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../hooks/useConfirm';
import { ConfirmDialog } from '../components/ConfirmDialog';
import EmptyState from '../components/EmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { MetricCard, Pill } from '@/components/ds';

const STATUS_KINDS = {
    pending: 'blue',
    in_flight: 'yellow',
    completed: 'green',
    failed: 'red',
    dead_letter: 'gray',
};

const STATUS_LABELS = {
    pending: 'Pending',
    in_flight: 'In Flight',
    completed: 'Completed',
    failed: 'Failed',
    dead_letter: 'Dead Letter',
};

const STATUS_ORDER = ['pending', 'in_flight', 'completed', 'failed', 'dead_letter'];

const POLL_INTERVAL = 3000;

const QueueOperations = () => {
    const toast = useToast();
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm();

    const [loading, setLoading] = useState(true);
    const [groups, setGroups] = useState([]);
    const [queues, setQueues] = useState([]);
    const [stats, setStats] = useState(null);

    const [selectedGroup, setSelectedGroup] = useState('');
    const [messageFilter, setMessageFilter] = useState('all');
    const [searchTerm, setSearchTerm] = useState('');

    const [showGroupModal, setShowGroupModal] = useState(false);
    const [groupForm, setGroupForm] = useState({ name: '', description: '' });

    const [showQueueModal, setShowQueueModal] = useState(false);
    const [queueForm, setQueueForm] = useState({ name: '', description: '', config: '{}' });

    const [sendTarget, setSendTarget] = useState(null);
    const [sendForm, setSendForm] = useState({ payload: '{}', priority: 0, delay_ms: 0 });

    const [messageModalQueue, setMessageModalQueue] = useState(null);
    const [messages, setMessages] = useState([]);
    const [modalMessageFilter, setModalMessageFilter] = useState('all');
    const [selectedMessage, setSelectedMessage] = useState(null);

    const pollRef = useRef(null);

    const loadData = useCallback(async () => {
        try {
            const [groupsRes, statsRes] = await Promise.all([
                api.getQueueGroups(),
                api.getGlobalQueueStats(),
            ]);
            setGroups(groupsRes.groups || []);
            setStats(statsRes);
        } catch (err) {
            toast.error(err.message);
        } finally {
            setLoading(false);
        }
    }, [toast]);

    const loadQueues = useCallback(async (groupSlug) => {
        try {
            if (groupSlug) {
                const res = await api.getQueues(groupSlug);
                setQueues(res.queues || []);
                return;
            }
            // All groups: fan out and merge.
            const lists = await Promise.all(
                groups.map(g => api.getQueues(g.slug).then(r => r.queues || []).catch(() => []))
            );
            setQueues(lists.flat());
        } catch (err) {
            toast.error(err.message);
        }
    }, [groups, toast]);

    const loadMessages = useCallback(async (groupSlug, queueSlug, status) => {
        if (!groupSlug || !queueSlug) return;
        try {
            const res = await api.getMessages(groupSlug, queueSlug, {
                status: status === 'all' ? undefined : status,
                limit: 100,
            });
            setMessages(res.messages || []);
        } catch (err) {
            toast.error(err.message);
        }
    }, [toast]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    useEffect(() => {
        loadQueues(selectedGroup);
        pollRef.current = setInterval(() => {
            loadData();
            loadQueues(selectedGroup);
            if (messageModalQueue) {
                loadMessages(messageModalQueue.group_slug, messageModalQueue.slug, modalMessageFilter);
            }
        }, POLL_INTERVAL);
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, [selectedGroup, loadData, loadQueues, messageModalQueue, modalMessageFilter, loadMessages]);

    const totalQueues = useMemo(
        () => groups.reduce((acc, g) => acc + (g.stats?.queues || 0), 0),
        [groups]
    );

    const totalMessages = useMemo(
        () => (stats ? Object.values(stats.messages || {}).reduce((a, b) => a + b, 0) : 0),
        [stats]
    );

    const statusCounts = useMemo(() => stats?.messages || {}, [stats]);

    const filteredQueues = useMemo(() => {
        const q = searchTerm.trim().toLowerCase();
        return queues.filter(queue => {
            const matchesSearch = !q ||
                queue.name?.toLowerCase().includes(q) ||
                queue.slug?.toLowerCase().includes(q) ||
                queue.group_slug?.toLowerCase().includes(q);
            const matchesStatus = messageFilter === 'all' || (queue.stats?.[messageFilter] || 0) > 0;
            return matchesSearch && matchesStatus;
        });
    }, [queues, searchTerm, messageFilter]);

    const activeGroup = useMemo(
        () => groups.find(g => g.slug === selectedGroup),
        [groups, selectedGroup]
    );

    const handleCreateGroup = async (e) => {
        e.preventDefault();
        try {
            await api.createQueueGroup({
                name: groupForm.name,
                description: groupForm.description,
            });
            toast.success('Queue group created');
            setShowGroupModal(false);
            setGroupForm({ name: '', description: '' });
            loadData();
        } catch (err) {
            toast.error(err.message);
        }
    };

    const handleCreateQueue = async (e) => {
        e.preventDefault();
        const groupSlug = queueForm.groupSlug || selectedGroup;
        if (!groupSlug) {
            toast.error('Select a group for the queue');
            return;
        }
        let config = {};
        try {
            config = JSON.parse(queueForm.config);
        } catch {
            toast.error('Config must be valid JSON');
            return;
        }
        try {
            await api.createQueue(groupSlug, {
                name: queueForm.name,
                description: queueForm.description,
                config,
            });
            toast.success('Queue created');
            setShowQueueModal(false);
            setQueueForm({ name: '', description: '', config: '{}' });
            loadQueues(selectedGroup);
            loadData();
        } catch (err) {
            toast.error(err.message);
        }
    };

    const handleDeleteQueue = async (queue) => {
        const confirmed = await confirm({
            title: 'Delete Queue',
            message: `Are you sure you want to delete "${queue.name || queue.slug}" and all its messages?`,
            variant: 'danger',
        });
        if (!confirmed) return;
        try {
            await api.deleteQueue(queue.group_slug, queue.slug);
            toast.success('Queue deleted');
            loadQueues(selectedGroup);
            loadData();
        } catch (err) {
            toast.error(err.message);
        }
    };

    const openSendModal = (queue) => {
        setSendTarget(queue);
        setSendForm({ payload: '{}', priority: 0, delay_ms: 0 });
    };

    const handleSendMessage = async (e) => {
        e.preventDefault();
        const queue = sendTarget;
        if (!queue?.group_slug || !queue?.slug) {
            toast.error('Select a destination queue');
            return;
        }
        let payload = {};
        try {
            payload = JSON.parse(sendForm.payload);
        } catch {
            toast.error('Payload must be valid JSON');
            return;
        }
        try {
            await api.sendMessage(queue.group_slug, queue.slug, payload, {
                priority: parseInt(sendForm.priority, 10) || 0,
                delay_ms: parseInt(sendForm.delay_ms, 10) || 0,
            });
            toast.success('Message sent');
            setSendTarget(null);
            loadQueues(selectedGroup);
            loadData();
            if (messageModalQueue?.slug === queue.slug && messageModalQueue?.group_slug === queue.group_slug) {
                loadMessages(queue.group_slug, queue.slug, modalMessageFilter);
            }
        } catch (err) {
            toast.error(err.message);
        }
    };

    const openMessagesModal = (queue) => {
        setMessageModalQueue(queue);
        setModalMessageFilter(messageFilter === 'all' ? 'all' : messageFilter);
        loadMessages(queue.group_slug, queue.slug, messageFilter === 'all' ? 'all' : messageFilter);
    };

    const handleRequeueMessage = async (msg) => {
        try {
            await api.requeueMessage(msg.group_slug, msg.queue_slug, msg.id);
            toast.success('Message requeued');
            loadMessages(msg.group_slug, msg.queue_slug, modalMessageFilter);
            loadData();
        } catch (err) {
            toast.error(err.message);
        }
    };

    const handleDeleteMessage = async (msg) => {
        const confirmed = await confirm({
            title: 'Delete Message',
            message: 'Permanently delete this message?',
            variant: 'danger',
        });
        if (!confirmed) return;
        try {
            await api.deleteMessage(msg.group_slug, msg.queue_slug, msg.id);
            toast.success('Message deleted');
            loadMessages(msg.group_slug, msg.queue_slug, modalMessageFilter);
            loadData();
        } catch (err) {
            toast.error(err.message);
        }
    };

    const hasActiveFilters = selectedGroup !== '' || messageFilter !== 'all' || Boolean(searchTerm);

    const activeStatusLabel = messageFilter === 'all'
        ? 'All queues'
        : `${STATUS_LABELS[messageFilter]} queues`;
    const activeGroupLabel = activeGroup ? activeGroup.name : 'All groups';

    if (loading) {
        return (
            <div className="queue-page queue-page--loading">
                <div className="queue-loading-card">
                    <Layers size={24} />
                    <span>Loading queue bus...</span>
                </div>
            </div>
        );
    }

    return (
        <div className="queue-page queue-page--ops">
            <div className="queue-ops-workspace">
                <aside className="queue-fleet-rail">
                    <section className="queue-rail-section queue-rail-section--overview">
                        <div className="queue-rail-section-header">
                            <Activity size={14} />
                            <span>Overview</span>
                        </div>
                        <div className="queue-rail-overview">
                            <MetricCard label="Groups" value={groups.length} />
                            <MetricCard label="Queues" value={totalQueues} />
                            <MetricCard label="Messages" value={totalMessages} />
                            <MetricCard label="Dead Letter" value={statusCounts.dead_letter || 0} kind="danger" />
                        </div>
                    </section>

                    <section className="queue-rail-section">
                        <div className="queue-rail-section-header queue-rail-section-header--split">
                            <span><Folder size={14} /> Groups</span>
                            <button type="button" onClick={() => setShowGroupModal(true)}>New</button>
                        </div>
                        <div className="queue-group-nav">
                            <button
                                type="button"
                                className={`queue-group-nav-item ${selectedGroup === '' ? 'active' : ''}`}
                                onClick={() => setSelectedGroup('')}
                            >
                                <Server size={14} />
                                <span>All groups</span>
                                <b>{totalQueues}</b>
                            </button>
                            {groups.map(group => (
                                <button
                                    type="button"
                                    key={group.id}
                                    className={`queue-group-nav-item ${selectedGroup === group.slug ? 'active' : ''}`}
                                    onClick={() => setSelectedGroup(group.slug)}
                                >
                                    <Folder size={14} />
                                    <span>{group.name}</span>
                                    {group.owner_type === 'system' && (
                                        <span className="queue-group-badge">system</span>
                                    )}
                                    <b>{group.stats?.queues || 0}</b>
                                </button>
                            ))}
                        </div>
                    </section>

                    <section className="queue-rail-section">
                        <div className="queue-rail-section-header">
                            <AlertCircle size={14} />
                            <span>Message Status</span>
                        </div>
                        <div className="queue-status-nav">
                            <button
                                type="button"
                                className={`queue-status-nav-item ${messageFilter === 'all' ? 'active' : ''}`}
                                onClick={() => setMessageFilter('all')}
                            >
                                <span><strong>All</strong><small>Any status</small></span>
                                <b>{totalMessages}</b>
                            </button>
                            {STATUS_ORDER.map(status => (
                                <button
                                    type="button"
                                    key={status}
                                    className={`queue-status-nav-item queue-status-nav-item--${status} ${messageFilter === status ? 'active' : ''}`}
                                    onClick={() => setMessageFilter(status)}
                                >
                                    <span>
                                        <strong>{STATUS_LABELS[status]}</strong>
                                        <small>{status}</small>
                                    </span>
                                    <b>{statusCounts[status] || 0}</b>
                                </button>
                            ))}
                        </div>
                    </section>
                </aside>

                <main className="queue-main">
                    <div className="queue-workbar">
                        <div className="queue-workbar-title">
                            <span>Queue Bus</span>
                            <h1>{activeGroupLabel}</h1>
                            <em>{activeStatusLabel} · {filteredQueues.length} visible</em>
                        </div>
                        <div className="queue-workbar-actions">
                            <Button variant="outline" onClick={() => setShowGroupModal(true)}>
                                <Folder size={16} /> Group
                            </Button>
                            <Button variant="outline" onClick={() => setShowQueueModal(true)}>
                                <Plus size={16} /> Queue
                            </Button>
                            <Button variant="outline" onClick={() => { loadData(); loadQueues(selectedGroup); }}>
                                <RefreshCw size={16} /> Refresh
                            </Button>
                        </div>
                    </div>

                    <div className="queue-command-bar">
                        <div className="queue-toolbar">
                            <label className="search-box">
                                <Search size={16} />
                                <Input
                                    type="text"
                                    placeholder="Search queues by name or slug..."
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                />
                            </label>
                            <select
                                className="queue-select"
                                value={selectedGroup}
                                onChange={(e) => setSelectedGroup(e.target.value)}
                            >
                                <option value="">All groups</option>
                                {groups.map(g => <option key={g.id} value={g.slug}>{g.name}</option>)}
                            </select>
                        </div>
                        <div className="queue-results-summary">
                            <strong>{filteredQueues.length}</strong>
                            <span>{filteredQueues.length === 1 ? 'queue' : 'queues'}</span>
                            {hasActiveFilters && (
                                <button
                                    type="button"
                                    className="queue-clear-filters"
                                    onClick={() => {
                                        setSelectedGroup('');
                                        setMessageFilter('all');
                                        setSearchTerm('');
                                    }}
                                >
                                    Clear filters
                                </button>
                            )}
                        </div>
                    </div>

                    {filteredQueues.length === 0 ? (
                        <EmptyState
                            icon={Layers}
                            title={queues.length === 0 ? 'No queues yet' : 'No queues match these filters'}
                            description={queues.length === 0
                                ? 'Create a queue group and queue to start sending messages.'
                                : 'Adjust the filters or search query to see your queues.'}
                            action={queues.length === 0 ? (
                                <Button onClick={() => setShowGroupModal(true)}>
                                    <Plus size={16} /> Create Group
                                </Button>
                            ) : (
                                <Button variant="outline" onClick={() => {
                                    setSelectedGroup('');
                                    setMessageFilter('all');
                                    setSearchTerm('');
                                }}>
                                    Clear filters
                                </Button>
                            )}
                        />
                    ) : (
                        <div className="queue-table-wrap">
                            <table className="queue-table">
                                <thead>
                                    <tr>
                                        <th>Queue</th>
                                        <th>Group</th>
                                        <th>Messages</th>
                                        <th>Created</th>
                                        <th className="col-actions" aria-label="Actions" />
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredQueues.map(queue => (
                                        <tr
                                            key={queue.id}
                                            className="is-clickable"
                                            onClick={() => openMessagesModal(queue)}
                                        >
                                            <td>
                                                <div className="queue-row-name">
                                                    <span className="queue-row-title">{queue.name}</span>
                                                    <code className="queue-row-sub">/{queue.slug}</code>
                                                </div>
                                            </td>
                                            <td>
                                                {queue.group_slug && (
                                                    <span className="queue-row-group">
                                                        <Folder size={12} /> {queue.group_slug}
                                                    </span>
                                                )}
                                            </td>
                                            <td onClick={e => e.stopPropagation()}>
                                                <div className="queue-row-counts">
                                                    {STATUS_ORDER.filter(s => (queue.stats?.[s] || 0) > 0).map(status => (
                                                        <Pill key={status} kind={STATUS_KINDS[status]}>
                                                            {STATUS_LABELS[status]} {queue.stats[status]}
                                                        </Pill>
                                                    ))}
                                                    {(queue.stats?.total || 0) === 0 && (
                                                        <span className="muted">Empty</span>
                                                    )}
                                                </div>
                                            </td>
                                            <td>{new Date(queue.created_at).toLocaleString()}</td>
                                            <td className="col-actions" onClick={e => e.stopPropagation()}>
                                                <div className="queue-actions">
                                                    <Button variant="ghost" size="sm" onClick={() => openSendModal(queue)}>
                                                        <Send size={14} />
                                                    </Button>
                                                    <Button variant="ghost" size="sm" onClick={() => openMessagesModal(queue)}>
                                                        <Inbox size={14} />
                                                    </Button>
                                                    <Button variant="ghost" size="sm" onClick={() => handleDeleteQueue(queue)}>
                                                        <Trash2 size={14} />
                                                    </Button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </main>
            </div>

            {/* Create Group Modal */}
            {showGroupModal && (
                <div className="modal-overlay" onClick={() => setShowGroupModal(false)}>
                    <div className="modal" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2>Create Queue Group</h2>
                            <button className="modal-close" onClick={() => setShowGroupModal(false)}>&times;</button>
                        </div>
                        <form onSubmit={handleCreateGroup}>
                            <div className="modal-body">
                                <div className="form-group">
                                    <Label htmlFor="group-name">Name</Label>
                                    <Input id="group-name" value={groupForm.name} onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })} required />
                                </div>
                                <div className="form-group">
                                    <Label htmlFor="group-description">Description</Label>
                                    <Input id="group-description" value={groupForm.description} onChange={(e) => setGroupForm({ ...groupForm, description: e.target.value })} />
                                </div>
                            </div>
                            <div className="modal-footer">
                                <Button type="button" variant="outline" onClick={() => setShowGroupModal(false)}>Cancel</Button>
                                <Button type="submit">Create Group</Button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Create Queue Modal */}
            {showQueueModal && (
                <div className="modal-overlay" onClick={() => setShowQueueModal(false)}>
                    <div className="modal" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2>Create Queue</h2>
                            <button className="modal-close" onClick={() => setShowQueueModal(false)}>&times;</button>
                        </div>
                        <form onSubmit={handleCreateQueue}>
                            <div className="modal-body">
                                <div className="form-group">
                                    <Label htmlFor="queue-group">Group</Label>
                                    <select
                                        id="queue-group"
                                        className="queue-select queue-select--full"
                                        value={queueForm.groupSlug || selectedGroup || ''}
                                        onChange={(e) => setQueueForm({ ...queueForm, groupSlug: e.target.value })}
                                        required
                                    >
                                        <option value="">Select group</option>
                                        {groups.map(g => <option key={g.id} value={g.slug}>{g.name}</option>)}
                                    </select>
                                </div>
                                <div className="form-group">
                                    <Label htmlFor="queue-name">Name</Label>
                                    <Input id="queue-name" value={queueForm.name} onChange={(e) => setQueueForm({ ...queueForm, name: e.target.value })} required />
                                </div>
                                <div className="form-group">
                                    <Label htmlFor="queue-description">Description</Label>
                                    <Input id="queue-description" value={queueForm.description} onChange={(e) => setQueueForm({ ...queueForm, description: e.target.value })} />
                                </div>
                                <div className="form-group">
                                    <Label htmlFor="queue-config">Config (JSON)</Label>
                                    <Textarea id="queue-config" value={queueForm.config} onChange={(e) => setQueueForm({ ...queueForm, config: e.target.value })} rows={4} />
                                </div>
                            </div>
                            <div className="modal-footer">
                                <Button type="button" variant="outline" onClick={() => setShowQueueModal(false)}>Cancel</Button>
                                <Button type="submit">Create Queue</Button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Send Message Modal */}
            {sendTarget && (
                <div className="modal-overlay" onClick={() => setSendTarget(null)}>
                    <div className="modal" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2>Send Message</h2>
                            <button className="modal-close" onClick={() => setSendTarget(null)}>&times;</button>
                        </div>
                        <form onSubmit={handleSendMessage}>
                            <div className="modal-body">
                                <div className="queue-send-destination">
                                    <div>
                                        <Label>Group</Label>
                                        <div className="queue-send-readonly">{sendTarget.group_slug}</div>
                                    </div>
                                    <div>
                                        <Label>Queue</Label>
                                        <div className="queue-send-readonly">{sendTarget.slug}</div>
                                    </div>
                                </div>
                                <div className="form-group">
                                    <Label htmlFor="payload">Payload (JSON)</Label>
                                    <Textarea
                                        id="payload"
                                        value={sendForm.payload}
                                        onChange={(e) => setSendForm({ ...sendForm, payload: e.target.value })}
                                        rows={6}
                                        required
                                    />
                                </div>
                                <div className="form-row">
                                    <div className="form-group">
                                        <Label htmlFor="priority">Priority</Label>
                                        <Input id="priority" type="number" value={sendForm.priority} onChange={(e) => setSendForm({ ...sendForm, priority: e.target.value })} />
                                    </div>
                                    <div className="form-group">
                                        <Label htmlFor="delay_ms">Delay (ms)</Label>
                                        <Input id="delay_ms" type="number" value={sendForm.delay_ms} onChange={(e) => setSendForm({ ...sendForm, delay_ms: e.target.value })} />
                                    </div>
                                </div>
                            </div>
                            <div className="modal-footer">
                                <Button type="button" variant="outline" onClick={() => setSendTarget(null)}>Cancel</Button>
                                <Button type="submit"><Send size={14} className="mr-2" /> Send Message</Button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Messages Modal */}
            {messageModalQueue && (
                <div className="modal-overlay" onClick={() => setMessageModalQueue(null)}>
                    <div className="modal modal--wide" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <div>
                                <h2>{messageModalQueue.name} Messages</h2>
                                <span className="modal-header-sub">{messageModalQueue.group_slug} / {messageModalQueue.slug}</span>
                            </div>
                            <button className="modal-close" onClick={() => setMessageModalQueue(null)}>&times;</button>
                        </div>
                        <div className="modal-body">
                            <div className="queue-messages-toolbar">
                                <div className="queue-messages-selects">
                                    <select
                                        className="queue-select"
                                        value={modalMessageFilter}
                                        onChange={(e) => {
                                            setModalMessageFilter(e.target.value);
                                            loadMessages(messageModalQueue.group_slug, messageModalQueue.slug, e.target.value);
                                        }}
                                    >
                                        <option value="all">All statuses</option>
                                        {STATUS_ORDER.map(s => (
                                            <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                                        ))}
                                    </select>
                                </div>
                                <div className="queue-messages-actions">
                                    <Button variant="outline" size="sm" onClick={() => openSendModal(messageModalQueue)}>
                                        <Send size={14} className="mr-2" /> Send Message
                                    </Button>
                                    <Button variant="outline" size="sm" onClick={() => loadMessages(messageModalQueue.group_slug, messageModalQueue.slug, modalMessageFilter)}>
                                        <RefreshCw size={14} className="mr-2" /> Refresh
                                    </Button>
                                </div>
                            </div>

                            {messages.length === 0 ? (
                                <EmptyState icon={Inbox} title="No Messages" description="This queue is empty. Send a message to get started." />
                            ) : (
                                <table className="sk-dtable queue-table">
                                    <thead>
                                        <tr>
                                            <th>Status</th>
                                            <th>Payload</th>
                                            <th>Attempts</th>
                                            <th>Created</th>
                                            <th aria-label="Actions" />
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {messages.map(msg => (
                                            <tr key={msg.id} className="is-clickable" onClick={() => setSelectedMessage(msg)}>
                                                <td><Pill kind={STATUS_KINDS[msg.status] || 'gray'}>{msg.status}</Pill></td>
                                                <td><code className="queue-payload-preview">{JSON.stringify(msg.payload).slice(0, 80)}</code></td>
                                                <td>{msg.attempts} / {msg.max_attempts}</td>
                                                <td>{new Date(msg.created_at).toLocaleString()}</td>
                                                <td onClick={e => e.stopPropagation()}>
                                                    <div className="queue-actions">
                                                        {(msg.status === 'failed' || msg.status === 'dead_letter') && (
                                                            <Button variant="ghost" size="sm" onClick={() => handleRequeueMessage(msg)}>
                                                                <RefreshCw size={14} />
                                                            </Button>
                                                        )}
                                                        <Button variant="ghost" size="sm" onClick={() => handleDeleteMessage(msg)}>
                                                            <Trash2 size={14} />
                                                        </Button>
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Message Detail Modal */}
            {selectedMessage && (
                <div className="modal-overlay" onClick={() => setSelectedMessage(null)}>
                    <div className="modal modal--wide" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2>Message Detail</h2>
                            <button className="modal-close" onClick={() => setSelectedMessage(null)}>&times;</button>
                        </div>
                        <div className="modal-body">
                            <div className="queue-message-detail">
                                <div><strong>ID:</strong> <code>{selectedMessage.id}</code></div>
                                <div><strong>Status:</strong> <Pill kind={STATUS_KINDS[selectedMessage.status] || 'gray'}>{selectedMessage.status}</Pill></div>
                                <div><strong>Attempts:</strong> {selectedMessage.attempts} / {selectedMessage.max_attempts}</div>
                                <div><strong>Created:</strong> {new Date(selectedMessage.created_at).toLocaleString()}</div>
                                {selectedMessage.error_message && (
                                    <div className="queue-message-error"><strong>Error:</strong> {selectedMessage.error_message}</div>
                                )}
                                <div className="queue-message-section"><strong>Payload:</strong>
                                    <pre>{JSON.stringify(selectedMessage.payload, null, 2)}</pre>
                                </div>
                                {selectedMessage.result && (
                                    <div className="queue-message-section"><strong>Result:</strong>
                                        <pre>{JSON.stringify(selectedMessage.result, null, 2)}</pre>
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="modal-footer">
                            <Button type="button" variant="outline" onClick={() => setSelectedMessage(null)}>Close</Button>
                            {(selectedMessage.status === 'failed' || selectedMessage.status === 'dead_letter') && (
                                <Button onClick={() => { handleRequeueMessage(selectedMessage); setSelectedMessage(null); }}>Requeue</Button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            <ConfirmDialog
                isOpen={confirmState.isOpen}
                title={confirmState.title}
                message={confirmState.message}
                confirmText={confirmState.confirmText}
                cancelText={confirmState.cancelText}
                variant={confirmState.variant}
                onConfirm={handleConfirm}
                onCancel={handleCancel}
            />
        </div>
    );
};

export default QueueOperations;
