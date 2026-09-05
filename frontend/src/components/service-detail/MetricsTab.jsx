import { useCallback, useState, useEffect, useRef } from 'react';
import api from '../../services/api';
import { Gauge } from '@/components/ds';
import EmptyState from '../EmptyState';
import { usePolling } from '@/hooks/usePolling';
import { useTranslation } from 'react-i18next';

// Live metrics cadence.
const METRICS_REFRESH_MS = 10000;


const MetricsTabContent = ({ app }) => {
    const { t } = useTranslation();
    const [stats, setStats] = useState(null);
    const [processInfo, setProcessInfo] = useState(null);
    const [loading, setLoading] = useState(true);
    const requestId = useRef(0);

    const isDocker = app.app_type === 'docker';
    const isPython = ['flask', 'django'].includes(app.app_type);

    // Load on mount and whenever the app changes; poll on top of that.
    const loadMetrics = useCallback(async () => {
        const currentRequest = ++requestId.current;
        try {
            if (isDocker) {
                const data = await api.getContainers(true);
                const appContainers = (data.containers || []).filter(c =>
                    c.Names?.some(n => n.includes(app.name)) ||
                    c.Labels?.['com.docker.compose.project'] === app.name
                );

                if (appContainers.length > 0) {
                    const containerStats = await api.getContainerStats(appContainers[0].Id);
                    if (currentRequest === requestId.current) setStats(containerStats);
                } else if (currentRequest === requestId.current) {
                    setStats(null);
                }
            } else if (isPython) {
                const data = await api.getPythonAppStatus(app.id);
                if (currentRequest === requestId.current) setProcessInfo(data);
            }
        } catch (err) {
            if (currentRequest !== requestId.current) return;
            setStats(null);
            setProcessInfo(null);
            console.error('Failed to load metrics:', err);
        } finally {
            if (currentRequest === requestId.current) setLoading(false);
        }
    }, [app.id, app.name, isDocker, isPython]);

    useEffect(() => {
        loadMetrics();
        return () => { requestId.current += 1; };
    }, [loadMetrics]);
    usePolling(loadMetrics, METRICS_REFRESH_MS, { immediate: false });


    if (loading) {
        return <EmptyState loading title={t('app.metricsTab.loadingMetrics', 'Loading metrics…')} />;
    }

    if (isDocker && stats) {
        const cpuPercent = parseFloat(stats.cpu_percent || stats.CPUPerc || 0);
        const memPercent = parseFloat(stats.memory_percent || stats.MemPerc || 0);
        const memUsage = stats.memory_usage || stats.MemUsage || 'N/A';
        const netIO = stats.net_io || stats.NetIO || 'N/A';
        const blockIO = stats.block_io || stats.BlockIO || 'N/A';
        const pids = stats.pids || stats.PIDs || 'N/A';

        return (
            <div className="metrics-tab">
                <div className="metrics-tab__grid">
                    <div className="metrics-tab__card">
                        <div className="metrics-tab__card-header">
                            <h4>{t('app.metricsTab.cpuUsage', 'CPU Usage')}</h4>
                            <span>{cpuPercent.toFixed(1)}%</span>
                        </div>
                        <Gauge value={cpuPercent} />
                    </div>

                    <div className="metrics-tab__card">
                        <div className="metrics-tab__card-header">
                            <h4>{t('app.metricsTab.memoryUsage', 'Memory Usage')}</h4>
                            <span>{memPercent.toFixed(1)}%</span>
                        </div>
                        <Gauge value={memPercent} />
                        <div className="metrics-tab__info">{memUsage}</div>
                    </div>

                    <div className="metrics-tab__card">
                        <div className="metrics-tab__card-header">
                            <h4>{t('app.metricsTab.networkIO', 'Network I/O')}</h4>
                        </div>
                        <div className="metrics-tab__info">{netIO}</div>
                    </div>

                    <div className="metrics-tab__card">
                        <div className="metrics-tab__card-header">
                            <h4>{t('app.metricsTab.blockIO', 'Block I/O')}</h4>
                        </div>
                        <div className="metrics-tab__info">{blockIO}</div>
                    </div>

                    <div className="metrics-tab__card">
                        <div className="metrics-tab__card-header">
                            <h4>{t('app.metricsTab.processes', 'Processes')}</h4>
                            <span>{pids}</span>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    if (isPython && processInfo) {
        return (
            <div className="metrics-tab">
                <div className="metrics-tab__grid">
                    <div className="metrics-tab__card">
                        <div className="metrics-tab__card-header">
                            <h4>{t('app.metricsTab.serviceStatus', 'Service Status')}</h4>
                        </div>
                        <div className="metrics-tab__info">
                            {processInfo.active ? 'Active (running)' : 'Inactive'}
                        </div>
                    </div>

                    {processInfo.pid && (
                        <div className="metrics-tab__card">
                            <div className="metrics-tab__card-header">
                                <h4>{t('app.metricsTab.processId', 'Process ID')}</h4>
                                <span>{processInfo.pid}</span>
                            </div>
                        </div>
                    )}

                    {processInfo.memory && (
                        <div className="metrics-tab__card">
                            <div className="metrics-tab__card-header">
                                <h4>{t('common.labels.memory', 'Memory')}</h4>
                                <span>{processInfo.memory}</span>
                            </div>
                        </div>
                    )}

                    {processInfo.uptime && (
                        <div className="metrics-tab__card">
                            <div className="metrics-tab__card-header">
                                <h4>{t('common.labels.uptime', 'Uptime')}</h4>
                            </div>
                            <div className="metrics-tab__info">{processInfo.uptime}</div>
                        </div>
                    )}

                    {processInfo.workers && (
                        <div className="metrics-tab__card">
                            <div className="metrics-tab__card-header">
                                <h4>{t('app.metricsTab.workers', 'Workers')}</h4>
                                <span>{processInfo.workers}</span>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    return (
        <EmptyState
            title={t('app.metricsTab.noMetricsAvailable', 'No metrics available')}
            description={t('app.metricsTab.startTheServiceToViewResource', 'Start the service to view resource metrics.')}
        />
    );
};

export default function MetricsTab({ app }) {
    // A new runtime starts with empty state before its first request resolves.
    // Old requests belong to the unmounted instance and cannot update this one.
    const runtimeKey = JSON.stringify([app.id, app.name, app.app_type, app.server_id, app.container_id]);
    return <MetricsTabContent key={runtimeKey} app={app} />;
}
