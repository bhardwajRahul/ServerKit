// Brand-authentic database engine icons. These wrap Simple Icons (via
// react-icons) so each engine is instantly recognizable — MySQL dolphin,
// PostgreSQL elephant, MongoDB leaf, Redis, SQLite, Docker whale — instead of
// the generic lucide glyph every engine shared before.
//
// All Simple Icons render with `fill="currentColor"`, so the existing
// `.is-<engine>` SCSS tinting still controls the color with no inline styles.
import { Database } from 'lucide-react';
import { ENGINE_ICONS } from './databaseBrandData';

// Renders the brand icon for an engine, falling back to the generic lucide
// Database glyph for anything we don't have a brand for.
export function EngineIcon({ engine, size = 15, className }) {
    const Cmp = ENGINE_ICONS[engine] || Database;
    return <Cmp size={size} className={className} aria-hidden="true" />;
}

export default EngineIcon;
