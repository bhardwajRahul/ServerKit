// Deterministic byte census of a production dist. Gzip is per file, level 9;
// totals are storage/transfer estimates, never a page-load speed measurement.
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export function linkedAssets(html) {
    const result = new Set();
    for (const tag of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
        const attributes = Object.fromEntries([...tag[0].matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)]
            .map((match) => [match[1].toLowerCase(), match[2]]));
        const asset = attributes.src || (['stylesheet', 'modulepreload'].includes(attributes.rel) ? attributes.href : null);
        if (asset && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(asset)) {
            result.add(decodeURIComponent(new URL(asset, 'https://build.invalid/').pathname).slice(1));
        }
    }
    return result;
}

export function measureBuild(dist) {
    const root = resolve(dist);
    const walk = (directory) => readdirSync(directory).flatMap((name) => {
        const path = resolve(directory, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
    });
    const fingerprint = createHash('sha256');
    const files = walk(root).filter((path) => ['.js', '.mjs', '.css'].includes(extname(path))).sort().map((path) => {
        const bytes = readFileSync(path);
        const name = relative(root, path).replaceAll('\\', '/');
        fingerprint.update(name).update('\0').update(bytes).update('\0');
        return { path: name, bytes: bytes.length, gzip_bytes: gzipSync(bytes, { level: 9 }).length };
    });
    const linked = linkedAssets(readFileSync(resolve(root, 'index.html'), 'utf8'));
    const missing = [...linked].filter((path) => !files.some((file) => file.path === path));
    if (missing.length) throw new Error(`HTML-linked code assets missing from build: ${missing.join(', ')}`);
    const sum = (items) => ({
        files: items.length,
        bytes: items.reduce((total, file) => total + file.bytes, 0),
        gzip_bytes: items.reduce((total, file) => total + file.gzip_bytes, 0),
    });
    return {
        schema_version: 1,
        measured_at_utc: new Date().toISOString(),
        node_version: process.version,
        measured_code_sha256: fingerprint.digest('hex'),
        compression: 'gzip, level 9, each file separately; sizes are bytes',
        scope: 'Built JS/MJS/CSS, including public vendor shims. Excludes HTML, fonts, images, maps and other non-code assets.',
        html_linked_scope: 'Only script, stylesheet and modulepreload URLs in index.html; not a complete runtime network trace or every later lazy import.',
        all_code: sum(files),
        html_linked_code: sum(files.filter((file) => linked.has(file.path))),
        largest_code_assets: [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 12),
        assets: files,
    };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const here = dirname(fileURLToPath(import.meta.url));
    const args = process.argv.slice(2);
    const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
    const report = measureBuild(value('--dist', resolve(here, '../dist')));
    const output = value('--output', null);
    if (output) {
        mkdirSync(dirname(resolve(output)), { recursive: true });
        writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(JSON.stringify({ all_code: report.all_code, html_linked_code: report.html_linked_code }, null, 2));
}
