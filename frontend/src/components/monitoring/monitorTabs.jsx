import { Activity, Globe } from 'lucide-react';

// Shared sub-nav for the Monitoring page group (Monitoring / Status Pages).
// Rendered in each page's <PageTopbar tabs={MONITOR_TABS}> — the demo's top-bar
// layout replaces the old sidebar sub-menu (see docs/REDESIGN_MAP.md §6 dec. 3).
export const MONITOR_TABS = [
    { to: '/monitoring', label: 'Monitoring', end: true, icon: <Activity size={15} /> },
    { to: '/status-pages', label: 'Status Pages', icon: <Globe size={15} /> },
];
