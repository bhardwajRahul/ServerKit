import { queryClient } from './queryClient.js';
import { workspaceStore } from './workspaceStore.js';

const PREFIX = ['dashboard-widget'];
const CACHE_TTL_MS = 4000;
const CACHE_MAX_ENTRIES = 96;

export const widgetQueryKey = (key, workspaceId) => [...PREFIX, workspaceId, key];

export function pruneWidgetQueries() {
    queryClient.pruneQueries(PREFIX, CACHE_MAX_ENTRIES);
}

// Board refresh ticks remain part of the caller's key. Fullscreen and adjacent
// charts reuse the same payload; failures remain retryable on the next mount.
export function fetchShared(key, loader, workspaceId = workspaceStore.getSnapshot().activeWorkspaceId) {
    const promise = queryClient.fetchQuery(widgetQueryKey(key, workspaceId), loader, {
        staleTime: CACHE_TTL_MS,
    });
    pruneWidgetQueries();
    return promise.finally(pruneWidgetQueries);
}
