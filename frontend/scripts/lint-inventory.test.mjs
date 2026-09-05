import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { warningInventory, warningRegressions } from './lint-inventory.mjs';

test('warning baseline excludes installed copies but includes newly added source', () => {
    const root = resolve('fixture');
    const file = resolve(root, 'src/new.jsx');
    const installed = resolve(root, 'src/plugins/installed.jsx');
    const messages = [{ severity: 1, ruleId: 'no-unused-vars' }, { severity: 2, ruleId: 'no-undef' }];
    assert.deepEqual(warningInventory([{ filePath: file, messages }, { filePath: installed, messages }], root, new Set([file])), {
        'src/new.jsx': { 'no-unused-vars': 1 },
    });
});

test('new files, new rules, and growing counts fail; reductions pass', () => {
    const baseline = { 'src/page.jsx': { 'no-unused-vars': 2 } };
    assert.equal(warningRegressions({ 'src/page.jsx': { 'no-unused-vars': 3 } }, baseline).length, 1);
    assert.equal(warningRegressions({ 'src/page.jsx': { 'react-hooks/exhaustive-deps': 1 } }, baseline).length, 1);
    assert.equal(warningRegressions({ 'src/new.jsx': { 'no-unused-vars': 1 } }, baseline).length, 1);
    assert.deepEqual(warningRegressions({ 'src/page.jsx': { 'no-unused-vars': 1 } }, baseline), []);
    assert.deepEqual(warningRegressions({}, baseline), []);
});
