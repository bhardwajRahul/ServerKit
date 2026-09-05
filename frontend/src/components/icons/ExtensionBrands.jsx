// Brand-authentic marks for bundled extensions, plus a deterministic per-slug
// cover gradient. Mirrors components/icons/DatabaseBrands.jsx: wrap Simple Icons
// (via react-icons) so recognizable products (WordPress, Cloudflare, Gitea,
// NVIDIA, WireGuard) show their real brand mark instead of a generic glyph.
//
// Slugs without a real brand icon return null so the caller can fall back to the
// manifest icon or the category lucide glyph.
import { resolveBrand } from './extensionBrandData';

// Renders the brand mark for a known bundled slug, or null when we have no real
// brand icon (fallback handled by the caller). Simple Icons render with
// `fill="currentColor"`, so cover styling controls the tint without inline color.
export function ExtensionBrandMark({ slug, size = 34, className }) {
    const Icon = resolveBrand(slug);
    if (!Icon) return null;
    return <Icon size={size} className={className} aria-hidden="true" />;
}

export default ExtensionBrandMark;
