import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import api from '../services/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../hooks/useConfirm';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useService } from '../hooks/useService';
import { getTabsForType } from '../utils/serviceTypes';
import EnvironmentVariables from '../components/EnvironmentVariables';
import EventsTab from '../components/service-detail/EventsTab';
import LogsTab from '../components/service-detail/LogsTab';
import ShellTab from '../components/service-detail/ShellTab';
import SettingsTab from '../components/service-detail/SettingsTab';
import MetricsTab from '../components/service-detail/MetricsTab';
import PackagesTab from '../components/service-detail/PackagesTab';
import GunicornTab from '../components/service-detail/GunicornTab';
import CommandsTab from '../components/service-detail/CommandsTab';
import GitConnectModal from '../components/service-detail/GitConnectModal';
import OverviewTab from '../components/service-detail/OverviewTab';
import EmptyState from '../components/EmptyState';
import { Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Pill, ServiceTile } from '@/components/ds';

// statusInfo.dotClass → ds Pill kind
const STATUS_PILL = {
    live: 'green',
    stopped: 'gray',
    deploying: 'amber',
    building: 'amber',
    failed: 'red',
};

const TAB_LABELS = {
    overview: 'Overview',
    events: 'Events',
    logs: 'Logs',
    environment: 'Environment',
    shell: 'Shell',
    metrics: 'Metrics',
    packages: 'Packages',
    gunicorn: 'Gunicorn',
    commands: 'Commands',
    settings: 'Settings',
};

