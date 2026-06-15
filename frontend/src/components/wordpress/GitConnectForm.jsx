import { useState } from 'react';
import { GitBranch, Unlink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { RepoProviderStrip, ProviderBadge, detectProvider } from '../git/GitProviders';

const GitConnectForm = ({ gitStatus, onConnect, onDisconnect }) => {
    const [formData, setFormData] = useState({
        repoUrl: '',
        branch: 'main',
        paths: ['wp-content/themes', 'wp-content/plugins'],
        autoDeploy: false
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const isConnected = gitStatus?.connected;
    const provider = detectProvider(formData.repoUrl);

    function handleChange(e) {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    }

    function handlePathsChange(e) {
        const paths = e.target.value.split('\n').filter(p => p.trim());
        setFormData(prev => ({ ...prev, paths }));
    }

    async function handleConnect(e) {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            await onConnect({
                repo_url: formData.repoUrl,
                branch: formData.branch,
                paths: formData.paths,
                auto_deploy: formData.autoDeploy
            });
        } catch (err) {
            setError(err.message || 'Failed to connect repository');
        } finally {
            setLoading(false);
        }
    }

    async function handleDisconnect() {
        if (!confirm('Disconnect Git repository? This will not delete any files.')) {
            return;
        }
        setLoading(true);
        try {
            await onDisconnect();
        } catch (err) {
            setError(err.message || 'Failed to disconnect repository');
        } finally {
            setLoading(false);
        }
    }

    if (isConnected) {
        return (
            <div className="git-connect-status">
                <div className="git-connect-status__header">
                    <span className="git-connect-status__icon">
                        <GitBranch size={19} />
                    </span>
                    <div className="git-connect-status__title">
                        <strong>Repository connected</strong>
                        <a
                            href={gitStatus.repo_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="git-connect-status__url"
                        >
                            {gitStatus.repo_url}
                        </a>
                    </div>
                </div>

                <div className="git-connect-status__meta">
                    <div className="git-connect-status__meta-item">
                        <span>Branch</span>
                        <strong>{gitStatus.branch}</strong>
                    </div>
                    <div className="git-connect-status__meta-item">
                        <span>Auto Deploy</span>
                        <strong>{gitStatus.auto_deploy ? 'Enabled' : 'Disabled'}</strong>
                    </div>
                    {gitStatus.last_deploy_commit && (
                        <div className="git-connect-status__meta-item">
                            <span>Last Deploy</span>
                            <strong className="mono">{gitStatus.last_deploy_commit.substring(0, 7)}</strong>
                        </div>
                    )}
                    {gitStatus.last_deploy_at && (
                        <div className="git-connect-status__meta-item">
                            <span>Deployed At</span>
                            <strong>{new Date(gitStatus.last_deploy_at).toLocaleString()}</strong>
                        </div>
                    )}
                </div>

                <div className="git-connect-status__actions">
                    <Button variant="destructive" onClick={handleDisconnect} disabled={loading}>
                        <Unlink size={14} />
                        {loading ? 'Disconnecting...' : 'Disconnect'}
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <form className="git-connect git-connect--card" onSubmit={handleConnect}>
            <div className="git-connect__intro">
                <span className="git-connect__intro-icon">
                    <GitBranch size={19} />
                </span>
                <div className="git-connect__intro-text">
                    <strong>Connect a Git repository</strong>
                    <span>Manage themes and plugins for this site with version control — push to deploy.</span>
                </div>
            </div>

            <RepoProviderStrip detected={provider?.key} />

            {error && <div className="error-message">{error}</div>}

            <div className="git-connect__field">
                <Label htmlFor="wp-repo-url">Repository URL</Label>
                <Input
                    id="wp-repo-url"
                    type="text"
                    name="repoUrl"
                    value={formData.repoUrl}
                    onChange={handleChange}
                    placeholder="https://github.com/user/repo.git"
                    required
                />
                {provider && <ProviderBadge provider={provider} />}
            </div>

            <div className="git-connect__field">
                <Label htmlFor="wp-branch">Branch</Label>
                <Input
                    id="wp-branch"
                    type="text"
                    name="branch"
                    value={formData.branch}
                    onChange={handleChange}
                    placeholder="main"
                />
            </div>

            <div className="git-connect__field">
                <Label htmlFor="wp-paths">Tracked paths (one per line)</Label>
                <Textarea
                    id="wp-paths"
                    value={formData.paths.join('\n')}
                    onChange={handlePathsChange}
                    placeholder={"wp-content/themes\nwp-content/plugins"}
                    rows={3}
                />
                <span className="git-connect__field-hint">
                    Paths relative to the WordPress root that should be tracked.
                </span>
            </div>

            <div className="git-connect__toggle">
                <div>
                    <strong>Auto-deploy on push</strong>
                    <span>Automatically deploy when new commits land on this branch.</span>
                </div>
                <Switch
                    checked={formData.autoDeploy}
                    onCheckedChange={(checked) =>
                        setFormData(prev => ({ ...prev, autoDeploy: checked }))
                    }
                />
            </div>

            <div className="git-connect__actions">
                <Button type="submit" disabled={loading}>
                    <GitBranch size={14} />
                    {loading ? 'Connecting...' : 'Connect Repository'}
                </Button>
            </div>
        </form>
    );
};

export default GitConnectForm;
