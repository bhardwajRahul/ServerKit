import { createContext, useContext } from 'react';

export const NotificationsContext = createContext(null);

export function useNotifications() {
    return useContext(NotificationsContext);
}

export default NotificationsContext;