const ServiceDetail = () => {
    const { id } = useParams();
    const navigate = useNavigate();
    const toast = useToast();
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm();
    const { service, deployConfig, loading, error, reload, performAction, deleteService } = useService(id);
    const [activeTab, setActiveTab] = useState('overview');
    const [showDeployMenu, setShowDeployMenu] = useState(false);
    const [showMoreMenu, setShowMoreMenu] = useState(false);
    const [showGitModal, setShowGitModal] = useState(false);
    const [actionLoading, setActionLoading] = useState(null);
    const deployMenuRef = useRef(null);
    const moreMenuRef = useRef(null);

    // Redirect WordPress apps
    useEffect(() => {
        if (service && service.app_type === 'wordpress') {
            navigate(`/wordpress/${id}`, { replace: true });
        }
    }, [service, id, navigate]);

    // Close menus on outside click
    useEffect(() => {
        const handleClick = (e) => {
            if (deployMenuRef.current && !deployMenuRef.current.contains(e.target)) {
                setShowDeployMenu(false);
            }
            if (moreMenuRef.current && !moreMenuRef.current.contains(e.target)) {
                setShowMoreMenu(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, []);

    async function handleAction(action) {
        setActionLoading(action);
        try {
            await performAction(action);
            toast.success(`Service ${action}ed successfully`);
        } catch (err) {
            toast.error(`Failed to ${action} service`);
        } finally {
            setActionLoading(null);
            setShowDeployMenu(false);
            setShowMoreMenu(false);
        }
    }

    async function handleDeployLatest() {
        setActionLoading('deploy-latest');
        try {
            let hasBuildConfig = false;
            try {
                const buildConfig = await api.getBuildConfig(service.id);
                hasBuildConfig = Boolean(buildConfig.configured);
            } catch {
                hasBuildConfig = false;
            }

            if (hasBuildConfig) {
                await api.deployApp(service.id);
            } else {
                await api.triggerAppDeploy(service.id, true);
            }
            toast.success('Deployment started');
            await reload();
        } catch (err) {
            toast.error(err.message || 'Failed to deploy latest commit');
        } finally {
            setActionLoading(null);
            setShowDeployMenu(false);
        }
    }

    async function handleDelete() {
        const firstConfirm = await confirm({ title: 'Delete Service', message: `Delete ${service.name}? This action cannot be undone.` });
        if (!firstConfirm) return;
        const secondConfirm = await confirm({ title: 'Confirm Deletion', message: 'Are you sure? This will permanently remove the service and all its data.' });
        if (!secondConfirm) return;

        setActionLoading('delete');
        try {
            await deleteService();
            navigate('/services');
        } catch (err) {
            toast.error('Failed to delete service');
            setActionLoading(null);
        }
    }

    if (loading) {
        return <EmptyState loading title="Loading service" />;
    }

    if (error || !service) {
        return (
            <EmptyState
                icon={Layers}
                title="Service not found"
                description={error || 'The service you are looking for does not exist.'}
                action={<Button onClick={() => navigate('/services')}>Back to Services</Button>}
            />
        );
    }

    const availableTabs = getTabsForType(service.app_type);

    return (
        <div className="page-container svc-detail">
            {/* Breadcrumb */}
            <div className="svc-detail__breadcrumb">
                <Link to="/services">Services</Link>
                <span className="svc-detail__breadcrumb-sep">/</span>
                <span className="svc-detail__breadcrumb-current">{service.name}</span>
            </div>

            {/* Header */}
            <div className="svc-detail__header">
                <div className="svc-detail__header-left">
                    <ServiceTile name={service.name} size={52} className="svc-detail__tile" />
                    <div className="svc-detail__title-block">
                        <div className="svc-detail__title-row">
                            <h1>{service.name}</h1>
                            <Pill kind={STATUS_PILL[service.statusInfo.dotClass] || 'gray'}>
                                {service.statusInfo.label}
                            </Pill>
                            <span
                                className="svc-detail__type-badge"
                                style={{ backgroundColor: service.typeInfo.bgColor, color: service.typeInfo.color, borderColor: service.typeInfo.borderColor }}
                            >
                                {service.typeInfo.label}
                            </span>
                        </div>
                        <div className="svc-detail__subtitle">
                            {service.port && <span>Port {service.port}</span>}
                            {service.port && <span className="svc-detail__sep">&middot;</span>}
                            <span>Created {new Date(service.created_at).toLocaleDateString()}</span>
                            {service.domain && (
                                <>
                                    <span className="svc-detail__sep">&middot;</span>
                                    <a
                                        href={`https://${service.domain}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >
                                        {service.domain}
                                    </a>
                                </>
                            )}
                        </div>
                    </div>
                </div>

                <div className="svc-detail__header-actions">
                    {/* Deploy dropdown */}
                    <div className="svc-detail__dropdown" ref={deployMenuRef}>
                        <Button onClick={() => setShowDeployMenu(!showDeployMenu)}>
                            Deploy
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ml-1">
                                <polyline points="6 9 12 15 18 9"/>
                            </svg>
                        </Button>
                        {showDeployMenu && (
                            <div className="svc-detail__dropdown-menu">
                                <button onClick={() => handleAction('restart')} disabled={actionLoading === 'restart'}>
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <polyline points="23 4 23 10 17 10"/>
                                        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                                    </svg>
                                    Manual Deploy (Restart)
                                </button>
                                {deployConfig && (
                                    <button onClick={handleDeployLatest} disabled={actionLoading === 'deploy-latest'}>
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <circle cx="18" cy="18" r="3"/>
                                            <circle cx="6" cy="6" r="3"/>
                                            <path d="M6 21V9a9 9 0 0 0 9 9"/>
                                        </svg>
                                        {actionLoading === 'deploy-latest' ? 'Deploying...' : 'Deploy Latest Commit'}
                                    </button>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Restart button */}
                    {service.isRunning && (
                        <Button
                            variant="outline"
                            onClick={() => handleAction('restart')}
                            disabled={actionLoading === 'restart'}
                        >
                            {actionLoading === 'restart' ? 'Restarting...' : 'Restart'}
                        </Button>
                    )}

                    {/* Start/Stop */}
                    {!service.isRunning && (
                        <Button
                            variant="outline"
                            onClick={() => handleAction('start')}
                            disabled={actionLoading === 'start'}
                        >
                            {actionLoading === 'start' ? 'Starting...' : 'Start'}
                        </Button>
                    )}

                    {/* Three-dot menu */}
                    <div className="svc-detail__dropdown" ref={moreMenuRef}>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setShowMoreMenu(!showMoreMenu)}
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                <circle cx="12" cy="5" r="2"/>
                                <circle cx="12" cy="12" r="2"/>
                                <circle cx="12" cy="19" r="2"/>
                            </svg>
                        </Button>
                        {showMoreMenu && (
                            <div className="svc-detail__dropdown-menu svc-detail__dropdown-menu--right">
                                {service.isRunning && (
                                    <button onClick={() => handleAction('stop')} disabled={actionLoading === 'stop'}>
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                            <rect x="6" y="6" width="12" height="12"/>
                                        </svg>
                                        Suspend Service
                                    </button>
                                )}
                                {service.port && (
                                    <a
                                        href={`http://localhost:${service.port}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={() => setShowMoreMenu(false)}
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                                            <polyline points="15 3 21 3 21 9"/>
                                            <line x1="10" y1="14" x2="21" y2="3"/>
                                        </svg>
                                        Open in Browser
                                    </a>
                                )}
                                <div className="svc-detail__dropdown-divider" />
                                <button
                                    className="svc-detail__dropdown-danger"
                                    onClick={handleDelete}
                                    disabled={actionLoading === 'delete'}
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <polyline points="3 6 5 6 21 6"/>
                                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                                    </svg>
                                    Delete Service
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Repo Connection Pill */}
            <div className="svc-detail__repo-bar">
                {deployConfig ? (
                    <div className="svc-detail__repo-pill" onClick={() => setShowGitModal(true)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="18" cy="18" r="3"/>
                            <circle cx="6" cy="6" r="3"/>
                            <path d="M6 21V9a9 9 0 0 0 9 9"/>
                        </svg>
                        <span className="svc-detail__repo-url">{extractRepoDisplay(deployConfig.repo_url)}</span>
                        <span className="svc-detail__repo-arrow">&rarr;</span>
                        <span className="svc-detail__repo-branch">{deployConfig.branch || 'main'}</span>
                        {deployConfig.auto_deploy && (
                            <span className="svc-detail__auto-deploy-badge">Auto</span>
                        )}
                    </div>
                ) : (
                    <button className="svc-detail__connect-repo" onClick={() => setShowGitModal(true)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="18" cy="18" r="3"/>
                            <circle cx="6" cy="6" r="3"/>
                            <path d="M6 21V9a9 9 0 0 0 9 9"/>
                        </svg>
                        Connect a repository
                    </button>
                )}
            </div>

            {/* Tab Bar */}
            <div className="svc-detail__tabs">
                {availableTabs.map(tab => (
                    <button
                        key={tab}
                        className={`svc-detail__tab ${activeTab === tab ? 'svc-detail__tab--active' : ''}`}
                        onClick={() => setActiveTab(tab)}
                    >
                        {TAB_LABELS[tab] || tab}
                    </button>
                ))}
            </div>

            {/* Tab Content */}
            <div className="svc-detail__content">
                {activeTab === 'overview' && <OverviewTab app={service} deployConfig={deployConfig} />}
                {activeTab === 'events' && <EventsTab appId={service.id} />}
                {activeTab === 'logs' && <LogsTab app={service} />}
                {activeTab === 'environment' && <EnvironmentVariables appId={service.id} />}
                {activeTab === 'shell' && service.isDocker && <ShellTab appId={service.id} appName={service.name} />}
                {activeTab === 'metrics' && <MetricsTab app={service} />}
                {activeTab === 'packages' && service.isPython && <PackagesTab appId={service.id} />}
                {activeTab === 'gunicorn' && service.isPython && <GunicornTab appId={service.id} />}
                {activeTab === 'commands' && service.isPython && <CommandsTab appId={service.id} appType={service.app_type} />}
                {activeTab === 'settings' && (
                    <SettingsTab
                        app={service}
                        deployConfig={deployConfig}
                        onUpdate={reload}
                        onOpenGitModal={() => setShowGitModal(true)}
                    />
                )}
            </div>

            {/* Git Connect Modal */}
            {showGitModal && (
                <GitConnectModal
                    appId={service.id}
                    deployConfig={deployConfig}
                    onClose={() => setShowGitModal(false)}
                    onSaved={() => {
                        setShowGitModal(false);
                        reload();
                    }}
                />
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

function extractRepoDisplay(url) {
    if (!url) return '';
    try {
        const cleaned = url.replace(/\.git$/, '').replace(/^https?:\/\/[^@]+@/, 'https://');
        const parts = cleaned.split(/[/:]/).filter(Boolean);
        return parts.slice(-2).join('/');
    } catch {
        return url;
    }
}

export default ServiceDetail;
