import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Github, KeyRound, Link2, PlugZap, Shield, Trash2 } from 'lucide-react';
import api from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const SourceConnectionsTab = () => {
    const { isAdmin } = useAuth();
    const toast = useToast();
    const [status, setStatus] = useState(null);
    const [config, setConfig] = useState({ client_id: '', client_secret: '' });
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [connecting, setConnecting] = useState(false);

    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            const statusData = await api.getGithubSourceStatus();
            setStatus(statusData);

            if (isAdmin) {
                const configData = await api.getGithubSourceConfig();
                setConfig({
                    client_id: configData.config?.client_id || '',
                    client_secret: configData.config?.client_secret || '',
                });
            }
        } catch (err) {
            toast.error(err.message || 'Failed to load source connections');
        } finally {
            setLoading(false);
        }
    }, [isAdmin, toast]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    async function handleSaveConfig(e) {
        e.preventDefault();
        setSaving(true);
        try {
            const result = await api.updateGithubSourceConfig(config);
            setConfig({
                client_id: result.config?.client_id || '',
                client_secret: result.config?.client_secret || '',
            });
            toast.success('GitHub connection settings saved');
            await loadData();
        } catch (err) {
            toast.error(err.message || 'Failed to save GitHub settings');
        } finally {
            setSaving(false);
        }
    }

    async function handleConnect() {
        setConnecting(true);
        try {
            const redirectUri = `${window.location.origin}/connections/callback/github`;
            sessionStorage.setItem('sourceConnectionReturnTo', '/settings/connections');
            const { auth_url } = await api.startSourceConnection('github', redirectUri);
            window.location.href = auth_url;
        } catch (err) {
            toast.error(err.message || 'Failed to start GitHub connection');
            setConnecting(false);
        }
    }

    async function handleDisconnect() {
        try {
            await api.disconnectSourceConnection('github');
            toast.success('GitHub disconnected');
            await loadData();
        } catch (err) {
            toast.error(err.message || 'Failed to disconnect GitHub');
        }
    }

    const connection = status?.connection;
    const configured = status?.configured;

    if (loading) {
        return <div className="settings-section"><p>Loading source connections...</p></div>;
    }

    return (
        <div className="settings-section source-connections">
            <div className="section-header">
                <h2>Connections</h2>
                <p>Connect source providers so services can be created from repository pickers instead of clone URLs.</p>
            </div>

            <div className="settings-card source-connection-card">
                <div className="settings-card__header">
                    <div className="settings-card__header-left">
                        <Github size={22} />
                        <div>
                            <h3>GitHub</h3>
                            <p>Use the GitHub API to list repositories and import selected branches.</p>
                        </div>
                    </div>
                    <span className={`source-connection-status ${connection ? 'source-connection-status--connected' : ''}`}>
                        {connection ? <CheckCircle2 size={14} /> : <PlugZap size={14} />}
                        {connection ? 'Connected' : 'Not connected'}
                    </span>
                </div>

                {connection ? (
                    <div className="source-connection-profile">
                        {connection.avatar_url && <img src={connection.avatar_url} alt="" />}
                        <div>
                            <strong>{connection.display_name || connection.provider_username}</strong>
                            <span>@{connection.provider_username}</span>
                        </div>
                        <Button type="button" variant="outline" onClick={handleDisconnect}>
                            <Trash2 size={16} />
                            Disconnect
                        </Button>
                    </div>
                ) : (
                    <div className="source-connection-empty">
                        <Link2 size={20} />
                        <div>
                            <strong>{configured ? 'Connect your GitHub account' : 'GitHub OAuth is not configured'}</strong>
                            <span>
                                {configured
                                    ? 'Authorize ServerKit once, then pick repositories directly on the New Service page.'
                                    : 'An admin needs to add a GitHub OAuth client before users can connect.'}
                            </span>
                        </div>
                        <Button type="button" onClick={handleConnect} disabled={!configured || connecting}>
                            <Github size={16} />
                            {connecting ? 'Redirecting...' : 'Connect GitHub'}
                        </Button>
                    </div>
                )}
            </div>

            {isAdmin && (
                <form className="settings-card source-oauth-config" onSubmit={handleSaveConfig}>
                    <div className="settings-card__header">
                        <div className="settings-card__header-left">
                            <KeyRound size={22} />
                            <div>
                                <h3>GitHub OAuth App</h3>
                                <p>Set the OAuth app credentials used for repository connections.</p>
                            </div>
                        </div>
                    </div>

                    <div className="source-oauth-config__grid">
                        <div className="form-group">
                            <Label htmlFor="github-source-client-id">Client ID</Label>
                            <Input
                                id="github-source-client-id"
                                value={config.client_id}
                                onChange={(e) => setConfig(prev => ({ ...prev, client_id: e.target.value }))}
                                placeholder="GitHub OAuth client ID"
                            />
                        </div>
                        <div className="form-group">
                            <Label htmlFor="github-source-client-secret">Client Secret</Label>
                            <Input
                                id="github-source-client-secret"
                                type="password"
                                value={config.client_secret}
                                onChange={(e) => setConfig(prev => ({ ...prev, client_secret: e.target.value }))}
                                placeholder="GitHub OAuth client secret"
                            />
                        </div>
                    </div>

                    <div className="source-oauth-config__callback">
                        <Shield size={16} />
                        <span>Callback URL: {window.location.origin}/connections/callback/github</span>
                    </div>

                    <div className="form-actions">
                        <Button type="submit" disabled={saving}>
                            {saving ? 'Saving...' : 'Save GitHub OAuth App'}
                        </Button>
                    </div>
                </form>
            )}
        </div>
    );
};

export default SourceConnectionsTab;
