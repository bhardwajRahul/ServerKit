// Canonical byte/size formatter for the whole frontend.
//
// Replaces the ~14 local `formatBytes` / `formatSize` / `formatMemory`
// implementations that had drifted apart (different decimals, different KB vs
// KiB conventions, different empty-value handling). Import this instead of
// rolling a new one.
//
//   formatBytes(1536)                       -> "1.5 KB"
//   formatBytes(1536, { binary: true })     -> "1.5 KiB"
//   formatBytes(0)                          -> "0 B"
//   formatBytes(null)                        -> "-"
//   formatBytes(1234567, { decimals: 0 })   -> "1 MB"
//   formatBytes(2048, { suffix: false })    -> "2"

const DECIMAL_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
const BINARY_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];

export function formatBytes(bytes, options = {}) {
    const {
        decimals = 1,
        suffix = true,
        binary = false, // true -> KiB/MiB/GiB (1024), false -> KB/MB/GB (1000)
        defaultValue = '-',
    } = options;

    if (bytes === null || bytes === undefined || bytes === '') return defaultValue;

    const value = typeof bytes === 'string' ? Number(bytes) : bytes;
    if (!Number.isFinite(value)) return defaultValue;
    if (value === 0) return suffix ? '0 B' : '0';

    const base = binary ? 1024 : 1000;
    const units = binary ? BINARY_UNITS : DECIMAL_UNITS;

    const negative = value < 0;
    const abs = Math.abs(value);

    const exponent = Math.min(
        Math.floor(Math.log(abs) / Math.log(base)),
        units.length - 1
    );
    const scaled = abs / base ** exponent;

    // Whole-byte values never need decimals.
    const places = exponent === 0 ? 0 : decimals;
    let formatted = scaled.toFixed(places);

    // Trim trailing zeros ("1.0" -> "1", "1.50" -> "1.5") for a cleaner read.
    if (formatted.includes('.')) {
        formatted = formatted.replace(/\.?0+$/, '');
    }

    const sign = negative ? '-' : '';
    return suffix ? `${sign}${formatted} ${units[exponent]}` : `${sign}${formatted}`;
}

export default formatBytes;
