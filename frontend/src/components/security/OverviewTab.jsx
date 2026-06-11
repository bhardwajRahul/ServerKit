import React, { useState } from 'react';
import api from '../../services/api';
import { Button } from '@/components/ui/button';
import { Pill } from '@/components/ds';

const InstallClamAVButton = ({ onInstalled }) => {
    const [installing, setInstalling] = useState(false);
    const [error, setError] = useState(null);

    async function handleInstall() {
        setInstalling(true);
        setError(null);
        try {
            await api.installClamAV();
            onInstalled();
        } catch (err) {
            setError(err.message);
        } finally {
            setInstalling(false);
        }
    }

    return (
        <div>
            <Button variant="default" onClick={handleInstall} disabled={installing}>
                {installing ? 'Installing...' : 'Install ClamAV'}
            </Button>
            {error && <p className="error-text" style={{ marginTop: '0.5rem' }}>{error}</p>}
        </div>
    );
};

const OverviewTab = ({ status, clamavStatus, clamavLoading, onRefreshClamav }) => {
    const alerts = status?.recent_alerts || {};
    const loading = clamavLoading;
    const integrityChanges = alerts.integrity_changes || 0;

    return (
        <div className="security-overview">
            <div className="security-grid">
                <div className="card">
                    <div className="card-header">
                        <h3>ClamAV Antivirus</h3>
                        <Button variant="outline" size="sm" onClick={onRefreshClamav}>Refresh</Button>
                    </div>
                    <div className="card-body">
                        {loading ? (
                            <div className="loading-sm">Loading...</div>
                        ) : clamavStatus?.installed ? (
                            <div className="sec-rows">
                                <div className="sk-info-row">
                                    <span className="k">Version</span>
                                    <span className="v">{clamavStatus.version || 'Unknown'}</span>
                                </div>
                                <div className="sk-info-row">
                                    <span className="k">Service</span>
                                    <Pill kind={clamavStatus.service_running ? 'green' : 'amber'}>
                                        {clamavStatus.service_running ? 'Running' : 'Stopped'}
                                    </Pill>
                                </div>
                                <div className="sk-info-row">
                                    <span className="k">Last definition update</span>
                                    <span className="v">{clamavStatus.last_update ? new Date(clamavStatus.last_update).toLocaleString() : 'Unknown'}</span>
                                </div>
                            </div>
                        ) : (
                            <div className="not-installed">
                                <p>ClamAV is not installed on this server.</p>
                                <InstallClamAVButton onInstalled={onRefreshClamav} />
                            </div>
                        )}
                    </div>
                </div>

                <div className="card">
                    <div className="card-header">
                        <h3>File Integrity Monitoring</h3>
                    </div>
                    <div className="card-body">
                        <div className="sec-rows">
                            <div className="sk-info-row">
                                <span className="k">Status</span>
                                <Pill kind={status?.file_integrity?.enabled ? 'green' : 'gray'}>
                                    {status?.file_integrity?.enabled ? 'Enabled' : 'Disabled'}
                                </Pill>
                            </div>
                            <div className="sk-info-row">
                                <span className="k">Database</span>
                                <Pill kind={status?.file_integrity?.database_exists ? 'green' : 'amber'}>
                                    {status?.file_integrity?.database_exists ? 'Initialized' : 'Not Initialized'}
                                </Pill>
                            </div>
                            <div className="sk-info-row">
                                <span className="k">Changes detected (24h)</span>
                                <span className={`v ${integrityChanges > 0 ? 'sec-v-amber' : ''}`}>{integrityChanges}</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="card">
                    <div className="card-header">
                        <h3>Notifications</h3>
                    </div>
                    <div className="card-body">
                        <div className="sec-rows">
                            <div className="sk-info-row">
                                <span className="k">Security alerts</span>
                                <Pill kind={status?.notifications_enabled ? 'green' : 'gray'}>
                                    {status?.notifications_enabled ? 'Enabled' : 'Disabled'}
                                </Pill>
                            </div>
                        </div>
                        <p className="sec-hint">
                            Configure notification channels in Settings → Notifications to receive security alerts via Discord, Slack, or Telegram.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default OverviewTab;
