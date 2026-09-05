import {
    SiWordpress, SiCloudflare, SiGitea, SiGit, SiNvidia, SiWireguard,
} from 'react-icons/si';

// Strip the conventional `serverkit-` prefix and lowercase so keyword matching
// works on both `serverkit-wordpress` and `wordpress`.
const normalizeSlug = (slug) => String(slug || '').toLowerCase().replace(/^serverkit-/, '');

// Ordered keyword rules — first match wins. Keep the most specific keys first
// (gitea before the generic git fallback).
const BRAND_RULES = [
    { keys: ['wordpress'], Icon: SiWordpress },
    { keys: ['cloudflare'], Icon: SiCloudflare },
    { keys: ['gitea', 'forgejo'], Icon: SiGitea },
    { keys: ['git'], Icon: SiGit },
    { keys: ['gpu', 'nvidia', 'cuda'], Icon: SiNvidia },
    { keys: ['wireguard', 'remote'], Icon: SiWireguard },
];

export const resolveBrand = (slug) => {
    const normalized = normalizeSlug(slug);
    const rule = BRAND_RULES.find((item) => item.keys.some((key) => normalized.includes(key)));
    return rule ? rule.Icon : null;
};

export function hasBrandMark(slug) {
    return Boolean(resolveBrand(slug));
}

// Deterministic per-slug cover gradient. Hashes the slug to a hue so each
// extension keeps a stable, distinct backdrop across renders. This is the one
// data-derived inline style allowed on the marketplace surface.
export function extensionCoverStyle(slug, category) {
    const seed = String(slug || category || 'extension');
    let hash = 0;
    for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    const hue = hash % 360;
    const hueShift = (hue + 28) % 360;
    return {
        background: `linear-gradient(135deg, hsl(${hue} 52% 42%), hsl(${hueShift} 58% 28%))`,
    };
}
