import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import useTabParam from '../hooks/useTabParam';
import api from '../services/api';
import {
    OverviewTab,
    FirewallTab,
    Fail2banTab,
    SSHKeysTab,
    IPListsTab,
    ScannerTab,
    QuarantineTab,
    IntegrityTab,
    AuditTab,
    VulnerabilityTab,
    AutoUpdatesTab,
    EventsTab,
    SecurityConfigTab,
} from '../components/security';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import EmptyState from '../components/EmptyState';
import { PageTopbar, MetricCard } from '@/components/ds';
import { Siren, Bug, ShieldCheck, Radar } from 'lucide-react';

const VALID_TABS = ['overview', 'firewall', 'fail2ban', 'ssh-keys', 'ip-lists', 'scanner', 'quarantine', 'integrity', 'audit', 'vulnerability', 'updates', 'events', 'settings'];

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const Security = () => {
    const { isAdmin } = useAuth();
    const [activeTab, setActiveTab] = useTabParam('/security', VALID_TABS);
    const [status, setStatus] = useState(null);
    const [clamav, setClamav] = useState(null);
    const [clamavLoading, setClamavLoading] = useState(true);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadStatus();
        loadClamav();
    }, []);

    async function loadStatus() {
        try {
            const data = await api.getSecurityStatus();
            setStatus(data);
        } catch (err) {
            console.error('Failed to load security status:', err);
        } finally {
            setLoading(false);
        }
    }

    async function loadClamav() {
        try {
            const data = await api.getClamAVStatus();
            setClamav(data);
        } catch (err) {
            console.error('Failed to load ClamAV status:', err);
        } finally {
            setClamavLoading(false);
        }
    }

    if (loading) {
        return (
            <div className="page-container security-page">
                <EmptyState loading title="Loading security status..." />
            </div>
        );
    }

    const alerts = status?.recent_alerts || {};
    const scanRunning = status?.scan_status === 'running';

    return (
        <div className="page-container security-page">
            <PageTopbar icon={<ShieldCheck size={18} />} title="Security" />

            <div className="sec-kpis" role="group" aria-label="Security overview">
                <MetricCard
                    tone={alerts.total > 0 ? 'amber' : 'green'}
                    icon={<Siren size={16} />}
                    value={alerts.total || 0}
                    label="Alerts (24h)"
                />
                <MetricCard
                    tone={alerts.malware_detections > 0 ? 'red' : 'green'}
                    icon={<Bug size={16} />}
                    value={alerts.malware_detections || 0}
                    label="Malware detected"
                />
                <MetricCard
                    className="sec-kpi-text"
                    tone={clamav?.installed ? 'green' : 'amber'}
                    icon={<ShieldCheck size={16} />}
                    value={clamav?.installed ? 'Active' : 'Not installed'}
                    label="ClamAV"
                />
                <MetricCard
                    className="sec-kpi-text"
                    tone={scanRunning ? 'cyan' : 'accent'}
                    icon={<Radar size={16} />}
                    value={capitalize(status?.scan_status) || 'Idle'}
                    label="Scan status"
                />
            </div>

            <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList>
                    <TabsTrigger value="overview">Overview</TabsTrigger>
                    <TabsTrigger value="firewall">Firewall</TabsTrigger>
                    <TabsTrigger value="fail2ban">Fail2ban</TabsTrigger>
                    <TabsTrigger value="ssh-keys">SSH Keys</TabsTrigger>
                    <TabsTrigger value="ip-lists">IP Lists</TabsTrigger>
                    <TabsTrigger value="scanner">Malware Scanner</TabsTrigger>
                    <TabsTrigger value="quarantine">Quarantine</TabsTrigger>
                    <TabsTrigger value="integrity">File Integrity</TabsTrigger>
                    <TabsTrigger value="audit">Audit</TabsTrigger>
                    <TabsTrigger value="vulnerability">Vulnerability Scan</TabsTrigger>
                    <TabsTrigger value="updates">Auto Updates</TabsTrigger>
                    <TabsTrigger value="events">Events</TabsTrigger>
                    <TabsTrigger value="settings">Settings</TabsTrigger>
                </TabsList>

                <div className="tab-content">
                    <TabsContent value="overview"><OverviewTab status={status} clamavStatus={clamav} clamavLoading={clamavLoading} onRefreshClamav={loadClamav} /></TabsContent>
                    <TabsContent value="firewall"><FirewallTab /></TabsContent>
                    <TabsContent value="fail2ban"><Fail2banTab /></TabsContent>
                    <TabsContent value="ssh-keys"><SSHKeysTab /></TabsContent>
                    <TabsContent value="ip-lists"><IPListsTab /></TabsContent>
                    <TabsContent value="scanner"><ScannerTab /></TabsContent>
                    <TabsContent value="quarantine"><QuarantineTab /></TabsContent>
                    <TabsContent value="integrity"><IntegrityTab /></TabsContent>
                    <TabsContent value="audit"><AuditTab /></TabsContent>
                    <TabsContent value="vulnerability"><VulnerabilityTab /></TabsContent>
                    <TabsContent value="updates"><AutoUpdatesTab /></TabsContent>
                    <TabsContent value="events"><EventsTab /></TabsContent>
                    <TabsContent value="settings"><SecurityConfigTab /></TabsContent>
                </div>
            </Tabs>
        </div>
    );
};

export default Security;
