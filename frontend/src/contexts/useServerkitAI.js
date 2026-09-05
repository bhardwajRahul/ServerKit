import { createContext, useContext } from 'react';

export const AIContext = createContext(null);

export function useServerkitAI() {
    const ctx = useContext(AIContext);
    if (!ctx) throw new Error('useServerkitAI must be used within AIProvider');
    return ctx;
}
