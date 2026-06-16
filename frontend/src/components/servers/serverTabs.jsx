import { Server, Users, Activity, Cloud, FileCog } from 'lucide-react';

// Shared sub-nav for the Servers page group (Servers / Agent Fleet / Fleet
// Monitor / Cloud Servers / Config Templates). Rendered in each page's
// <PageTopbar tabs={SERVER_TABS}> — the demo's top-bar layout replaces the old
// sidebar sub-menu (see docs/REDESIGN_MAP.md §6 decision 3).
export const SERVER_TABS = [
    { to: '/servers', label: 'Servers', end: true, icon: <Server size={15} /> },
    { to: '/fleet', label: 'Agent Fleet', icon: <Users size={15} /> },
    { to: '/fleet-monitor', label: 'Fleet Monitor', icon: <Activity size={15} /> },
    { to: '/cloud', label: 'Cloud Servers', icon: <Cloud size={15} /> },
    { to: '/server-templates', label: 'Config Templates', icon: <FileCog size={15} /> },
];
