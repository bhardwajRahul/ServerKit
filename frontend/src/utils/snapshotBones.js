/**
 * Browser-side skeleton snapshot — a faithful port of boneyard-js `snapshotBones`
 * (`packages/boneyard/src/extract.ts`). Walks the children of `el`, emitting a
 * "bone" for each leaf placeholder (and a lighter container bone for visual
 * surfaces), and returns a SkeletonResult:
 *
 *   { name, viewportWidth, width, height, bones: [{x, y, w, h, r, c?}] }
 *
 * `x`/`w` are PERCENTAGES of the region width (responsive); `y`/`h` are ABSOLUTE
 * PIXELS from the region top; `r` is a number (px) or a CSS string ("50%" =
 * circle); `c: true` marks a background/container bone.
 *
 * Pure and fully self-contained (references only browser layout globals), so the
 * dev-time capture script (`scripts/capture-skeletons.mjs`) can also inject it
 * into a page via `.toString()`. Requires a live DOM (`getBoundingClientRect`,
 * `getComputedStyle`) — call it after the real content has rendered.
 *
 * @param {Element} el       Region root whose subtree becomes bones.
 * @param {string}  [name]   Label stored on the result.
 * @returns {{name:string,viewportWidth:number,width:number,height:number,bones:Array}}
 */
export function snapshotBones(el, name = 'component') {
    const round = (n) => Math.round(n);
    const round4 = (n) => Math.round(n * 10000) / 10000;
    const MEDIA = new Set(['IMG', 'SVG', 'VIDEO', 'CANVAS']);
    const FORM = new Set(['INPUT', 'BUTTON', 'TEXTAREA', 'SELECT']);
    const LEAF_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH']);
    const rootRect = el.getBoundingClientRect();
    const bones = [];
    if (rootRect.width < 1 || rootRect.height < 1) {
        return { name, viewportWidth: round(rootRect.width), width: round(rootRect.width), height: round(rootRect.height), bones };
    }

    const parseRadius = (cs) => {
        const r = cs.borderTopLeftRadius;
        if (!r || r === '0px') return null;
        const px = parseFloat(r);
        return Number.isFinite(px) ? px : null;
    };
    const isVisible = (node) => {
        const cs = getComputedStyle(node);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
    };
    const relX = (rect) => round4(((rect.left - rootRect.left) / rootRect.width) * 100);
    const relW = (rect) => round4((rect.width / rootRect.width) * 100);

    const walk = (node) => {
        if (!(node instanceof Element) || !isVisible(node)) return;
        const cs = getComputedStyle(node);
        const kids = Array.from(node.children).filter((c) => c instanceof Element && isVisible(c));
        const tag = node.tagName;
        const isLeaf = kids.length === 0 || MEDIA.has(tag) || FORM.has(tag) || LEAF_TAGS.has(tag);

        if (isLeaf) {
            const rect = node.getBoundingClientRect();
            if (rect.width < 1 || rect.height < 1) return;
            const squarish = MEDIA.has(tag) && Math.abs(rect.width - rect.height) < 4;
            const r = squarish ? '50%' : (parseRadius(cs) ?? 8);
            bones.push({ x: relX(rect), y: round(rect.top - rootRect.top), w: relW(rect), h: round(rect.height), r });
            return;
        }

        // Non-leaf: emit a lighter container bone for visual surfaces, then recurse.
        const hasBg = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
        const hasBgImage = cs.backgroundImage && cs.backgroundImage !== 'none';
        const hasBorder = parseFloat(cs.borderTopWidth) > 0
            && cs.borderTopColor && cs.borderTopColor !== 'rgba(0, 0, 0, 0)';
        const hasRadius = parseFloat(cs.borderTopLeftRadius) > 0;
        if (hasBg || hasBgImage || (hasBorder && hasRadius)) {
            const rect = node.getBoundingClientRect();
            if (rect.width >= 1 && rect.height >= 1) {
                bones.push({ x: relX(rect), y: round(rect.top - rootRect.top), w: relW(rect), h: round(rect.height), r: parseRadius(cs) ?? 8, c: true });
            }
        }
        kids.forEach(walk);
    };

    Array.from(el.children).forEach(walk);
    return {
        name,
        viewportWidth: round(rootRect.width),
        width: round(rootRect.width),
        height: round(rootRect.height),
        bones,
    };
}

export default snapshotBones;
