import assert from 'node:assert/strict';
import test from 'node:test';
import { subscribeToMetrics } from '../metricsSubscription.js';

function fakeSocket(alreadyConnected = false) {
    const handlers = new Map();
    return {
        socket: { connected: alreadyConnected },
        subscriptions: 0,
        unsubscriptions: 0,
        connect() {},
        on(event, handler) { handlers.set(event, handler); return () => handlers.delete(event); },
        emit(event, value) { handlers.get(event)?.(value); },
        subscribeMetrics() { this.subscriptions += 1; },
        unsubscribeMetrics() { this.unsubscriptions += 1; },
        handlers,
    };
}

test('socket loss/error re-enables fallback, reconnection subscribes, cleanup releases listeners', () => {
    const socket = fakeSocket();
    const states = [];
    const samples = [];
    const errors = [];
    const cleanup = subscribeToMetrics(socket, {
        onConnected: (value) => states.push(value),
        onMetrics: (value) => samples.push(value),
        onError: (value) => errors.push(value),
    });
    socket.emit('connected');
    socket.emit('metrics', { cpu: 20 });
    socket.emit('disconnected');
    socket.emit('connected');
    socket.emit('error', { message: 'stream failed' });
    assert.deepEqual(states, [true, false, true, false]);
    assert.deepEqual(samples, [{ cpu: 20 }]);
    assert.equal(errors.length, 1);
    assert.equal(socket.subscriptions, 2);
    cleanup();
    assert.equal(socket.handlers.size, 0);
    assert.equal(socket.unsubscriptions, 1);
});

test('an existing connected socket subscribes without waiting for another connect event', () => {
    const socket = fakeSocket(true);
    const states = [];
    const cleanup = subscribeToMetrics(socket, {
        onConnected: (value) => states.push(value), onMetrics() {}, onError() {},
    });
    assert.deepEqual(states, [true]);
    assert.equal(socket.subscriptions, 1);
    cleanup();
});
