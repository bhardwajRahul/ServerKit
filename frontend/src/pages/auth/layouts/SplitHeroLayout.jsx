import ServerKitLogo from '../../../components/ServerKitLogo';
import { useAuth } from '../../../contexts/AuthContext';

// Split auth layout: a branded hero panel beside the form card. The hero is
// hidden on small screens (the card just centers), so it stays usable on mobile.
export default function SplitHeroLayout({ children }) {
    const { publicTitle } = useAuth();
    return (
        <div className="auth-container auth-split">
            <aside className="auth-split__hero" aria-hidden="true">
                <div className="auth-split__brand">
                    <ServerKitLogo width={56} height={56} />
                    <span className="auth-split__name">{publicTitle || 'Control Panel'}</span>
                </div>
            </aside>
            <div className="auth-card auth-split__card">{children}</div>
        </div>
    );
}
