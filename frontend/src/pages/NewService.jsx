import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
    ArrowRight,
    CheckCircle2,
    ChevronDown,
    Github,
    GitBranch,
    KeyRound,
    Link2,
    Lock,
    Package,
    RefreshCw,
    Rocket,
    Search,
    Server,
    Settings2,
    ShieldCheck,
    Zap,
} from 'lucide-react';
import api from '../services/api';
import { useToast } from '../contexts/ToastContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

const APP_TYPE_OPTIONS = [
    { value: 'auto', label: 'Auto-detect' },
    { value: 'docker', label: 'Docker / Compose' },
    { value: 'flask', label: 'Python' },
    { value: 'django', label: 'Django' },
    { value: 'php', label: 'PHP' },
    { value: 'static', label: 'Static site' },
];

const BUILD_METHOD_OPTIONS = [
    { value: 'auto', label: 'Auto build' },
    { value: 'nixpacks', label: 'Nixpacks' },
    { value: 'dockerfile', label: 'Dockerfile' },
    { value: 'custom', label: 'Custom command' },
];

function slugify(value) {
    return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

function repoNameFromUrl(value) {
    if (!value) return '';
    const cleaned = value.trim().replace(/\.git$/, '');
    const parts = cleaned.split(/[/:]/).filter(Boolean);
    return slugify(parts[parts.length - 1] || '');
}

function normalizeManualRepo(value) {
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) return `https://github.com/${trimmed}.git`;
    if (/^github\.com\//i.test(trimmed)) return `https://${trimmed.replace(/\.git$/, '')}.git`;
    return trimmed;
}

const NewService = () => {
    const navigate = useNavigate();
    const toast = useToast();
    const [sourceMode, setSourceMode] = useState('github');
    const [githubStatus, setGithubStatus] = useState(null);
    const [repos, setRepos] = useState([]);
    const [reposLoading, setReposLoading] = useState(false);
    const [repoSearch, setRepoSearch] = useState('');
    const [selectedRepo, setSelectedRepo] = useState(null);
    const [branches, setBranches] = useState([]);
    const [branchesLoading, setBranchesLoading] = useState(false);
    const [manualRepoUrl, setManualRepoUrl] = useState('');
    const [name, setName] = useState('');
    const [nameTouched, setNameTouched] = useState(false);
    const [branch, setBranch] = useState('main');
    const [appType, setAppType] = useState('auto');
    const [buildMethod, setBuildMethod] = useState('auto');
    const [port, setPort] = useState('');
    const [autoDeploy, setAutoDeploy] = useState(true);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    const githubConnection = githubStatus?.connection;
    const githubConfigured = githubStatus?.configured;
    const normalizedManualRepo = useMemo(() => normalizeManualRepo(manualRepoUrl), [manualRepoUrl]);
    const detectedServiceName = useMemo(() => {
        if (sourceMode === 'github' && selectedRepo) return slugify(selectedRepo.name || '');
        return repoNameFromUrl(normalizedManualRepo);
    }, [normalizedManualRepo, selectedRepo, sourceMode]);
    const serviceName = nameTouched ? name : detectedServiceName;
    const canSubmit = sourceMode === 'github'
        ? Boolean(githubConnection && selectedRepo && serviceName?.length >= 2)
        : Boolean(normalizedManualRepo && serviceName?.length >= 2);

    const loadGithubStatus = useCallback(async () => {
        try {
            const data = await api.getGithubSourceStatus();
            setGithubStatus(data);
        } catch (err) {
            toast.error(err.message || 'Failed to load GitHub connection');
        }
    }, [toast]);

    const loadGithubRepos = useCallback(async (search = '') => {
        setReposLoading(true);
        try {
            const data = await api.listGithubRepositories({ search, perPage: 80 });
            setRepos(data.repos || []);
        } catch (err) {
            toast.error(err.message || 'Failed to load GitHub repositories');
        } finally {
            setReposLoading(false);
        }
    }, [toast]);

    const loadBranches = useCallback(async (fullName) => {
        setBranchesLoading(true);
        try {
            const data = await api.listGithubBranches(fullName);
            setBranches(data.branches || []);
        } catch (err) {
            setBranches([]);
            toast.error(err.message || 'Failed to load branches');
        } finally {
            setBranchesLoading(false);
        }
    }, [toast]);

    useEffect(() => {
        loadGithubStatus();
    }, [loadGithubStatus]);

    useEffect(() => {
        if (sourceMode === 'github' && githubConnection) {
            loadGithubRepos();
        }
    }, [sourceMode, githubConnection, loadGithubRepos]);

    useEffect(() => {
        if (selectedRepo) {
            setBranch(selectedRepo.default_branch || 'main');
            loadBranches(selectedRepo.full_name);
        }
    }, [selectedRepo, loadBranches]);

    useEffect(() => {
        if (selectedRepo) {
            if (!nameTouched) {
                setName(slugify(selectedRepo.name || ''));
            }
        }
    }, [selectedRepo, nameTouched]);

    async function handleConnectGithub() {
        try {
            const redirectUri = `${window.location.origin}/connections/callback/github`;
            sessionStorage.setItem('sourceConnectionReturnTo', '/services/new');
            const { auth_url } = await api.startSourceConnection('github', redirectUri);
            window.location.href = auth_url;
        } catch (err) {
            toast.error(err.message || 'Failed to start GitHub connection');
        }
    }

    function handleManualRepoChange(value) {
        setManualRepoUrl(value);
        if (!nameTouched) {
            setName(repoNameFromUrl(normalizeManualRepo(value)));
        }
    }

    async function handleSubmit(e) {
        e.preventDefault();
        if (!canSubmit) {
            toast.error(sourceMode === 'github' ? 'Select a GitHub repository' : 'Repository URL is required');
            return;
        }

        const payload = {
            name: serviceName,
            branch: branch.trim() || null,
            app_type: appType,
            build_method: buildMethod,
            port: port ? Number(port) : null,
            auto_deploy: autoDeploy,
        };

        if (sourceMode === 'github') {
            payload.source_connection_id = githubConnection.id;
            payload.repository_full_name = selectedRepo.full_name;
            payload.repo_url = `https://github.com/${selectedRepo.full_name}.git`;
        } else {
            payload.repo_url = normalizedManualRepo;
        }

        setSubmitting(true);
        try {
            const result = await api.createAppFromRepository(payload);
            toast.success('Repository service created');
            navigate(`/services/${result.app.id}`);
        } catch (err) {
            toast.error(err.message || 'Failed to create repository service');
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="page-container new-service-page">
            <div className="new-service-page__breadcrumb">
                <Link to="/services">Services</Link>
                <span>/</span>
                <span>New</span>
            </div>

            <div className="new-service-page__header">
                <div>
                    <h1>New Service</h1>
                    <p>Connect GitHub, pick a repository, and let ServerKit prepare the deployable service.</p>
                </div>
                <Button type="button" variant="outline" asChild>
                    <Link to="/settings/connections">
                        <Link2 size={16} />
                        Connections
                    </Link>
                </Button>
            </div>

            <div className="new-service-page__mode-strip" aria-label="Service source options">
                <button
                    className={`new-service-page__mode-card ${sourceMode === 'github' ? 'new-service-page__mode-card--active' : ''}`}
                    type="button"
                    onClick={() => setSourceMode('github')}
                >
                    <span className="new-service-page__mode-icon">
                        <Github size={18} />
                    </span>
                    <span>
                        <strong>GitHub</strong>
                        <small>Connect with OAuth and choose a repository</small>
                    </span>
                    {sourceMode === 'github' ? <CheckCircle2 size={18} /> : <ArrowRight size={18} />}
                </button>
                <button
                    className={`new-service-page__mode-card ${sourceMode === 'manual' ? 'new-service-page__mode-card--active' : ''}`}
                    type="button"
                    onClick={() => setSourceMode('manual')}
                >
                    <span className="new-service-page__mode-icon">
                        <KeyRound size={18} />
                    </span>
                    <span>
                        <strong>Other Git Remote</strong>
                        <small>GitLab, Bitbucket, Gitea, or SSH</small>
                    </span>
                    {sourceMode === 'manual' ? <CheckCircle2 size={18} /> : <ArrowRight size={18} />}
                </button>
                <Link to="/templates" className="new-service-page__mode-card">
                    <span className="new-service-page__mode-icon">
                        <Package size={18} />
                    </span>
                    <span>
                        <strong>Template</strong>
                        <small>Packaged apps and infrastructure services</small>
                    </span>
                    <ArrowRight size={18} />
                </Link>
            </div>

            <form className="new-service-page__wizard" onSubmit={handleSubmit}>
                <section className="new-service-page__panel new-service-page__provider-panel">
                    <div className="new-service-page__section-heading">
                        <Link2 size={16} />
                        <h2>{sourceMode === 'github' ? 'Pick Repository' : 'Connect Source'}</h2>
                    </div>

                    {sourceMode === 'github' ? (
                        <div className="new-service-page__connect-box">
                            {githubConnection ? (
                                <>
                                    <div className="new-service-page__github-account">
                                        {githubConnection.avatar_url && <img src={githubConnection.avatar_url} alt="" />}
                                        <div>
                                            <strong>{githubConnection.display_name || githubConnection.provider_username}</strong>
                                            <span>@{githubConnection.provider_username}</span>
                                        </div>
                                        <Button type="button" variant="outline" onClick={() => loadGithubRepos()}>
                                            <RefreshCw size={16} className={reposLoading ? 'spinning' : ''} />
                                            Refresh
                                        </Button>
                                    </div>

                                    <div className="new-service-page__repo-search">
                                        <Search size={16} />
                                        <Input
                                            value={repoSearch}
                                            onChange={(e) => setRepoSearch(e.target.value)}
                                            placeholder="Search repositories"
                                        />
                                        <Button type="button" variant="outline" onClick={() => loadGithubRepos(repoSearch)}>
                                            Search
                                        </Button>
                                    </div>

                                    <div className="new-service-page__repo-list">
                                        {reposLoading && <div className="new-service-page__repo-state">Loading repositories...</div>}
                                        {!reposLoading && repos.length === 0 && (
                                            <div className="new-service-page__repo-state">No repositories found.</div>
                                        )}
                                        {!reposLoading && repos.map(repo => (
                                            <button
                                                key={repo.id}
                                                type="button"
                                                className={`new-service-page__repo-row ${selectedRepo?.id === repo.id ? 'new-service-page__repo-row--active' : ''}`}
                                                onClick={() => setSelectedRepo(repo)}
                                            >
                                                <span>
                                                    <strong>{repo.full_name}</strong>
                                                    <small>{repo.description || repo.language || 'No description'}</small>
                                                </span>
                                                <em>{repo.private ? 'Private' : 'Public'}</em>
                                            </button>
                                        ))}
                                    </div>
                                </>
                            ) : (
                                <div className="new-service-page__connect-empty">
                                    <span className="new-service-page__connect-icon">
                                        <Github size={20} />
                                    </span>
                                    <div>
                                        <h2>{githubConfigured ? 'Connect GitHub' : 'GitHub connection is not configured'}</h2>
                                        <p>
                                            {githubConfigured
                                                ? 'Authorize ServerKit once, then choose a repository from your GitHub account.'
                                                : 'Add the GitHub OAuth app credentials in Settings before connecting.'}
                                        </p>
                                    </div>
                                    <div className="new-service-page__connect-actions">
                                        <Button type="button" onClick={handleConnectGithub} disabled={!githubConfigured}>
                                            <Github size={16} />
                                            Connect GitHub
                                        </Button>
                                        <Button type="button" variant="outline" asChild>
                                            <Link to="/settings/connections">
                                                <Settings2 size={16} />
                                                Settings
                                            </Link>
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="new-service-page__connect-box">
                            <div className="new-service-page__connect-heading">
                                <span className="new-service-page__connect-icon">
                                    <GitBranch size={18} />
                                </span>
                                <div>
                                    <strong>Git remote</strong>
                                    <span>Use this for providers that are not connected through the GitHub API.</span>
                                </div>
                            </div>
                            <div className="new-service-page__field">
                                <Label htmlFor="manual-repo-url">Repository URL</Label>
                                <Input
                                    id="manual-repo-url"
                                    value={manualRepoUrl}
                                    onChange={(e) => handleManualRepoChange(e.target.value)}
                                    placeholder="git@gitea.example.com:owner/repo.git"
                                    autoComplete="off"
                                    required={sourceMode === 'manual'}
                                />
                            </div>
                        </div>
                    )}

                    {(selectedRepo || sourceMode === 'manual') && (
                        <div className="new-service-page__repo-preview">
                            <div>
                                <span>Service</span>
                                <strong>{serviceName || 'Auto-named from repo'}</strong>
                            </div>
                            <div>
                                <span>Branch</span>
                                <strong>{branch || 'main'}</strong>
                            </div>
                            <div>
                                <span>Build</span>
                                <strong>{buildMethod === 'auto' ? 'Auto' : buildMethod}</strong>
                            </div>
                        </div>
                    )}
                </section>

                <aside className="new-service-page__panel new-service-page__review-panel">
                    <div className="new-service-page__deploy-card">
                        <span className="new-service-page__deploy-icon">
                            <Rocket size={18} />
                        </span>
                        <div>
                            <h2>Ready to Import</h2>
                            <p>ServerKit clones the selected repository, detects the runtime, configures builds, and records deployment settings.</p>
                        </div>
                    </div>

                    <div className="new-service-page__flow">
                        <div>
                            <Github size={16} />
                            <span>Connect</span>
                        </div>
                        <ArrowRight size={14} />
                        <div>
                            <Zap size={16} />
                            <span>Detect</span>
                        </div>
                        <ArrowRight size={14} />
                        <div>
                            <Server size={16} />
                            <span>Deploy</span>
                        </div>
                    </div>

                    <div className="new-service-page__summary">
                        <div>
                            <span>Source</span>
                            <strong>{sourceMode === 'github' ? 'GitHub API' : 'Git remote'}</strong>
                        </div>
                        <div>
                            <span>Repository</span>
                            <strong>{selectedRepo?.full_name || normalizedManualRepo || 'Not selected'}</strong>
                        </div>
                        <div>
                            <span>Auto-deploy</span>
                            <strong>{autoDeploy ? 'On' : 'Off'}</strong>
                        </div>
                    </div>

                    <button
                        className="new-service-page__advanced-toggle"
                        type="button"
                        onClick={() => setAdvancedOpen(open => !open)}
                        aria-expanded={advancedOpen}
                    >
                        <span>
                            <Settings2 size={16} />
                            Advanced settings
                        </span>
                        <ChevronDown size={16} />
                    </button>

                    {advancedOpen && (
                        <div className="new-service-page__advanced">
                            <div className="new-service-page__two-col">
                                <div className="new-service-page__field">
                                    <Label htmlFor="branch">Branch</Label>
                                    {sourceMode === 'github' && branches.length > 0 ? (
                                        <select
                                            id="branch"
                                            value={branch}
                                            onChange={(e) => setBranch(e.target.value)}
                                            disabled={branchesLoading}
                                        >
                                            {branches.map(option => (
                                                <option key={option.name} value={option.name}>{option.name}</option>
                                            ))}
                                        </select>
                                    ) : (
                                        <Input
                                            id="branch"
                                            value={branch}
                                            onChange={(e) => setBranch(e.target.value)}
                                            placeholder="main"
                                        />
                                    )}
                                </div>
                                <div className="new-service-page__field">
                                    <Label htmlFor="service-name">Service name</Label>
                                    <Input
                                        id="service-name"
                                        value={serviceName}
                                        onChange={(e) => {
                                            setNameTouched(true);
                                            setName(slugify(e.target.value));
                                        }}
                                        placeholder="my-service"
                                        minLength={2}
                                        required
                                    />
                                </div>
                            </div>

                            <div className="new-service-page__two-col">
                                <div className="new-service-page__field">
                                    <Label htmlFor="app-type">Service type</Label>
                                    <select
                                        id="app-type"
                                        value={appType}
                                        onChange={(e) => setAppType(e.target.value)}
                                    >
                                        {APP_TYPE_OPTIONS.map(option => (
                                            <option key={option.value} value={option.value}>{option.label}</option>
                                        ))}
                                    </select>
                                </div>
                                <div className="new-service-page__field">
                                    <Label htmlFor="build-method">Build method</Label>
                                    <select
                                        id="build-method"
                                        value={buildMethod}
                                        onChange={(e) => setBuildMethod(e.target.value)}
                                    >
                                        {BUILD_METHOD_OPTIONS.map(option => (
                                            <option key={option.value} value={option.value}>{option.label}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            <div className="new-service-page__two-col">
                                <div className="new-service-page__field">
                                    <Label htmlFor="port">Runtime port</Label>
                                    <Input
                                        id="port"
                                        type="number"
                                        value={port}
                                        onChange={(e) => setPort(e.target.value)}
                                        placeholder="3000"
                                        min="1"
                                        max="65535"
                                    />
                                </div>
                                <div className="new-service-page__toggle">
                                    <div>
                                        <Label>Auto-deploy</Label>
                                        <span>Webhook deployment for this branch.</span>
                                    </div>
                                    <Switch checked={autoDeploy} onCheckedChange={setAutoDeploy} />
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="new-service-page__notes">
                        <div className="new-service-page__note">
                            <ShieldCheck size={16} />
                            <span>GitHub repositories are listed through the API after account authorization.</span>
                        </div>
                        <div className="new-service-page__note">
                            <Lock size={16} />
                            <span>Other Git remotes still use server-side keys or authenticated URLs.</span>
                        </div>
                    </div>

                    <div className="new-service-page__actions">
                        <Button type="button" variant="outline" asChild>
                            <Link to="/services">Cancel</Link>
                        </Button>
                        <Button type="submit" disabled={!canSubmit || submitting}>
                            <Rocket size={16} />
                            {submitting ? 'Importing...' : 'Import Repository'}
                        </Button>
                    </div>
                </aside>
            </form>
        </div>
    );
};

export default NewService;
