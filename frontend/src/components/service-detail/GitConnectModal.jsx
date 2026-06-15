import { useState } from 'react';
import { ChevronDown, GitBranch, Settings2 } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../contexts/ToastContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import Modal from '../Modal';
import { RepoProviderStrip, ProviderBadge, detectProvider } from '../git/GitProviders';

const GitConnectModal = ({ appId, deployConfig, onClose, onSaved }) => {
    const toast = useToast();
    const [saving, setSaving] = useState(false);
    const [repoUrl, setRepoUrl] = useState(deployConfig?.repo_url || '');
    const [branch, setBranch] = useState(deployConfig?.branch || 'main');
    const [autoDeploy, setAutoDeploy] = useState(deployConfig?.auto_deploy ?? true);
    const [preDeployScript, setPreDeployScript] = useState(deployConfig?.pre_deploy_script || '');
    const [postDeployScript, setPostDeployScript] = useState(deployConfig?.post_deploy_script || '');
    const [scriptsOpen, setScriptsOpen] = useState(
        Boolean(deployConfig?.pre_deploy_script || deployConfig?.post_deploy_script)
    );

    const provider = detectProvider(repoUrl);

    async function handleSubmit(e) {
        e.preventDefault();
        if (!repoUrl.trim()) return;

        setSaving(true);
        try {
            await api.configureDeployment(
                appId,
                repoUrl.trim(),
                branch || 'main',
                autoDeploy,
                preDeployScript || null,
                postDeployScript || null
            );

            if (autoDeploy && !deployConfig) {
                try {
                    await api.createWebhook({
                        deploy_on_push: true,
                        app_id: appId,
                        repo_url: repoUrl.trim(),
                        branch: branch || 'main',
                    });
                } catch {
                    // Webhook creation is best-effort
                }
            }

            toast.success('Repository connected');
            onSaved();
        } catch {
            toast.error('Failed to save deployment configuration');
        } finally {
            setSaving(false);
        }
    }

    async function handleDisconnect() {
        if (!confirm('Disconnect this repository? Auto-deploy will stop.')) return;

        setSaving(true);
        try {
            await api.removeDeployment(appId);
            toast.success('Repository disconnected');
            onSaved();
        } catch {
            toast.error('Failed to disconnect repository');
            setSaving(false);
        }
    }

    return (
        <Modal open={true} onClose={onClose} title={deployConfig ? 'Edit Repository' : 'Connect Repository'}>
            <form className="git-connect" onSubmit={handleSubmit}>
                <div className="git-connect__intro">
                    <span className="git-connect__intro-icon">
                        <GitBranch size={19} />
                    </span>
                    <div className="git-connect__intro-text">
                        <strong>Connect a Git repository</strong>
                        <span>Link a repo so ServerKit can pull your code and redeploy on every push.</span>
                    </div>
                </div>

                <RepoProviderStrip detected={provider?.key} />

                <div className="git-connect__field">
                    <Label htmlFor="git-repo-url">Repository URL</Label>
                    <Input
                        id="git-repo-url"
                        type="text"
                        value={repoUrl}
                        onChange={(e) => setRepoUrl(e.target.value)}
                        placeholder="https://github.com/user/repo.git"
                        required
                    />
                    {provider && <ProviderBadge provider={provider} />}
                </div>

                <div className="git-connect__field">
                    <Label htmlFor="git-branch">Branch</Label>
                    <Input
                        id="git-branch"
                        type="text"
                        value={branch}
                        onChange={(e) => setBranch(e.target.value)}
                        placeholder="main"
                    />
                </div>

                <div className="git-connect__toggle">
                    <div>
                        <strong>Auto-deploy on push</strong>
                        <span>Automatically deploy when new commits land on this branch.</span>
                    </div>
                    <Switch checked={autoDeploy} onCheckedChange={setAutoDeploy} />
                </div>

                <button
                    type="button"
                    className="git-connect__advanced-toggle"
                    onClick={() => setScriptsOpen((open) => !open)}
                    aria-expanded={scriptsOpen}
                >
                    <span>
                        <Settings2 size={16} />
                        Deploy scripts (optional)
                    </span>
                    <ChevronDown size={16} />
                </button>

                {scriptsOpen && (
                    <div className="git-connect__advanced">
                        <div className="git-connect__field">
                            <Label htmlFor="pre-deploy-script">Pre-deploy script</Label>
                            <Textarea
                                id="pre-deploy-script"
                                value={preDeployScript}
                                onChange={(e) => setPreDeployScript(e.target.value)}
                                placeholder="Commands to run before deployment..."
                            />
                        </div>
                        <div className="git-connect__field">
                            <Label htmlFor="post-deploy-script">Post-deploy script</Label>
                            <Textarea
                                id="post-deploy-script"
                                value={postDeployScript}
                                onChange={(e) => setPostDeployScript(e.target.value)}
                                placeholder="Commands to run after deployment..."
                            />
                        </div>
                    </div>
                )}

                <div className="git-connect__actions">
                    {deployConfig && (
                        <Button
                            type="button"
                            variant="destructive"
                            onClick={handleDisconnect}
                            disabled={saving}
                            className="git-connect__actions-spacer"
                        >
                            Disconnect
                        </Button>
                    )}
                    <Button type="button" variant="outline" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" disabled={saving}>
                        {saving ? 'Saving...' : deployConfig ? 'Save Changes' : 'Connect'}
                    </Button>
                </div>
            </form>
        </Modal>
    );
};

export default GitConnectModal;
