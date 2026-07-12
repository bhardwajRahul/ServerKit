// TramoEditor — the heavy editor chunk.
//
// Everything tramo-visual lives behind this module so it code-splits away from
// the panel entry bundle. AutomationEditorPage React.lazy()-imports it; nothing
// on the entry path may import this file (or tramo/react / tramo/styles.css)
// statically, or the split collapses.
import { useEffect } from 'react';
import { Canvas, RightRail, useWorkflow } from 'tramo/react';
import api from '@/services/api';
import EmptyState from '@/components/EmptyState';
import { registry } from '../registry.js';

// tramo's own canvas + inspector CSS. Imported here (inside the lazy chunk) so
// it ships with the editor, not the entry bundle.
import 'tramo/styles.css';

const TramoEditor = ({ slug, onSaveStateChange }) => {
    const handle = useWorkflow({
        registry,
        key: slug,
        loadDoc: async () => {
            const data = await api.request(`/tramo/workflows/${slug}`);
            const doc = data.doc || { version: 1, id: slug, name: slug, nodes: [], edges: [], meta: {} };
            // The editor's Canvas reads `doc.meta.mcpServers` unconditionally, so a
            // doc without `meta` crashes it. Guarantee `meta` for brand-new
            // workflows and any doc persisted by an older version.
            if (!doc.meta) doc.meta = {};
            return doc;
        },
        saveDoc: async (doc) => {
            await api.request(`/tramo/workflows/${slug}`, { method: 'PUT', body: { doc } });
        },
    });

    // Surface the debounced save lifecycle up to the page's top strip.
    useEffect(() => {
        if (onSaveStateChange) onSaveStateChange(handle.saveState);
    }, [handle.saveState, onSaveStateChange]);

    if (!handle.ready) {
        return (
            <div className="tramo-editor__loading">
                <EmptyState loading title="Loading workflow..." />
            </div>
        );
    }

    return (
        <div className="tramo-editor">
            <div className="tramo-editor__canvas">
                <Canvas workflow={handle} />
            </div>
            <div className="tramo-editor__rail">
                <RightRail
                    selection={handle.selection}
                    registry={handle.registry}
                    onApply={handle.applyPatch}
                    onClose={handle.clearSelection}
                    saveState={handle.saveState}
                    doc={handle.doc}
                />
            </div>
        </div>
    );
};

export default TramoEditor;
