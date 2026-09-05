import assert from 'node:assert/strict';
import test from 'node:test';
import { queryClient } from '../queryClient.js';
import { fetchShared, widgetQueryKey, pruneWidgetQueries } from '../widgetQueries.js';

test('board and fullscreen share a pending payload and a fresh result; tick and workspace isolate', async () => {
    queryClient.clear();
    let calls = 0;
    let resolve;
    const load = () => { calls += 1; return new Promise((done) => { resolve = done; }); };
    const first = fetchShared('history|local|1h|0', load, 'a');
    const fullscreen = fetchShared('history|local|1h|0', load, 'a');
    await Promise.resolve();
    resolve({ points: [1] });
    assert.deepEqual(await first, await fullscreen);
    await fetchShared('history|local|1h|0', load, 'a');
    assert.equal(calls, 1);
    await fetchShared('history|local|1h|1', async () => 'tick', 'a');
    await fetchShared('history|local|1h|0', async () => 'other workspace', 'b');
    assert.equal(queryClient.getSnapshot(widgetQueryKey('history|local|1h|1', 'a')).data, 'tick');
    assert.equal(queryClient.getSnapshot(widgetQueryKey('history|local|1h|0', 'b')).data, 'other workspace');
});

test('permission errors remain visible to all consumers and retry on the next mount', async () => {
    queryClient.clear();
    const error = Object.assign(new Error('Forbidden'), { status: 403 });
    await assert.rejects(fetchShared('activity', async () => { throw error; }, 'a'), error);
    assert.equal(queryClient.getSnapshot(widgetQueryKey('activity', 'a')).error.status, 403);
    assert.equal(await fetchShared('activity', async () => 'allowed now', 'a'), 'allowed now');
});

test('retention is bounded without evicting pending or observed widget data', async () => {
    queryClient.clear();
    const pinned = widgetQueryKey('pinned', 'a');
    const unsubscribe = queryClient.subscribe(pinned, () => {}, { cancelOnUnsubscribe: false });
    await fetchShared('pinned', async () => 'visible', 'a');
    let resolve;
    const pending = fetchShared('pending', () => new Promise((done) => { resolve = done; }), 'a');
    for (let i = 0; i < 120; i += 1) await fetchShared(`tick-${i}`, async () => i, 'a');
    assert.equal(queryClient.getSnapshot(pinned).data, 'visible');
    assert.equal(queryClient.getSnapshot(widgetQueryKey('tick-0', 'a')).status, 'idle');
    let duplicateCalls = 0;
    const duplicate = fetchShared('pending', async () => { duplicateCalls += 1; }, 'a');
    resolve('slow result');
    assert.equal(await pending, 'slow result');
    assert.equal(await duplicate, 'slow result');
    assert.equal(duplicateCalls, 0);
    unsubscribe();
    pruneWidgetQueries();
});
