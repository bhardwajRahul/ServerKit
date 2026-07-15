import { useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';

/**
 * Hook to set the page title (suffixed with " | <panel title>")
 * @param {string} title - The page title
 */
export function usePageTitle(title) {
    const { panelTitle } = useAuth();
    useEffect(() => {
        const brand = panelTitle || 'ServerKit';
        const previousTitle = document.title;
        document.title = title ? `${title} | ${brand}` : brand;

        return () => {
            document.title = previousTitle;
        };
    }, [title, panelTitle]);
}

export default usePageTitle;
