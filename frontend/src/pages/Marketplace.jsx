import { useState, useEffect, useCallback } from 'react';
import {
    Activity,
    Archive,
    CheckCircle2,
    DownloadCloud,
    FileArchive,
    Filter,
    FolderOpen,
    Globe2,
    LayoutGrid,
    Package,
    PackageCheck,
    Plug,
    PlugZap,
    Search,
    ServerCog,
    ShieldCheck,
    Sparkles,
    Star,
    UploadCloud,
} from 'lucide-react';
import api from '../services/api';
import { useToast } from '../contexts/ToastContext';
import { sanitizeSvgInner } from '../utils/sanitizeSvg';
import Modal from '@/components/Modal';
import PageLoader from '../components/PageLoader';
import EmptyState from '../components/EmptyState';
import { StatStrip, Stat } from '../components/StatCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useTopbarActions } from '@/hooks/useTopbarActions';

const CATEGORIES = ['ai', 'monitoring', 'security', 'deployment', 'integration', 'ui', 'utility'];

const CATEGORY_ICONS = {
    ai: Sparkles,
    monitoring: Activity,
    security: ShieldCheck,
    deployment: ServerCog,
    integration: Plug,
    ui: LayoutGrid,
    utility: Package,
};

const PLUGIN_INSTALL_SOURCES = [
    { id: 'url', label: 'URL', icon: Globe2 },
    { id: 'path', label: 'Folder', icon: FolderOpen },
    { id: 'upload', label: 'Zip', icon: FileArchive },
];

const numberFormatter = new Intl.NumberFormat();

const formatCount = (value) => numberFormatter.format(Number(value) || 0);

const titleCase = (value = '') => {
    const cleaned = String(value || 'utility').replace(/[-_]/g, ' ');
    return cleaned
        .split(' ')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
};

const getCategoryIcon = (category) => CATEGORY_ICONS[category] || Package;

// A first-party ("by ServerKit") entry is one authored by ServerKit or one whose
// manifest explicitly opts in via `first_party`. Case-insensitive on author.
const isFirstParty = (author, source = {}) => {
    if (source && source.first_party) return true;
    return String(author || '').trim().toLowerCase() === 'serverkit';
};

// Union of categories actually present across the merged catalog, ordered by the
// canonical CATEGORIES list first, then any extras alphabetically (stable, deduped).
const deriveCatalogCategories = (entries) => {
    const present = new Set(entries.map((entry) => entry.category || 'utility'));
    const known = CATEGORIES.filter((item) => present.has(item));
    const extra = [...present].filter((item) => !CATEGORIES.includes(item)).sort();
    return [...known, ...extra];
};

const getPublishedCatalogEntry = (extension, installed) => ({
    key: `published:${extension.id}`,
    source: 'published',
    sourceLabel: 'Published',
    sourceDetail: 'Registry package',
    installKey: extension.id,
    displayName: extension.display_name || extension.name,
    description: extension.description || 'No description provided.',
    category: extension.category || 'utility',
    version: extension.version || '0.0.0',
    author: extension.author,
    firstParty: isFirstParty(extension.author, extension),
    icon: extension.icon || null,
    screenshots: Array.isArray(extension.screenshots) ? extension.screenshots : [],
    extensionType: extension.extension_type,
    installed,
    rating: extension.rating,
    ratingCount: extension.rating_count,
    downloadCount: extension.download_count,
});

const getInstalledPublishedEntry = (extension) => ({
    key: `installed:${extension.id}`,
    source: 'published',
    sourceLabel: 'Published',
    displayName: extension.extension_name,
    version: extension.installed_version || '0.0.0',
    installId: extension.id,
});

const getRegistryCatalogEntry = (entry) => ({
    key: `registry:${entry.slug}`,
    source: 'registry',
    sourceLabel: 'Registry',
    sourceDetail: 'Remote registry package',
    installKey: entry.slug,
    displayName: entry.display_name || entry.slug,
    description: entry.description || 'No description provided.',
    category: entry.category || 'utility',
    version: entry.version || '0.0.0',
    author: entry.author,
    firstParty: isFirstParty(entry.author, entry),
    icon: entry.icon || null,
    screenshots: Array.isArray(entry.screenshots) ? entry.screenshots : [],
    extensionType: 'registry',
    installed: Boolean(entry.installed),
    status: entry.status,
});

