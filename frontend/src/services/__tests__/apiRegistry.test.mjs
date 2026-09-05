import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parse } from 'espree';
import { bindApiMethods } from '../api/registry.js';
import * as apps from '../api/apps.js';
import * as system from '../api/system.js';
import * as jobs from '../api/jobs.js';
import * as servers from '../api/servers.js';
import * as plugins from '../api/plugins.js';

test('rejects domain and inherited client collisions before binding any methods', () => {
    const client = Object.create({ request() {} });
    assert.throws(() => bindApiMethods(client, [{ okay() {}, request() {} }]), /Duplicate API method: request/);
    assert.equal(Object.hasOwn(client, 'okay'), false);
    assert.throws(() => bindApiMethods(client, [{ duplicate() {} }, { duplicate() {} }]), /duplicate/);
});

test('all registered domain exports are unique and avoid client methods and fields', async () => {
    const index = await readFile(new URL('../api/index.js', import.meta.url), 'utf8');
    const clientSource = await readFile(new URL('../api/client.js', import.meta.url), 'utf8');
    const clientAst = parse(clientSource, { ecmaVersion: 'latest', sourceType: 'module' });
    const clientClass = clientAst.body.find((node) => node.type === 'ClassDeclaration');
    const client = {};
    for (const member of clientClass.body.body) client[member.key.name] = () => {};
    // Instance fields assigned by the constructor are reserved too.
    for (const match of clientSource.matchAll(/this\.(\w+)\s*=/g)) client[match[1]] = null;
    const modules = [];
    for (const [, path] of index.matchAll(/import \* as \w+ from '(.+)'/g)) {
        const source = await readFile(new URL(`../api/${path}`, import.meta.url), 'utf8');
        const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
        const exports = {};
        for (const node of ast.body) {
            if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration') {
                exports[node.declaration.id.name] = () => {};
            }
        }
        modules.push(exports);
    }
    assert.ok(modules.length > 40);
    assert.doesNotThrow(() => bindApiMethods(client, modules));
});

test('previously colliding operations have distinct URLs, preserving public winners', async () => {
    const paths = [];
    const client = { request: async (path) => { paths.push(path); } };
    bindApiMethods(client, [apps, system, jobs, servers, plugins]);
    await client.getServices();
    await client.getAppServices();
    await client.getJobStats();
    await client.getBackgroundJobStats();
    await client.uninstallPlugin('panel');
    await client.uninstallPluginInstall('agent');
    assert.deepEqual(paths, [
        '/system/services', '/apps', '/jobs/stats', '/performance/jobs/stats',
        '/plugins/panel', '/agent-plugins/installs/agent',
    ]);
});
