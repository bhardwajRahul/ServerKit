import assert from 'node:assert/strict';
import test from 'node:test';
import { getInvitations } from '../auth.js';
import { getProcesses, killProcess } from '../system.js';
import { getSSHKeys } from '../security.js';
import { compareServerMetrics, getFleetComparison, searchFleet, exportFleetCsv } from '../servers.js';
import { suggestSubdomain } from '../files.js';
import { getDeploymentJobLogs } from '../deploymentJobs.js';

const capture = { request: async (url, options) => ({ url: new URL(url, 'https://panel.test'), options }) };
const special = 'a &admin=true+# café/東京?%';

test('user-entered query values cannot add parameters or URL fragments', async () => {
    for (const [method, args, key] of [
        [getInvitations, [special], 'status'],
        [getSSHKeys, [special], 'user'],
        [getProcesses, [25, special], 'sort'],
        [searchFleet, [special, special], 'type'],
    ]) {
        const { url } = await method.call(capture, ...args);
        assert.equal(url.searchParams.get(key), special);
        assert.equal(url.searchParams.has('admin'), false);
        assert.equal(url.hash, '');
    }
    const { url } = await searchFleet.call(capture, special, special);
    assert.equal(url.searchParams.get('q'), special); // Existing encoding is not doubled.
});

test('numeric zero, false, optional omission and CSV array contracts stay intact', async () => {
    assert.equal((await getProcesses.call(capture, 0)).url.searchParams.get('limit'), '0');
    assert.equal((await killProcess.call(capture, 42, false)).url.searchParams.get('force'), 'false');
    assert.equal((await getInvitations.call(capture, '')).url.search, '');
    assert.equal((await getDeploymentJobLogs.call(capture, 42, null)).url.search, '');
    for (const method of [compareServerMetrics, getFleetComparison]) {
        const { url } = await method.call(capture, ['one&admin=1', 'two space'], 'cpu', '24h');
        assert.deepEqual(url.searchParams.getAll('ids'), ['one&admin=1,two space']);
        assert.equal(url.searchParams.has('admin'), false);
    }
    const { url } = await suggestSubdomain.call(capture, 0, special);
    assert.equal(url.searchParams.get('application_id'), '0');
    assert.equal(url.searchParams.get('base'), special);
});

test('CSV download query encoding preserves authenticated download behavior', async () => {
    const original = globalThis.fetch;
    let received;
    globalThis.fetch = async (url, options) => {
        received = { url: new URL(url), options };
        return { blob: async () => 'csv' };
    };
    try {
        const result = await exportFleetCsv.call({ baseUrl: 'https://panel.test/api', getToken: () => 'token' }, ['one', 'two'], special, '24h');
        assert.equal(result, 'csv');
        assert.equal(received.url.searchParams.get('metric'), special);
        assert.equal(received.url.searchParams.get('ids'), 'one,two');
        assert.equal(received.options.headers.Authorization, 'Bearer token');
    } finally {
        globalThis.fetch = original;
    }
});
