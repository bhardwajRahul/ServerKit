import { createContext, useContext } from 'react';

export const ShellDockContext = createContext(null);

export function useShellDock() {
    const context = useContext(ShellDockContext);
    if (!context) throw new Error('useShellDock must be used within ShellDockProvider');
    return context;
}
