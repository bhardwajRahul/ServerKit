import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Cloud, ShieldCheck, Lock, Gauge, Database, Wand2 } from 'lucide-react';
import { PageTopbar } from '@/components/ds';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
    Select, SelectTrigger, SelectContent, SelectItem, SelectValue,
} from '@/components/ui/select';
import PageLoader from '../components/PageLoader';
import EmptyState from '../components/EmptyState';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';

// HSTS max-age presets (seconds). 0 disables the max-age while keeping HSTS off.
const HSTS_MAX_AGE = [
    { value: 0, label: 'Off' },
    { value: 86400, label: '1 day' },
    { value: 604800, label: '1 week' },
    { value: 2592000, label: '1 month' },
    { value: 15552000, label: '6 months' },
    { value: 31536000, label: '1 year' },
    { value: 63072000, label: '2 years' },
];

const TAB_ICONS = {
    ssl: <Lock size={15} />,
    speed: <Gauge size={15} />,
    caching: <Database size={15} />,
    security: <ShieldCheck size={15} />,
};

const CloudflareZoneSettings = () => {
    const { zoneId } = useParams();
    const toast = useToast();
    const { user } = useAuth();
    const isAdmin = !!user?.is_admin;

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [zone, setZone] = useState(null);
    const [groups, setGroups] = useState([]);
    const [settings, setSettings] = useState({});
    const [saving, setSaving] = useState(null);        // setting id in flight
    const [applying, setApplying] = useState(false);

    const loadSettings = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await api.getCloudflareZoneSettings(zoneId);
            setZone(data.zone || null);
            setGroups(data.groups || []);
            setSettings(data.settings || {});
        } catch (err) {
            setError(err.message || 'Failed to load Cloudflare settings');
        } finally {
            setLoading(false);
        }
    }, [zoneId]);

    useEffect(() => { loadSettings(); }, [loadSettings]);

    // Optimistically reflect the change, PATCH it, and reload truth on failure so
    // the UI never drifts from Cloudflare.
    const save = useCallback(async (settingId, value) => {
        setSaving(settingId);
        setSettings(prev => ({ ...prev, [settingId]: { ...(prev[settingId] || {}), value } }));
        try {
            await api.updateCloudflareZoneSetting(zoneId, settingId, value);
            toast.success('Setting saved');
        } catch (err) {
            toast.error(err.message || 'Failed to save setting');
            loadSettings();
        } finally {
            setSaving(null);
        }
    }, [zoneId, toast, loadSettings]);

    const handleApplyPreset = async () => {
        setApplying(true);
        try {
            const res = await api.applyCloudflareSettingsPreset(zoneId);
            const failed = (res.results || []).filter(r => !r.success);
            if (failed.length === 0) {
                toast.success(`Applied recommended hardening (${res.applied} settings)`);
            } else {
                toast.info(`Applied ${res.applied}/${res.total}. ${failed.length} need a higher Cloudflare plan.`);
            }
            loadSettings();
        } catch (err) {
            toast.error(err.message || 'Failed to apply preset');
        } finally {
            setApplying(false);
        }
    };

    if (loading) return <PageLoader />;

    const crumbs = (
        <span className="cf-crumbs">
            <Link to="/dns">DNS Zones</Link>
            <span className="cf-crumbs__sep">/</span>
            <span className="cf-crumbs__cur">{zone?.domain || `Zone ${zoneId}`}</span>
            <span className="cf-crumbs__sep">/</span>
            <span className="cf-crumbs__cur">Cloudflare</span>
        </span>
    );

    if (error) {
        return (
            <div className="app-detail-page app-detail-page--wide cf-zone">
                <PageTopbar icon={<Cloud size={18} />} title={crumbs} />
                <div className="cf-zone__body">
                    <EmptyState
                        icon={Cloud}
                        title="Cloudflare settings unavailable"
                        description={error}
                    />
                    <div className="cf-zone__error-actions">
                        <Button variant="outline" onClick={loadSettings}>Retry</Button>
                        <Link to="/dns"><Button variant="ghost">Back to DNS Zones</Button></Link>
                    </div>
                </div>
            </div>
        );
    }

    const tabGroups = groups.filter(g => g.settings?.length);
    const firstTab = tabGroups[0]?.key || 'actions';

    return (
        <div className="app-detail-page app-detail-page--wide cf-zone">
            <PageTopbar
                icon={<Cloud size={18} />}
                title={crumbs}
                meta={zone?.provider_zone_id ? `Zone ${zone.provider_zone_id}` : undefined}
            />

            <div className="cf-zone__body">
                <Tabs defaultValue={firstTab} className="cf-zone__tabs">
                    <TabsList>
                        {tabGroups.map(g => (
                            <TabsTrigger key={g.key} value={g.key}>
                                {TAB_ICONS[g.key]}{g.label}
                            </TabsTrigger>
                        ))}
                        <TabsTrigger value="actions"><Wand2 size={15} />Actions</TabsTrigger>
                    </TabsList>

                    {tabGroups.map(g => (
                        <TabsContent key={g.key} value={g.key}>
                            <div className="cf-panel">
                                {g.settings.map(setting => (
                                    <SettingRow
                                        key={setting.id}
                                        setting={setting}
                                        state={settings[setting.id]}
                                        saving={saving === setting.id}
                                        disabled={!isAdmin}
                                        onSave={save}
                                    />
                                ))}
                            </div>
                        </TabsContent>
                    ))}

                    <TabsContent value="actions">
                        <div className="cf-panel cf-actions">
                            <div className="cf-action">
                                <div className="cf-action__text">
                                    <h3>Apply recommended hardening</h3>
                                    <p>
                                        Sets Full (strict) SSL, Always Use HTTPS, HSTS (6 months),
                                        a TLS 1.2 floor with TLS 1.3, Brotli, HTTP/3, and a 4-hour
                                        browser cache. Settings your plan doesn&apos;t allow are skipped.
                                    </p>
                                </div>
                                <Button onClick={handleApplyPreset} disabled={applying || !isAdmin}>
                                    {applying ? 'Applying…' : 'Apply preset'}
                                </Button>
                            </div>
                            {!isAdmin && (
                                <p className="cf-actions__note">
                                    Changing Cloudflare settings requires an admin account.
                                </p>
                            )}
                        </div>
                    </TabsContent>
                </Tabs>
            </div>
        </div>
    );
};

