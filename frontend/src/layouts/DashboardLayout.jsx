import { useState, useEffect, useCallback, useMemo } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import CommandPalette from '../components/CommandPalette';
import LogsDrawer from '../components/LogsDrawer';
import { LogsDrawerProvider } from '../contexts/LogsDrawerContext';
import PluginLoader from '../plugins/PluginLoader';
import { refreshContributions, useContributions } from '../plugins/contributions';
import api from '../services/api';

const FULL_PAGE_ROUTES = ['/workflow', '/files', '/docker'];

const DashboardLayout = () => {
    const location = useLocation();
    const [paletteOpen, setPaletteOpen] = useState(false);
    const { routes: pluginRoutes } = useContributions();

    // Plugin routes contribute their path relative to the dashboard
    // parent (e.g. "git", "git/:tab"). Normalize to leading-slash and
    // strip any :params so we can do a startsWith check below.
    const fullPagePaths = useMemo(() => {
        const fromPlugins = (pluginRoutes || [])
            .filter((r) => r && r.layout === 'full' && r.path)
            .map((r) => {
                const stripped = r.path.split('/:')[0].replace(/^\/+/, '');
                return '/' + stripped;
            });
        return [...FULL_PAGE_ROUTES, ...fromPlugins];
    }, [pluginRoutes]);

    const isFullPageRoute = fullPagePaths.some((route) => (
        location.pathname === route || location.pathname.startsWith(`${route}/`)
    ));

    const handleKeyDown = useCallback((e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
            e.preventDefault();
            setPaletteOpen(prev => !prev);
        }
    }, []);

    useEffect(() => {
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [handleKeyDown]);

    // Load plugin contributions once we're authenticated. Subscribers
    // (Sidebar, CommandPalette, ExtensionRoutes, PageTitleUpdater) all
    // pick up the result via useContributions().
    useEffect(() => {
        refreshContributions();
    }, []);

    return (
        <LogsDrawerProvider>
            <div className="dashboard-layout">
                <Sidebar />
                <main className={`main-content${isFullPageRoute ? ' main-content--full-page' : ''}`}>
                    <Outlet />
                </main>
                <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
                <LogsDrawer />
                <PluginLoader api={api} />
            </div>
        </LogsDrawerProvider>
    );
};

export default DashboardLayout;
