// Automations (tramo) UI, contributed through the extension system. Fully
// self-contained in the extension. After sync this folder lives at
// frontend/src/plugins/serverkit-tramo/, so '@/…' host aliases resolve.
//
// plugin.json declares two route components — AutomationsPage (the tabbed
// list/runs/settings surface) and AutomationEditorPage (the full-bleed canvas).
// Both are resolved by name from these exports.
export { AutomationsPage } from './components/AutomationsPage.jsx';
export { AutomationEditorPage } from './components/AutomationEditorPage.jsx';

// No default export on purpose: PluginLoader legacy-auto-renders any plugin
// default export globally. The route contributions resolve the NAMED exports.
