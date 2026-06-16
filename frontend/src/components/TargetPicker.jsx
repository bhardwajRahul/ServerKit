import { useState, useEffect, useMemo } from 'react';
import { Server } from 'lucide-react';
import { api } from '../services/api';

// TargetPicker — a small reusable selector for "local panel host vs.
// connected agent." Used by the Cron, Cloudflared, and File Manager
// pages to switch which server an action runs against.
//
// `feature` gates the agent list: only agents that report
// capabilities[feature] === true are shown. Agents that haven't
// reported capabilities yet (older builds) are filtered out — same
// pattern as the cron picker.
//
// onChange receives `{ kind: 'local' } | { kind: 'agent', server_id, name, allowedPaths }`,
// or `{ kind: <extra.value> }` for any caller-supplied `extraOptions` (e.g. an
// "S3 bucket" target in the File Manager).
export default function TargetPicker({ feature, value, onChange, includeLocal = true, extraOptions = [] }) {
    const [servers, setServers] = useState([]);

    useEffect(() => {
        let cancelled = false;
        api.getAvailableServers()
            .then(data => { if (!cancelled) setServers(Array.isArray(data) ? data : []); })
            .catch(() => { if (!cancelled) setServers([]); });
        return () => { cancelled = true; };
    }, []);

    const eligible = useMemo(() => {
        return servers.filter(s => {
            if (s.id === 'local') return false; // handled separately
            if (s.status !== 'online') return false;
            if (!feature) return true;
            return s.capabilities && s.capabilities[feature];
        });
    }, [servers, feature]);

    function handleChange(e) {
        const id = e.target.value;
        if (id === 'local') {
            onChange({ kind: 'local' });
            return;
        }
        if (extraOptions.some(o => o.value === id)) {
            onChange({ kind: id });
            return;
        }
        const s = eligible.find(x => x.id === id);
        if (!s) return;
        onChange({
            kind: 'agent',
            server_id: s.id,
            name: s.name || s.hostname || s.id,
            allowedPaths: s.allowed_paths || [],
        });
    }

    const selectValue = value?.kind === 'agent'
        ? value.server_id
        : (value?.kind && value.kind !== 'local' ? value.kind : 'local');

    return (
        <div className="target-picker">
            <Server size={14} className="target-picker__icon" />
            <select value={selectValue} onChange={handleChange} className="target-picker__select">
                {includeLocal && <option value="local">Local (this server)</option>}
                {eligible.map(s => (
                    <option key={s.id} value={s.id}>
                        {s.name || s.hostname || s.id}
                    </option>
                ))}
                {extraOptions.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                ))}
            </select>
        </div>
    );
}
