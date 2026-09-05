import { createContext, useContext } from 'react';

export const ResourceTierContext = createContext(null);

export function useResourceTier() {
    const context = useContext(ResourceTierContext);
    if (!context) {
        throw new Error('useResourceTier must be used within a ResourceTierProvider');
    }
    return context;
}