// Source badge tint: built-in is 'warning', registry is 'info', published falls
// back to the neutral 'outline' variant.
const sourceBadgeVariant = (source) => {
    if (source === 'local') return 'warning';
    if (source === 'registry') return 'info';
    return 'outline';
};

const getLocalCatalogEntry = (builtin) => {
    const manifest = builtin.manifest || {};

    return {
        key: `local:${builtin.slug}`,
        source: 'local',
        sourceLabel: 'Built-in',
        sourceDetail: 'Bundled with ServerKit',
        installKey: builtin.slug,
        displayName: manifest.display_name || builtin.slug,
        description: manifest.description || 'Bundled extension.',
        category: manifest.category || 'utility',
        version: manifest.version || '0.0.0',
        author: manifest.author,
        firstParty: isFirstParty(manifest.author, manifest),
        icon: manifest.icon || null,
        screenshots: Array.isArray(manifest.screenshots) ? manifest.screenshots : [],
        extensionType: 'built-in',
        installed: Boolean(builtin.installed),
        status: builtin.status,
    };
};

const catalogEntryMatches = (entry, search, category) => {
    if (category && entry.category !== category) return false;

    const query = search.trim().toLowerCase();
    if (!query) return true;

    return [
        entry.displayName,
        entry.description,
        entry.category,
        entry.author,
        entry.sourceLabel,
    ].some((value) => String(value || '').toLowerCase().includes(query));
};

