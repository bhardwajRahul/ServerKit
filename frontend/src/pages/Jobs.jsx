// Jobs — admin view over the unified job system (job orchestration, "Phase 9").
//
// Host-idiom rebuild (plan 39): the Servers/Domains table-with-search treatment
// — SegControl status filter + kind select + debounced search, DataTable rows,
// clickable compact KPIs, and server-side pagination against a job store that
// can hold six figures of scheduler-tick rows. Wired to the real ApiService job
// methods (see frontend/src/services/api/jobs.js).
import { useState, useEffect, useCallback, useRef } from 'react';
import { ListChecks, RefreshCw, RotateCcw, XCircle, Play, Clock, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import api from '../services/api';
import { PageTopbar, MetricCard, KpiBand, Pill, DataTable, SegControl } from '@/components/ds';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { timeAgo } from '../utils/timeAgo';

const STATUSES = ['all', 'queued', 'running', 'succeeded', 'failed', 'cancelled'];
const PAGE_SIZE = 50;
const POLL_MS = 5000;

// Map a job status to a DS Pill colour.
const STATUS_KIND = {
    queued: 'gray',
    pending: 'gray',
    scheduled: 'gray',
    running: 'cyan',
    succeeded: 'green',
    success: 'green',
    completed: 'green',
    failed: 'red',
    error: 'red',
    cancelled: 'amber',
    canceled: 'amber',
};

function statusKind(status) {
    return STATUS_KIND[String(status || '').toLowerCase()] || 'gray';
}

function ownerLabel(job) {
    if (!job.owner_type) return '—';
    return `${job.owner_type}${job.owner_id ? ` #${job.owner_id}` : ''}`;
}

function progressLabel(job) {
    if (typeof job.progress === 'number') return `${Math.round(job.progress)}%`;
    if (job.completed_units != null && job.total_units != null) {
        return `${job.completed_units}/${job.total_units}`;
    }
    return '—';
}

const isRunning = (s) => ['running', 'queued', 'pending', 'scheduled'].includes(String(s || '').toLowerCase());
const canRetry = (s) => ['failed', 'error', 'cancelled', 'canceled'].includes(String(s || '').toLowerCase());

export default function Jobs() {
    const { isAdmin } = useAuth();
    const toast = useToast();
    const [jobs, setJobs] = useState([]);
    const [total, setTotal] = useState(0);
    const [stats, setStats] = useState(null);
    const [scheduled, setScheduled] = useState([]);
    const [status, setStatus] = useState('all');
    const [kind, setKind] = useState('all');
    const [kinds, setKinds] = useState([]);
    const [searchInput, setSearchInput] = useState('');
    const [q, setQ] = useState('');
    const [page, setPage] = useState(0);
    const [loading, setLoading] = useState(true);
    const pollRef = useRef(null);

    // Debounce the raw search box into the query term; reset to the first page
    // whenever the term changes so results start from the top.
    useEffect(() => {
        const t = setTimeout(() => {
            setQ(searchInput.trim());
            setPage(0);
        }, 350);
        return () => clearTimeout(t);
    }, [searchInput]);

    const load = useCallback(async () => {
        try {
            const params = { limit: PAGE_SIZE, offset: page * PAGE_SIZE };
            if (status !== 'all') params.status = status;
            if (kind !== 'all') params.kind = kind;
            if (q) params.q = q;
            const [jobsRes, statsRes, schedRes] = await Promise.all([
                api.getJobs(params),
                api.getJobStats().catch(() => null),
                api.getScheduledJobs().catch(() => null),
            ]);
            setJobs(jobsRes?.jobs || []);
            setTotal(jobsRes?.total ?? (jobsRes?.jobs?.length || 0));
            setStats(statsRes?.stats || statsRes || null);
            setScheduled(schedRes?.scheduled || schedRes?.jobs || schedRes || []);
        } catch {
            // Keep the last good state on screen rather than blanking the page.
        } finally {
            setLoading(false);
        }
    }, [status, kind, q, page]);

    useEffect(() => {
        if (!isAdmin) return undefined;
        api.getJobKinds()
            .then((res) => setKinds(res?.kinds || res || []))
            .catch(() => { /* filter just won't populate */ });
        return undefined;
    }, [isAdmin]);

    useEffect(() => {
        if (!isAdmin) return undefined;
        load();
        pollRef.current = setInterval(load, POLL_MS);
        return () => clearInterval(pollRef.current);
    }, [isAdmin, load]);

    const setStatusFilter = (value) => { setStatus(value); setPage(0); };
    const setKindFilter = (value) => { setKind(value); setPage(0); };

    const onRetry = async (id) => {
        try { await api.retryJob(id); toast.success('Job re-queued'); load(); }
        catch { toast.error('Retry failed'); }
    };
    const onCancel = async (id) => {
        try { await api.cancelJob(id); toast.success('Job cancelled'); load(); }
        catch { toast.error('Cancel failed'); }
    };
    const onRunScheduled = async (id) => {
        try { await api.runScheduledJob(id); toast.success('Scheduled job triggered'); load(); }
        catch { toast.error('Trigger failed'); }
    };
    const onToggleScheduled = async (id, enabled) => {
        try { await api.setScheduledJobEnabled(id, enabled); load(); }
        catch { toast.error('Update failed'); }
    };

    if (!isAdmin) {
        return (
            <>
                <PageTopbar icon={<ListChecks size={18} />} title="Jobs" />
                <div className="sk-jobs"><div className="sk-jobs__empty">Admins only.</div></div>
            </>
        );
    }

    const byStatus = stats?.by_status || {};
    const hasFilters = status !== 'all' || kind !== 'all' || Boolean(q);
    const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
    const rangeEnd = page * PAGE_SIZE + jobs.length;
    const hasPrev = page > 0;
    const hasNext = (page + 1) * PAGE_SIZE < total;

    const kindOptions = kinds
        .map((k) => (typeof k === 'string' ? k : k.kind || k.name))
        .filter(Boolean);

    const jobColumns = [
        { key: 'status', header: 'Status', render: (j) => <Pill kind={statusKind(j.status)}>{j.status}</Pill> },
        { key: 'kind', header: 'Kind', cellClassName: 'sk-jobs__kind', render: (j) => j.kind || '—' },
        { key: 'owner', header: 'Owner', cellClassName: 'sk-jobs__owner', render: ownerLabel },
        {
            key: 'progress',
            header: 'Progress',
            render: (j) => (
                <>
                    {progressLabel(j)}
                    {j.error_message && (
                        <div className="sk-jobs__error" title={j.error_message}>{j.error_message}</div>
                    )}
                </>
            ),
        },
        { key: 'when', header: 'When', cellClassName: 'sk-jobs__when', render: (j) => timeAgo(j.created_at || j.updated_at) },
        {
            key: 'actions',
            header: '',
            className: 'sk-jobs__actions-col',
            cellClassName: 'sk-jobs__actions-cell',
            render: (j) => (
                <div className="sk-jobs__actions">
                    {isRunning(j.status) && (
                        <Button variant="ghost" size="sm" onClick={() => onCancel(j.id)}>
                            <XCircle size={14} /> Cancel
                        </Button>
                    )}
                    {canRetry(j.status) && (
                        <Button variant="ghost" size="sm" onClick={() => onRetry(j.id)}>
                            <RotateCcw size={14} /> Retry
                        </Button>
                    )}
                </div>
            ),
        },
    ];

    const scheduledColumns = [
        { key: 'name', header: 'Name', render: (s) => s.name || s.kind || `#${s.id}` },
        { key: 'kind', header: 'Kind', cellClassName: 'sk-jobs__kind', render: (s) => s.kind || '—' },
        { key: 'schedule', header: 'Schedule', cellClassName: 'sk-jobs__owner', render: (s) => s.schedule || s.cron || (s.interval_seconds ? `every ${s.interval_seconds}s` : '—') },
        { key: 'next', header: 'Next run', cellClassName: 'sk-jobs__when', render: (s) => (s.next_run_at ? timeAgo(s.next_run_at) : '—') },
        { key: 'enabled', header: 'Enabled', render: (s) => <Pill kind={s.enabled ? 'green' : 'gray'}>{s.enabled ? 'On' : 'Off'}</Pill> },
        {
            key: 'actions',
            header: '',
            className: 'sk-jobs__actions-col',
            cellClassName: 'sk-jobs__actions-cell',
            render: (s) => (
                <div className="sk-jobs__actions">
                    <Button variant="ghost" size="sm" onClick={() => onRunScheduled(s.id)}>
                        <Play size={14} /> Run now
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => onToggleScheduled(s.id, !s.enabled)}>
                        {s.enabled ? 'Disable' : 'Enable'}
                    </Button>
                </div>
            ),
        },
    ];

    return (
        <>
            <PageTopbar
                icon={<ListChecks size={18} />}
                title="Jobs"
                meta="Unified job orchestration across the panel"
                actions={(
                    <Button variant="outline" size="sm" onClick={load}>
                        <RefreshCw size={14} /> Refresh
                    </Button>
                )}
            />

            <div className="sk-jobs">
                <KpiBand>
                    <MetricCard label="Total" value={stats?.total ?? total ?? 0} tone="accent" compact
                        onClick={() => setStatusFilter('all')} />
                    <MetricCard label="Running" value={byStatus.running ?? 0} tone="cyan" compact
                        onClick={() => setStatusFilter('running')} />
                    <MetricCard label="Queued" value={byStatus.pending ?? byStatus.queued ?? 0} tone="amber" compact
                        onClick={() => setStatusFilter('queued')} />
                    <MetricCard label="Failed" value={byStatus.failed ?? 0} tone="red" compact
                        onClick={() => setStatusFilter('failed')} />
                </KpiBand>

                <div className="sk-jobs__command-bar">
                    <div className="sk-jobs__filters">
                        <SegControl
                            options={STATUSES.map((s) => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }))}
                            value={status}
                            onChange={setStatusFilter}
                            aria-label="Filter by status"
                        />
                        <Select value={kind} onValueChange={setKindFilter}>
                            <SelectTrigger className="sk-jobs__kind-select" aria-label="Filter by kind">
                                <SelectValue placeholder="All kinds" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All kinds</SelectItem>
                                {kindOptions.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}
                            </SelectContent>
                        </Select>
                        <label className="search-box sk-jobs__search">
                            <Search size={16} />
                            <Input
                                type="text"
                                placeholder="Search by kind or owner..."
                                value={searchInput}
                                onChange={(e) => setSearchInput(e.target.value)}
                                aria-label="Search jobs"
                            />
                        </label>
                    </div>
                    <div className="sk-jobs__results-summary">
                        {total > 0 ? (
                            <span>Showing <strong>{rangeStart}</strong>–<strong>{rangeEnd}</strong> of <strong>{total}</strong></span>
                        ) : (
                            <span>No jobs</span>
                        )}
                        {hasFilters && (
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="sk-jobs__clear-filters"
                                onClick={() => {
                                    setStatus('all');
                                    setKind('all');
                                    setSearchInput('');
                                    setPage(0);
                                }}
                            >
                                Clear filters
                            </Button>
                        )}
                    </div>
                </div>

                <DataTable
                    columns={jobColumns}
                    data={jobs}
                    keyField="id"
                    sortable={false}
                    loading={loading && jobs.length === 0}
                    emptyState={(
                        <div className="sk-jobs__empty">
                            <ListChecks size={24} aria-hidden="true" />
                            <p>{hasFilters ? 'No jobs match these filters.' : 'No jobs have run yet.'}</p>
                        </div>
                    )}
                />

                {(hasPrev || hasNext) && (
                    <div className="sk-jobs__pager">
                        <Button variant="outline" size="sm" disabled={!hasPrev} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                            <ChevronLeft size={14} /> Prev
                        </Button>
                        <span className="sk-jobs__pager-label">Page {page + 1}</span>
                        <Button variant="outline" size="sm" disabled={!hasNext} onClick={() => setPage((p) => p + 1)}>
                            Next <ChevronRight size={14} />
                        </Button>
                    </div>
                )}

                {scheduled.length > 0 && (
                    <section className="sk-jobs__scheduled">
                        <h2 className="sk-jobs__section-title">
                            <Clock size={16} aria-hidden="true" /> Scheduled jobs
                        </h2>
                        <DataTable
                            columns={scheduledColumns}
                            data={scheduled}
                            keyField="id"
                            sortable={false}
                        />
                    </section>
                )}
            </div>
        </>
    );
}
