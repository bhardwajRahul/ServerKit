import React, { useState } from 'react';
import api from '../../services/api';
import { InfoList, InfoItem } from '../InfoList';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

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
                            <InfoList>
                                <InfoItem label="Version" value={clamavStatus.version || 'Unknown'} />
                                <InfoItem label="Service">
                                    <Badge variant={clamavStatus.service_running ? 'success' : 'warning'}>
                                        {clamavStatus.service_running ? 'Running' : 'Stopped'}
                                    </Badge>
                                </InfoItem>
                                <InfoItem
                                    label="Last Definition Update"
                                    value={clamavStatus.last_update ? new Date(clamavStatus.last_update).toLocaleString() : 'Unknown'}
                                />
                            </InfoList>
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
                        <InfoList>
                            <InfoItem label="Status">
                                <Badge variant={status?.file_integrity?.enabled ? 'success' : 'secondary'}>
                                    {status?.file_integrity?.enabled ? 'Enabled' : 'Disabled'}
                                </Badge>
                            </InfoItem>
                            <InfoItem label="Database">
                                <Badge variant={status?.file_integrity?.database_exists ? 'success' : 'warning'}>
                                    {status?.file_integrity?.database_exists ? 'Initialized' : 'Not Initialized'}
                                </Badge>
                            </InfoItem>
                            <InfoItem label="Changes Detected (24h)" value={alerts.integrity_changes || 0} />
                        </InfoList>
                    </div>
                </div>

                <div className="card">
                    <div className="card-header">
                        <h3>Notifications</h3>
                    </div>
                    <div className="card-body">
                        <InfoList>
                            <InfoItem label="Security Alerts">
                                <Badge variant={status?.notifications_enabled ? 'success' : 'secondary'}>
                                    {status?.notifications_enabled ? 'Enabled' : 'Disabled'}
                                </Badge>
                            </InfoItem>
                        </InfoList>
                        <p className="help-text" style={{ marginTop: '1rem' }}>
                            Configure notification channels in Settings → Notifications to receive security alerts via Discord, Slack, or Telegram.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default OverviewTab;
