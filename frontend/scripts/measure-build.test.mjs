import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkedAssets, measureBuild } from './measure-build.mjs';

test('separates HTML-linked code from lazy chunks and excludes fonts/images', () => {
    const directory = mkdtempSync(join(tmpdir(), 'serverkit-measure-'));
    try {
        writeFileSync(join(directory, 'index.html'), '<script src="/app.js"></script><link rel="modulepreload" href="/shared.js"><link rel="stylesheet" href="/app.css"><link rel="icon" href="/icon.png">');
        for (const file of ['app.js', 'shared.js', 'lazy.js', 'app.css', 'font.woff2', 'icon.png']) {
            writeFileSync(join(directory, file), '12345');
        }
        const report = measureBuild(directory);
        assert.equal(report.all_code.files, 4);
        assert.equal(report.all_code.bytes, 20);
        assert.equal(report.html_linked_code.files, 3);
        assert.equal(report.html_linked_code.bytes, 15);
        assert.ok(report.all_code.gzip_bytes > report.html_linked_code.gzip_bytes);
    } finally { rmSync(directory, { recursive: true }); }
});

test('deduplicates links, ignores external resources and detects missing assets', () => {
    assert.deepEqual([...linkedAssets('<script src="./app.js?v=2"></script><link rel="modulepreload" href="/app.js"><script src="https://example.test/external.js"></script>')], ['app.js']);
    const directory = mkdtempSync(join(tmpdir(), 'serverkit-measure-'));
    try {
        writeFileSync(join(directory, 'index.html'), '<script src="/missing.js"></script>');
        assert.throws(() => measureBuild(directory), /missing.js/);
    } finally { rmSync(directory, { recursive: true }); }
});
