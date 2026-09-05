import { useEffect } from 'react';
import { useAuth } from '../contexts/useAuth.js';
import { useTheme } from '../contexts/useTheme.js';
import api from '../services/api';

// Bridges auth → theme (plan 60). ThemeProvider sits above AuthProvider, so it
// can't read auth state itself; this renders inside AuthProvider and, once the
// user is signed in, loads the installed (registry/imported) themes and merges
// them into the gallery. Renders nothing.
const ThemeSync = () => {
    const { isAuthenticated } = useAuth();
    const { registerInstalledThemes } = useTheme();

    useEffect(() => {
        if (!isAuthenticated) return undefined;
        let cancelled = false;
        api.getInstalledThemes?.()
            .then((data) => {
                if (!cancelled && data && Array.isArray(data.themes)) {
                    registerInstalledThemes(data.themes);
                }
            })
            .catch(() => { /* gallery still shows bundled seeds */ });
        return () => { cancelled = true; };
    }, [isAuthenticated, registerInstalledThemes]);

    return null;
};

export default ThemeSync;
