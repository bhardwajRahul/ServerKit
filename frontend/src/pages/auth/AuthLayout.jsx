import { useAuth } from '../../contexts/AuthContext';
import CenteredLayout from './layouts/CenteredLayout';
import SplitHeroLayout from './layouts/SplitHeroLayout';
import MinimalLayout from './layouts/MinimalLayout';

// Picks the auth-page chrome from the admin-configured `login_layout` setting
// (exposed pre-auth via /auth/setup-status → useAuth().loginLayout). Unknown
// values fall back to the centered card.
const LAYOUTS = {
    centered: CenteredLayout,
    split: SplitHeroLayout,
    minimal: MinimalLayout,
};

export default function AuthLayout({ children }) {
    const { loginLayout } = useAuth();
    const Layout = LAYOUTS[loginLayout] || CenteredLayout;
    return <Layout>{children}</Layout>;
}
