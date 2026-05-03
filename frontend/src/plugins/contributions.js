/**
 * Plugin contribution loader.
 *
 * Source of truth for what an installed plugin contributes to the host UI:
 *   - sidebar items
 *   - SPA routes
 *   - page titles
 *   - command-palette entries
 *   - global widgets
 *
 * The backend exposes the merged contribution envelope at
 * /api/v1/plugins/contributions. Each contribution carries the source
 * `plugin` slug; we resolve `component` strings against the plugin's
 * own index module (discovered at build time via import.meta.glob).
 *
 * Build-time discovery means a freshly installed plugin's frontend code
 * still requires `npm run build` to ship — that's the existing constraint
 * of the plugin system, not new here. Contribution metadata is dynamic
 * though, so toggling plugins on/off updates the UI without a rebuild.
 */
import { useEffect, useState } from 'react';
import api from '../services/api';

// Discover every plugin module at build time. Each plugin is expected to
// expose its components from src/plugins/<slug>/index.{js,jsx}.
const pluginModules = import.meta.glob('../plugins/*/index.{js,jsx}', { eager: true });

const moduleBySlug = (() => {
    const out = {};
    for (const [path, mod] of Object.entries(pluginModules)) {
        const m = path.match(/\/plugins\/([^/]+)\/index\.(?:js|jsx)$/);
        if (!m) continue;
        out[m[1]] = mod;
    }
    return out;
})();

export function getPluginModule(slug) {
    return moduleBySlug[slug] || null;
}

// Resolve a contribution's `component` string to an actual React component.
// `component` may be:
//   - "default"  → mod.default
//   - "Foo"      → mod.Foo (named export)
// Returns null if no match; caller decides whether to skip + warn.
export function resolveComponent(slug, name) {
    const mod = moduleBySlug[slug];
    if (!mod) return null;
    if (!name || name === 'default') return mod.default || null;
    return mod[name] || null;
}

const EMPTY = {
    nav: [],
    routes: [],
    page_titles: {},
    command_palette: [],
    widgets: [],
    layouts: [],
};

// Built-in layout ids. These are reserved — a plugin can't redefine them.
//   padded  → routes go inside DashboardLayout, normal padding (default)
//   full    → routes go inside DashboardLayout, no padding (FULL_PAGE_ROUTES)
//   bare    → routes go OUTSIDE DashboardLayout, just the page + auth guard
export const BUILTIN_LAYOUTS = new Set(['padded', 'full', 'bare']);

// True iff this layout is rendered inside the dashboard chrome. The
// other case (bare + custom plugin layouts) gets its own top-level
// route tree in App.jsx.
export function isInsideDashboard(layoutId) {
    if (!layoutId || layoutId === 'padded' || layoutId === 'full') return true;
    return false;
}

// Resolve a custom (plugin-contributed) layout id to a React component.
// Built-ins return null — App.jsx handles them directly. Returns null
// if the id is unknown or the referenced component can't be found.
export function resolveCustomLayout(layoutId, layouts) {
    if (!layoutId || BUILTIN_LAYOUTS.has(layoutId)) return null;
    const decl = (layouts || []).find((l) => l && l.id === layoutId);
    if (!decl) return null;
    return resolveComponent(decl.plugin, decl.component);
}

let cachedPromise = null;
let cachedValue = null;
const subscribers = new Set();

function notify(value) {
    cachedValue = value;
    for (const cb of subscribers) {
        try { cb(value); } catch { /* swallow subscriber errors */ }
    }
}

export function refreshContributions() {
    cachedPromise = api.getPluginContributions()
        .then((data) => {
            const merged = { ...EMPTY, ...(data || {}) };
            notify(merged);
            return merged;
        })
        .catch(() => {
            // No active plugins / endpoint missing / unauthenticated —
            // fall back to an empty envelope so the host renders normally.
            notify(EMPTY);
            return EMPTY;
        });
    return cachedPromise;
}

export function useContributions() {
    const [value, setValue] = useState(cachedValue || EMPTY);

    useEffect(() => {
        subscribers.add(setValue);
        if (!cachedPromise) refreshContributions();
        else if (cachedValue) setValue(cachedValue);
        return () => subscribers.delete(setValue);
    }, []);

    return value;
}
