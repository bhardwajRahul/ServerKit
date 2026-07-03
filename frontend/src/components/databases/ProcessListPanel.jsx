import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, Ban, Activity, TimerReset } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../hooks/useConfirm';
import EmptyState from '../EmptyState';

const REFRESH_MS = 5000;
const QUERY_PREVIEW_LEN = 120;

function formatTime(s) {
    if (s == null) return '—';
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// Live processlist (SHOW FULL PROCESSLIST / pg_stat_activity) for the selected
// engine or container, with an admin-only kill action and a 5s auto-refresh
// toggle. `active` gates polling so hidden tabs don't keep hammering the API.
export default function ProcessListPanel({ conn, engine, active, isAdmin }) {
    const toast = useToast();
    const { confirm } = useConfirm();

    const [rows, setRows] = useState(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [autoRefresh, setAutoRefresh] = useState(true);
    const [killing, setKilling] = useState(null);
    const inFlight = useRef(false);

    const isDocker = conn?.dbType === 'docker';
    const engineKind = isDocker ? (conn.dockerType || 'mysql') : (engine || conn?.dbType);

    const load = useCallback(async (silent = false) => {
        if (inFlight.current) return;
        inFlight.current = true;
        if (!silent) setLoading(true);
        try {
            const d = isDocker
                ? await api.getDockerDbProcesses(conn.container, engineKind, conn.user, conn.password)
                : await api.getHostDbProcesses(engineKind);
            setRows(d.processes || []);
            setError('');
        } catch (err) {
            setError(err.message || 'Failed to load processes');
        } finally {
            inFlight.current = false;
            setLoading(false);
        }
    }, [isDocker, engineKind, conn]);

    useEffect(() => { load(); }, [load]);

    useEffect(() => {
        if (!active || !autoRefresh) return undefined;
        const t = setInterval(() => load(true), REFRESH_MS);
        return () => clearInterval(t);
    }, [active, autoRefresh, load]);

    async function killProcess(proc) {
        const verb = engineKind === 'postgresql' ? 'Terminate' : 'Kill';
        const ok = await confirm({
            title: `${verb} process ${proc.id}`,
            message: `${verb} process ${proc.id}${proc.user ? ` (${proc.user}` : ''}${proc.user && proc.db ? ` on ${proc.db}` : ''}${proc.user ? ')' : ''}? Its running query will be aborted.`,
            confirmText: `${verb} ${proc.id}`,
            variant: 'danger',
        });
        if (!ok) return;
        setKilling(proc.id);
        try {
            if (isDocker) {
                await api.killDockerDbProcess(conn.container, proc.id, engineKind, conn.user, conn.password);
            } else {
                await api.killHostDbProcess(engineKind, proc.id);
            }
            toast.success(`Process ${proc.id} ${engineKind === 'postgresql' ? 'terminated' : 'killed'}`);
            load(true);
        } catch (err) {
            toast.error(err.message || `Failed to ${verb.toLowerCase()} process ${proc.id}`);
        } finally {
            setKilling(null);
        }
    }

    return (
        <div className="dbp">
            <div className="dbp-toolbar">
                <span className="dbp-count">
                    <Activity size={14} aria-hidden="true" />
                    {rows ? `${rows.length} process${rows.length === 1 ? '' : 'es'}` : 'Processes'}
                </span>
                <div className="dbp-toolbar-right">
                    <label className="dbp-auto">
                        <input
                            type="checkbox"
                            checked={autoRefresh}
                            onChange={(e) => setAutoRefresh(e.target.checked)}
                        />
                        <TimerReset size={13} aria-hidden="true" /> Auto-refresh (5s)
                    </label>
                    <button
                        type="button"
                        className="dbx-icon-btn"
                        onClick={() => load()}
                        disabled={loading}
                        aria-label="Refresh processes"
                        title="Refresh"
                    >
                        <RefreshCw size={14} className={loading ? 'dbx-spin' : ''} aria-hidden="true" />
                    </button>
                </div>
            </div>

            {error ? (
                <div className="dbp-error" role="alert">{error}</div>
            ) : rows && rows.length === 0 ? (
                <div className="dbp-empty">
                    <EmptyState
                        icon={Activity}
                        title="No processes"
                        description="No client sessions are currently connected to this server."
                    />
                </div>
            ) : (
                <div className="dbp-scroll">
                    <table className="dbp-table">
                        <thead>
                            <tr>
                                <th>ID</th>
                                <th>User</th>
                                <th>Database</th>
                                <th>{engineKind === 'postgresql' ? 'State' : 'Command'}</th>
                                <th>Time</th>
                                <th>Query</th>
                                {isAdmin && <th aria-label="Actions" />}
                            </tr>
                        </thead>
                        <tbody>
                            {(rows || []).map((p) => (
                                <tr key={p.id}>
                                    <td className="dbp-mono">{p.id}</td>
                                    <td>{p.user || '—'}</td>
                                    <td>{p.db || '—'}</td>
                                    <td>
                                        <span className="dbp-state">
                                            {engineKind === 'postgresql' ? (p.state || '—') : (p.command || p.state || '—')}
                                        </span>
                                    </td>
                                    <td className="dbp-mono">{formatTime(p.time_s)}</td>
                                    <td className="dbp-query" title={p.query || ''}>
                                        {p.query
                                            ? (p.query.length > QUERY_PREVIEW_LEN ? `${p.query.slice(0, QUERY_PREVIEW_LEN)}…` : p.query)
                                            : <span className="dbp-idle">idle</span>}
                                    </td>
                                    {isAdmin && (
                                        <td className="dbp-actions">
                                            <button
                                                type="button"
                                                className="dbx-icon-btn is-danger"
                                                onClick={() => killProcess(p)}
                                                disabled={killing === p.id}
                                                aria-label={`Kill process ${p.id}`}
                                                title={engineKind === 'postgresql' ? 'Terminate backend' : 'Kill process'}
                                            >
                                                <Ban size={14} aria-hidden="true" />
                                            </button>
                                        </td>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