const Marketplace = () => {
    const toast = useToast();
    const [extensions, setExtensions] = useState([]);
    const [myExtensions, setMyExtensions] = useState([]);
    const [plugins, setPlugins] = useState([]);
    const [builtins, setBuiltins] = useState([]);
    const [registryExtensions, setRegistryExtensions] = useState([]);
    const [pluginUpdates, setPluginUpdates] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [category, setCategory] = useState('');
    const [activeTab, setActiveTab] = useState('browse');
    const [pluginUrl, setPluginUrl] = useState('');
    const [pluginPath, setPluginPath] = useState('');
    const [pluginFile, setPluginFile] = useState(null);
    const [installSource, setInstallSource] = useState('url');
    const [installing, setInstalling] = useState(false);
    const [detailEntry, setDetailEntry] = useState(null);

    const loadExtensions = useCallback(async () => {
        try {
            const [eData, mData, pData, bData, rData, uData] = await Promise.all([
                api.getMarketplaceExtensions(category, search),
                api.getMyExtensions(),
                api.getInstalledPlugins().catch(() => ({ plugins: [] })),
                api.getBuiltinExtensions().catch(() => ({ builtin: [] })),
                api.getRegistryExtensions().catch(() => ({ extensions: [] })),
                api.getPluginUpdates().catch(() => ({ updates: [] })),
            ]);
            setExtensions(eData.extensions || []);
            setMyExtensions(mData.extensions || []);
            setPlugins(pData.plugins || []);
            setBuiltins(bData.builtin || []);
            setRegistryExtensions(rData.extensions || []);
            setPluginUpdates(uData.updates || []);
        } catch {
            toast.error('Failed to load extensions');
        } finally {
            setLoading(false);
        }
    }, [category, search, toast]);

    useEffect(() => { loadExtensions(); }, [loadExtensions]);

    const handleInstall = async (extId) => {
        try {
            await api.installMarketplaceExtension(extId);
            toast.success('Extension installed');
            loadExtensions();
        } catch (err) { toast.error(err.message); }
    };

    const handleUninstall = async (installId) => {
        try {
            await api.uninstallMarketplaceExtension(installId);
            toast.success('Extension uninstalled');
            loadExtensions();
        } catch (err) { toast.error(err.message); }
    };

    const handleBuiltinInstall = async (slug) => {
        setInstalling(true);
        try {
            const result = await api.installBuiltinExtension(slug);
            toast.success(`Installed "${result.display_name}". Hot-reload should pick it up; restart backend if blueprint routes do not appear.`);
            loadExtensions();
        } catch (err) {
            toast.error(err.message || 'Local install failed');
        } finally {
            setInstalling(false);
        }
    };

    const handleRegistryInstall = async (slug) => {
        setInstalling(true);
        try {
            const result = await api.installRegistryExtension(slug);
            toast.success(`Installed "${result.display_name}". Restart backend if blueprint routes do not appear.`);
            loadExtensions();
        } catch (err) {
            toast.error(err.message || 'Registry install failed');
        } finally {
            setInstalling(false);
        }
    };

    const installEntry = (entry) => {
        if (entry.source === 'local') {
            handleBuiltinInstall(entry.installKey);
        } else if (entry.source === 'registry') {
            handleRegistryInstall(entry.installKey);
        } else {
            handleInstall(entry.installKey);
        }
    };

    const handlePluginInstall = async () => {
        let action;
        if (installSource === 'url') {
            if (!pluginUrl.trim()) return;
            action = () => api.installPlugin(pluginUrl.trim());
        } else if (installSource === 'path') {
            if (!pluginPath.trim()) return;
            action = () => api.installPluginFromPath(pluginPath.trim());
        } else if (installSource === 'upload') {
            if (!pluginFile) return;
            action = () => api.installPluginFromZip(pluginFile);
        } else {
            return;
        }

        setInstalling(true);
        try {
            const result = await action();
            toast.success(`Plugin "${result.display_name}" installed. Restart backend to activate routes.`);
            setPluginUrl('');
            setPluginPath('');
            setPluginFile(null);
            loadExtensions();
        } catch (err) {
            toast.error(err.message || 'Plugin installation failed');
        } finally {
            setInstalling(false);
        }
    };

    const handlePluginUninstall = async (pluginId) => {
        try {
            await api.uninstallPlugin(pluginId);
            toast.success('Plugin uninstalled');
            loadExtensions();
        } catch (err) { toast.error(err.message); }
    };

    const handlePluginUpdate = async (pluginId) => {
        setInstalling(true);
        try {
            const result = await api.updatePlugin(pluginId);
            toast.success(`Plugin "${result.display_name}" updated to v${result.version}.`);
            loadExtensions();
        } catch (err) {
            toast.error(err.message || 'Plugin update failed');
        } finally {
            setInstalling(false);
        }
    };

    const handlePluginToggle = async (plugin) => {
        try {
            if (plugin.status === 'active') {
                await api.disablePlugin(plugin.id);
                toast.success('Plugin disabled');
            } else {
                await api.enablePlugin(plugin.id);
                toast.success('Plugin enabled');
            }
            loadExtensions();
        } catch (err) { toast.error(err.message); }
    };

    const resetFilters = () => {
        setSearch('');
        setCategory('');
    };

    const openZipInstaller = () => {
        setInstallSource('upload');
        setActiveTab('plugins');
    };

    const pluginStatusVariant = (status) => {
        if (status === 'active') return 'success';
        if (status === 'error') return 'destructive';
        return 'outline';
    };

    useTopbarActions(() =>
        <>
            <Button variant="outline" size="sm" onClick={openZipInstaller}>
                <UploadCloud aria-hidden="true" />
                Import ZIP
            </Button>
        </>,
        [],
    );

    if (loading) return <PageLoader />;

    const installedIds = new Set(myExtensions.map((extension) => String(extension.extension_id)));
    const localCatalogEntries = builtins.map(getLocalCatalogEntry);
    const registryCatalogEntries = registryExtensions.map(getRegistryCatalogEntry);
    const publishedCatalogEntries = extensions.map((extension) => (
        getPublishedCatalogEntry(extension, installedIds.has(String(extension.id)))
    ));
    const installedCatalogEntries = [
        ...localCatalogEntries.filter((entry) => entry.installed),
        ...myExtensions.map(getInstalledPublishedEntry),
    ];
    const installedBuiltinCount = localCatalogEntries.filter((entry) => entry.installed).length;
    const activePluginCount = plugins.filter((plugin) => plugin.status === 'active').length;
    const pluginIssueCount = plugins.filter((plugin) => plugin.status === 'error').length;
    const totalDownloads = extensions.reduce((total, extension) => total + (Number(extension.download_count) || 0), 0);
    const availableCount = extensions.length + builtins.length + registryExtensions.length;
    const installedCatalogCount = installedCatalogEntries.length;
    // Update descriptors keyed by both plugin_id and slug so PluginRow can match
    // whichever identifier it has on hand.
    const updatesByKey = new Map();
    pluginUpdates.forEach((update) => {
        if (update.plugin_id != null) updatesByKey.set(String(update.plugin_id), update);
        if (update.slug) updatesByKey.set(update.slug, update);
    });
    const mergedCatalogEntries = [...localCatalogEntries, ...registryCatalogEntries, ...publishedCatalogEntries];
    const catalogCategories = deriveCatalogCategories(mergedCatalogEntries);
    const catalogEntries = mergedCatalogEntries
        .filter((entry) => catalogEntryMatches(entry, search, category));
    const hasFilters = Boolean(search.trim() || category);

    return (
        <div className="sk-tabgroup__inner marketplace-page">
            <StatStrip ariaLabel="Marketplace summary">
                <Stat label="Catalog" value={availableCount} />
                <Stat label="Built-in" value={builtins.length} />
                <Stat label="Installed" value={installedCatalogCount} />
                <Stat
                    label="Active Plugins"
                    value={`${activePluginCount}/${plugins.length}`}
                    state={pluginIssueCount > 0 ? 'danger' : undefined}
                />
            </StatStrip>

            <Tabs value={activeTab} onValueChange={setActiveTab} className="marketplace-tabs">
                <TabsList className="marketplace-tabs__list">
                    <TabsTrigger value="browse">
                        <LayoutGrid aria-hidden="true" />
                        Browse
                    </TabsTrigger>
                    <TabsTrigger value="installed">
                        <PackageCheck aria-hidden="true" />
                        Installed ({installedCatalogCount})
                    </TabsTrigger>
                    <TabsTrigger value="plugins">
                        <PlugZap aria-hidden="true" />
                        ServerKit Plugins ({plugins.length})
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="browse">
                    <div className="marketplace-toolbar">
                        <div className="marketplace-search">
                            <Search className="marketplace-search__icon" aria-hidden="true" />
                            <Input
                                placeholder="Search extensions..."
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                aria-label="Search extensions"
                            />
                        </div>
                        <select
                            className="form-select marketplace-category-select"
                            value={category}
                            onChange={(event) => setCategory(event.target.value)}
                            aria-label="Filter by category"
                        >
                            <option value="">All Categories</option>
                            {catalogCategories.map((item) => (
                                <option key={item} value={item}>{titleCase(item)}</option>
                            ))}
                        </select>
                        {hasFilters && (
                            <Button variant="ghost" size="sm" onClick={resetFilters}>
                                Reset
                            </Button>
                        )}
                    </div>

                    <div className="cat-chips" role="group" aria-label="Filter by category">
                        <button
                            type="button"
                            className={`cat-chip ${category === '' ? 'cat-chip--active' : ''}`}
                            aria-pressed={category === ''}
                            onClick={() => setCategory('')}
                        >
                            All
                        </button>
                        {catalogCategories.map((item) => (
                            <button
                                key={item}
                                type="button"
                                className={`cat-chip ${category === item ? 'cat-chip--active' : ''}`}
                                aria-pressed={category === item}
                                onClick={() => setCategory(item)}
                            >
                                {titleCase(item)}
                            </button>
                        ))}
                    </div>

                    <div className="marketplace-browse-grid">
                        <div className="marketplace-main-stack">
                            <section className="marketplace-section">
                                <SectionHeader
                                    kicker="Catalog"
                                    title="Extension catalog"
                                    meta={`${catalogEntries.length} results`}
                                />
                                {catalogEntries.length > 0 ? (
                                    <div className="extensions-grid">
                                        {catalogEntries.map((entry) => (
                                            <CatalogExtensionCard
                                                key={entry.key}
                                                entry={entry}
                                                installing={installing}
                                                onInstall={
                                                    entry.source === 'local'
                                                        ? handleBuiltinInstall
                                                        : entry.source === 'registry'
                                                            ? handleRegistryInstall
                                                            : handleInstall
                                                }
                                                onOpenDetail={setDetailEntry}
                                                statusVariant={pluginStatusVariant}
                                            />
                                        ))}
                                    </div>
                                ) : (
                                    <EmptyState
                                        icon={Package}
                                        title="No catalog entries found"
                                        description={hasFilters ? 'No local or published entries match the current filter.' : 'No extension entries are available yet.'}
                                    />
                                )}
                            </section>
                        </div>

                        <aside className="marketplace-side-panel" aria-label="Marketplace controls">
                            <div className="marketplace-panel">
                                <div className="marketplace-panel__title">
                                    <Filter aria-hidden="true" />
                                    Categories
                                </div>
                                <div className="marketplace-category-list">
                                    <button
                                        type="button"
                                        className={`marketplace-category ${category === '' ? 'marketplace-category--active' : ''}`}
                                        onClick={() => setCategory('')}
                                    >
                                        All
                                    </button>
                                    {catalogCategories.map((item) => {
                                        const Icon = getCategoryIcon(item);
                                        return (
                                            <button
                                                key={item}
                                                type="button"
                                                className={`marketplace-category marketplace-category--${item} ${category === item ? 'marketplace-category--active' : ''}`}
                                                onClick={() => setCategory(item)}
                                            >
                                                <Icon aria-hidden="true" />
                                                {titleCase(item)}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            <div className="marketplace-panel">
                                <div className="marketplace-panel__title">
                                    <ServerCog aria-hidden="true" />
                                    Runtime
                                </div>
                                <div className="marketplace-runtime">
                                    <RuntimeRow label="Published installs" value={formatCount(totalDownloads)} />
                                    <RuntimeRow label="Registry" value={registryExtensions.length} />
                                    <RuntimeRow label="Built-in" value={builtins.length} />
                                    <RuntimeRow label="Built-in installed" value={`${installedBuiltinCount}/${builtins.length}`} />
                                    <RuntimeRow label="Active plugins" value={`${activePluginCount}/${plugins.length}`} />
                                    <RuntimeRow
                                        label="Plugin issues"
                                        value={pluginIssueCount}
                                        danger={pluginIssueCount > 0}
                                    />
                                </div>
                            </div>
                        </aside>
                    </div>
                </TabsContent>

                <TabsContent value="installed">
                    <section className="marketplace-section">
                        <SectionHeader
                            kicker="Installed"
                            title="Installed extensions"
                            meta={`${installedCatalogCount} installed`}
                        />
                        {installedCatalogEntries.length > 0 ? (
                            <div className="installed-list">
                                {installedCatalogEntries.map((entry) => (
                                    <InstalledCatalogRow
                                        key={entry.key}
                                        entry={entry}
                                        onUninstall={handleUninstall}
                                    />
                                ))}
                            </div>
                        ) : (
                            <EmptyState
                                icon={PackageCheck}
                                title="No extensions installed"
                                description="Install a local or published extension to see it here."
                            />
                        )}
                    </section>
                </TabsContent>

                <TabsContent value="plugins">
                    <div className="plugins-section">
                        <section className="marketplace-section">
                            <SectionHeader
                                kicker="Installer"
                                title="Install ServerKit plugin"
                                meta={titleCase(installSource)}
                            />
                            <div className="plugin-install-form">
                                <div className="plugin-install-form__heading">
                                    <div className="plugin-install-form__icon">
                                        <PlugZap aria-hidden="true" />
                                    </div>
                                    <div>
                                        <h3>Plugin source</h3>
                                        <p className="text-muted">Load plugin packages from a repository, host folder, or zip archive.</p>
                                    </div>
                                </div>

                                <div className="plugin-install-tabs" role="tablist" aria-label="Plugin install source">
                                    {PLUGIN_INSTALL_SOURCES.map((source) => {
                                        const SourceIcon = source.icon;
                                        return (
                                            <button
                                                key={source.id}
                                                role="tab"
                                                type="button"
                                                aria-selected={installSource === source.id}
                                                className={`plugin-install-tab ${installSource === source.id ? 'plugin-install-tab--active' : ''}`}
                                                onClick={() => setInstallSource(source.id)}
                                            >
                                                <SourceIcon aria-hidden="true" />
                                                {source.label}
                                            </button>
                                        );
                                    })}
                                </div>

                                {installSource === 'url' && (
                                    <PluginInstallInput
                                        description="Paste a GitHub repo URL, release URL, or direct zip link."
                                        placeholder="https://github.com/user/serverkit-plugin"
                                        value={pluginUrl}
                                        onChange={setPluginUrl}
                                        onInstall={handlePluginInstall}
                                        disabled={installing}
                                        installDisabled={installing || !pluginUrl.trim()}
                                    />
                                )}

                                {installSource === 'path' && (
                                    <PluginInstallInput
                                        description="Use an absolute path that exists on the backend host or inside the backend container."
                                        placeholder="/opt/serverkit/plugins/my-plugin"
                                        value={pluginPath}
                                        onChange={setPluginPath}
                                        onInstall={handlePluginInstall}
                                        disabled={installing}
                                        installDisabled={installing || !pluginPath.trim()}
                                    />
                                )}

                                {installSource === 'upload' && (
                                    <div className="plugin-install-source">
                                        <p className="text-muted">
                                            Upload a plugin zip with <code>plugin.json</code> at the top level or one folder deep.
                                        </p>
                                        <div className="plugin-install-row">
                                            <Input
                                                type="file"
                                                className="marketplace-file-input"
                                                accept=".zip,application/zip,application/x-zip-compressed"
                                                disabled={installing}
                                                onChange={(event) => setPluginFile(event.target.files?.[0] || null)}
                                            />
                                            <Button
                                                onClick={handlePluginInstall}
                                                disabled={installing || !pluginFile}
                                            >
                                                <DownloadCloud aria-hidden="true" />
                                                {installing ? 'Installing...' : 'Install'}
                                            </Button>
                                        </div>
                                        {pluginFile && (
                                            <div className="plugin-file-note">
                                                {pluginFile.name} | {(pluginFile.size / 1024).toFixed(1)} KB
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </section>

                        <section className="marketplace-section">
                            <SectionHeader
                                kicker="Runtime"
                                title="Installed ServerKit plugins"
                                meta={`${plugins.length} plugins`}
                            />
                            {plugins.length > 0 ? (
                                <div className="installed-list">
                                    {plugins.map((plugin) => (
                                        <PluginRow
                                            key={plugin.id}
                                            plugin={plugin}
                                            update={updatesByKey.get(String(plugin.id))}
                                            installing={installing}
                                            onToggle={handlePluginToggle}
                                            onUpdate={handlePluginUpdate}
                                            onUninstall={handlePluginUninstall}
                                            statusVariant={pluginStatusVariant}
                                        />
                                    ))}
                                </div>
                            ) : (
                                <EmptyState
                                    icon={PlugZap}
                                    title="No ServerKit plugins installed"
                                    description="Install a plugin package to extend the panel runtime."
                                />
                            )}
                        </section>
                    </div>
                </TabsContent>
            </Tabs>

            {detailEntry && (
                <ExtensionDetailModal
                    entry={detailEntry}
                    installing={installing}
                    statusVariant={pluginStatusVariant}
                    onClose={() => setDetailEntry(null)}
                    onInstall={() => {
                        installEntry(detailEntry);
                        setDetailEntry(null);
                    }}
                />
            )}
        </div>
    );
};

const SectionHeader = ({ kicker, title, meta }) => (
    <div className="marketplace-section__header">
        <div>
            <p className="marketplace-kicker">{kicker}</p>
            <h2>{title}</h2>
        </div>
        {meta && <Badge variant="outline">{meta}</Badge>}
    </div>
);

const CatalogExtensionCard = ({ entry, installing, onInstall, onOpenDetail, statusVariant }) => {
    const category = entry.category || 'utility';
    const Icon = getCategoryIcon(category);
    const isLocal = entry.source === 'local';
    const isPublished = entry.source === 'published';
    const installedLabel = !isPublished && entry.status && entry.status !== 'active'
        ? titleCase(entry.status)
        : 'Installed';

    const openDetail = () => onOpenDetail(entry);
    const handleKeyDown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openDetail();
        }
    };

    return (
        <article
            className={`extension-card extension-card--${entry.source} extension-card--${category} extension-card--clickable card`}
            role="button"
            tabIndex={0}
            onClick={openDetail}
            onKeyDown={handleKeyDown}
        >
            <div className="extension-card__topline">
                <div className={`extension-card__icon extension-card__icon--${category}`}>
                    <Icon aria-hidden="true" />
                </div>
                <div className="extension-card__badges">
                    {entry.firstParty && (
                        <Badge variant="secondary" className="extension-firstparty">by ServerKit</Badge>
                    )}
                    <Badge variant={sourceBadgeVariant(entry.source)}>{entry.sourceLabel}</Badge>
                    <Badge variant="outline">{titleCase(category)}</Badge>
                </div>
            </div>
            <div className="extension-card__body">
                <h3>{entry.displayName}</h3>
                <p className="extension-card__desc">{entry.description}</p>
            </div>
            <div className="extension-card__signals">
                {!isPublished ? (
                    <>
                        <span>{entry.sourceDetail}</span>
                        <span>{entry.installed ? installedLabel : 'Ready to install'}</span>
                    </>
                ) : (
                    <>
                        <span>
                            {renderStars(entry.rating)}
                            <span className="extension-card__signal-text">
                                {formatCount(entry.ratingCount)} reviews
                            </span>
                        </span>
                        <span>{formatCount(entry.downloadCount)} installs</span>
                    </>
                )}
            </div>
            <div className="extension-card__footer">
                <div className="extension-card__info">
                    <span>v{entry.version}</span>
                    {entry.author && <span>by {entry.author}</span>}
                    {entry.extensionType && (
                        <Badge variant="secondary">
                            {isLocal ? 'built-in' : entry.extensionType}
                        </Badge>
                    )}
                </div>
                <div className="extension-card__actions">
                    {entry.installed ? (
                        <Badge variant={isLocal ? statusVariant(entry.status) : 'success'}>
                            <CheckCircle2 aria-hidden="true" />
                            {installedLabel}
                        </Badge>
                    ) : (
                        <Button
                            size="sm"
                            disabled={!isPublished && installing}
                            onClick={(event) => {
                                event.stopPropagation();
                                onInstall(entry.installKey);
                            }}
                        >
                            <DownloadCloud aria-hidden="true" />
                            {!isPublished && installing ? 'Installing...' : 'Install'}
                        </Button>
                    )}
                </div>
            </div>
        </article>
    );
};

const ExtensionDetailModal = ({ entry, installing, statusVariant, onClose, onInstall }) => {
    const category = entry.category || 'utility';
    const Icon = getCategoryIcon(category);
    const isLocal = entry.source === 'local';
    const isPublished = entry.source === 'published';
    const iconSvg = entry.icon ? sanitizeSvgInner(entry.icon) : '';
    const screenshots = entry.screenshots || [];
    const installedLabel = !isPublished && entry.status && entry.status !== 'active'
        ? titleCase(entry.status)
        : 'Installed';

    return (
        <Modal open onClose={onClose} title={entry.displayName} size="lg">
            <div className="extension-detail">
                <div className="extension-detail__header">
                    <div className={`extension-detail__icon extension-detail__icon--${category}`}>
                        {iconSvg ? (
                            <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                aria-hidden="true"
                                focusable="false"
                                dangerouslySetInnerHTML={{ __html: iconSvg }}
                            />
                        ) : (
                            <Icon aria-hidden="true" />
                        )}
                    </div>
                    <div className="extension-detail__heading">
                        <div className="extension-detail__badges">
                            {entry.firstParty && (
                                <Badge variant="secondary" className="extension-firstparty">by ServerKit</Badge>
                            )}
                            <Badge variant={sourceBadgeVariant(entry.source)}>{entry.sourceLabel}</Badge>
                            <Badge variant="outline">{titleCase(category)}</Badge>
                        </div>
                        <div className="extension-detail__meta">
                            <span>v{entry.version}</span>
                            {entry.author && <span>by {entry.author}</span>}
                            <span>{isLocal ? 'built-in' : entry.extensionType}</span>
                        </div>
                    </div>
                </div>

                <p className="extension-detail__desc">{entry.description}</p>

                {screenshots.length > 0 && (
                    <div className="extension-detail__gallery" aria-label="Screenshots">
                        {screenshots.map((src, index) => (
                            <img
                                key={src}
                                src={src}
                                alt={`${entry.displayName} screenshot ${index + 1}`}
                                className="extension-detail__shot"
                                loading="lazy"
                            />
                        ))}
                    </div>
                )}

                <div className="extension-detail__actions">
                    {entry.installed ? (
                        <Badge variant={isLocal ? statusVariant(entry.status) : 'success'}>
                            <CheckCircle2 aria-hidden="true" />
                            {installedLabel}
                        </Badge>
                    ) : (
                        <Button disabled={!isPublished && installing} onClick={onInstall}>
                            <DownloadCloud aria-hidden="true" />
                            {!isPublished && installing ? 'Installing...' : 'Install'}
                        </Button>
                    )}
                </div>
            </div>
        </Modal>
    );
};

const InstalledCatalogRow = ({ entry, onUninstall }) => {
    const isLocal = entry.source === 'local';
    const Icon = isLocal ? Archive : PackageCheck;

    return (
        <article className="installed-item card">
            <div className="installed-item__main">
                <div className={`installed-item__icon installed-item__icon--${isLocal ? 'local' : 'extension'}`}>
                    <Icon aria-hidden="true" />
                </div>
                <div className="installed-item__content">
                    <div className="installed-item__title-line">
                        <strong>{entry.displayName}</strong>
                        <span className="text-muted">v{entry.version}</span>
                        <Badge variant={isLocal ? 'warning' : 'outline'}>{entry.sourceLabel}</Badge>
                    </div>
                    {isLocal && (
                        <p className="installed-item__description">
                            Managed as a local registry mapping.
                        </p>
                    )}
                </div>
            </div>
            <div className="installed-item__actions">
                {isLocal ? (
                    <Badge variant="success">Installed</Badge>
                ) : (
                    <Button size="sm" variant="destructive" onClick={() => onUninstall(entry.installId)}>
                        Uninstall
                    </Button>
                )}
            </div>
        </article>
    );
};

const PluginRow = ({ plugin, update, installing, onToggle, onUpdate, onUninstall, statusVariant }) => {
    const updateAvailable = Boolean(update?.update_available);
    const compatible = update?.compatible !== false;

    return (
        <article className={`installed-item installed-item--plugin card ${plugin.status === 'error' ? 'installed-item--error' : ''}`}>
            <div className="installed-item__main">
                <div className="installed-item__icon installed-item__icon--plugin">
                    <PlugZap aria-hidden="true" />
                </div>
                <div className="installed-item__content">
                    <div className="installed-item__title-line">
                        <strong>{plugin.display_name}</strong>
                        <span className="text-muted">v{plugin.version}</span>
                        <Badge variant={statusVariant(plugin.status)}>{plugin.status}</Badge>
                        {plugin.has_backend && <Badge variant="secondary">Backend</Badge>}
                        {plugin.has_frontend && <Badge variant="secondary">Frontend</Badge>}
                        {updateAvailable && (
                            <Badge variant="info" className="plugin-update-badge">
                                Update available → v{update.available_version}
                            </Badge>
                        )}
                    </div>
                    {plugin.description && <p className="installed-item__description">{plugin.description}</p>}
                    {plugin.error_message && <p className="installed-item__error">{plugin.error_message}</p>}
                </div>
            </div>
            <div className="installed-item__actions">
                {updateAvailable && (
                    <Button
                        size="sm"
                        disabled={!compatible || installing}
                        title={compatible ? undefined : 'Panel version is too old for this update'}
                        onClick={() => onUpdate(plugin.id)}
                    >
                        <DownloadCloud aria-hidden="true" />
                        Update
                    </Button>
                )}
                <Button
                    size="sm"
                    variant={plugin.status === 'active' ? 'outline' : 'default'}
                    onClick={() => onToggle(plugin)}
                >
                    {plugin.status === 'active' ? 'Disable' : 'Enable'}
                </Button>
                <Button size="sm" variant="destructive" onClick={() => onUninstall(plugin.id)}>
                    Uninstall
                </Button>
            </div>
        </article>
    );
};

const PluginInstallInput = ({
    description,
    placeholder,
    value,
    onChange,
    onInstall,
    disabled,
    installDisabled,
}) => (
    <div className="plugin-install-source">
        <p className="text-muted">{description}</p>
        <div className="plugin-install-row">
            <Input
                placeholder={placeholder}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && onInstall()}
                disabled={disabled}
            />
            <Button onClick={onInstall} disabled={installDisabled}>
                <DownloadCloud aria-hidden="true" />
                {disabled ? 'Installing...' : 'Install'}
            </Button>
        </div>
    </div>
);

const RuntimeRow = ({ label, value, danger }) => (
    <div className={`marketplace-runtime__row ${danger ? 'marketplace-runtime__row--danger' : ''}`}>
        <span>{label}</span>
        <strong>{value}</strong>
    </div>
);

const renderStars = (rating) => {
    const normalizedRating = Math.max(0, Math.min(5, Number(rating) || 0));

    return (
        <span className="extension-card__stars" aria-label={`${normalizedRating.toFixed(1)} rating`}>
            {Array.from({ length: 5 }, (_, index) => (
                <Star
                    key={index}
                    aria-hidden="true"
                    className={index < Math.round(normalizedRating) ? 'is-filled' : ''}
                />
            ))}
        </span>
    );
};

export default Marketplace;