// A single setting row — label + help on the left, the control on the right.
// Reads the current value/editability from the live settings state; renders the
// control declaratively from the setting's `type`.
function SettingRow({ setting, state, saving, disabled, onSave }) {
    const present = state !== undefined && state !== null;
    const editable = present ? state.editable !== false : false;
    const locked = disabled || !editable || saving;

    return (
        <div className="cf-setting">
            <div className="cf-setting__info">
                <span className="cf-setting__label">{setting.label}</span>
                {setting.help && <span className="cf-setting__help">{setting.help}</span>}
                {!present && (
                    <Badge variant="secondary" className="cf-setting__badge">
                        Not available on this zone
                    </Badge>
                )}
                {present && !editable && (
                    <Badge variant="secondary" className="cf-setting__badge">
                        Locked by your Cloudflare plan
                    </Badge>
                )}
            </div>
            <div className="cf-setting__control">
                <SettingControl
                    setting={setting}
                    value={present ? state.value : undefined}
                    locked={locked || !present}
                    onSave={onSave}
                />
            </div>
        </div>
    );
}

function SettingControl({ setting, value, locked, onSave }) {
    if (setting.type === 'toggle') {
        return (
            <Switch
                checked={value === 'on'}
                disabled={locked}
                onCheckedChange={(checked) => onSave(setting.id, checked ? 'on' : 'off')}
            />
        );
    }

    if (setting.type === 'select') {
        const current = value === undefined || value === null ? '' : String(value);
        return (
            <Select
                value={current}
                disabled={locked}
                onValueChange={(v) => {
                    const opt = setting.options.find(o => String(o.value) === v);
                    onSave(setting.id, opt ? opt.value : v);
                }}
            >
                <SelectTrigger className="cf-setting__select"><SelectValue /></SelectTrigger>
                <SelectContent>
                    {setting.options.map(o => (
                        <SelectItem key={String(o.value)} value={String(o.value)}>{o.label}</SelectItem>
                    ))}
                </SelectContent>
            </Select>
        );
    }

    if (setting.type === 'hsts') {
        return <HstsControl value={value} locked={locked} onSave={onSave} settingId={setting.id} />;
    }

    return null;
}

// HSTS is a compound object setting; editing any field re-sends the whole
// strict_transport_security object so the others are preserved.
function HstsControl({ value, locked, onSave, settingId }) {
    const sts = (value && value.strict_transport_security) || {};
    const enabled = !!sts.enabled;

    const patch = (changes) => {
        const next = {
            enabled: sts.enabled || false,
            max_age: sts.max_age || 0,
            include_subdomains: sts.include_subdomains || false,
            preload: sts.preload || false,
            nosniff: sts.nosniff !== undefined ? sts.nosniff : true,
            ...changes,
        };
        onSave(settingId, { strict_transport_security: next });
    };

    return (
        <div className="cf-hsts">
            <div className="cf-hsts__row">
                <span>Enabled</span>
                <Switch
                    checked={enabled}
                    disabled={locked}
                    onCheckedChange={(checked) => patch({
                        enabled: checked,
                        // Give a sane max-age when first enabling.
                        max_age: checked && !sts.max_age ? 15552000 : sts.max_age || 0,
                    })}
                />
            </div>
            {enabled && (
                <>
                    <div className="cf-hsts__row">
                        <span>Max age</span>
                        <Select
                            value={String(sts.max_age || 0)}
                            disabled={locked}
                            onValueChange={(v) => patch({ max_age: Number(v) })}
                        >
                            <SelectTrigger className="cf-setting__select"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {HSTS_MAX_AGE.map(o => (
                                    <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="cf-hsts__row">
                        <span>Include subdomains</span>
                        <Switch
                            checked={!!sts.include_subdomains}
                            disabled={locked}
                            onCheckedChange={(checked) => patch({ include_subdomains: checked })}
                        />
                    </div>
                    <div className="cf-hsts__row">
                        <span>Preload</span>
                        <Switch
                            checked={!!sts.preload}
                            disabled={locked}
                            onCheckedChange={(checked) => patch({ preload: checked })}
                        />
                    </div>
                </>
            )}
        </div>
    );
}

export default CloudflareZoneSettings;
