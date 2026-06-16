import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/utils';

// The demo's page top bar (see docs/REDESIGN_MAP.md §6 decision 3): infra pages
// carry their own top bar — an icon + title, an optional routed sub-nav that
// replaces sidebar sub-menus, a spacer, and right-aligned actions.
//
//   <PageTopbar icon={<Globe/>} title="Domains"
//       tabs={[{ to:'/domains', label:'Domains', end:true }, { to:'/dns', label:'DNS Zones' }]}
//       actions={<Button>Add domain</Button>} />
export function PageTopbar({ icon, title, meta, tabs, actions, className }) {
    return (
        <header className={cn('sk-topbar', className)}>
            {icon && <span className="sk-topbar__ico">{icon}</span>}
            <div className="sk-topbar__titles">
                <h1 className="sk-topbar__title">{title}</h1>
                {meta && <span className="sk-topbar__meta">{meta}</span>}
            </div>

            {tabs && tabs.length > 0 && (
                <nav className="sk-topbar__tabs" aria-label={`${title} sections`}>
                    {tabs.map((t) => (
                        <NavLink
                            key={t.to}
                            to={t.to}
                            end={t.end}
                            className={({ isActive }) => cn('sk-topbar__tab', isActive && 'is-active')}
                        >
                            {t.icon}
                            {t.label}
                        </NavLink>
                    ))}
                </nav>
            )}

            <div className="sk-topbar__spacer" />
            {actions && <div className="sk-topbar__actions">{actions}</div>}
        </header>
    );
}

export default PageTopbar;
