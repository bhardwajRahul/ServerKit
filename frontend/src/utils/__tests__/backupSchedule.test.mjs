import assert from 'node:assert/strict';
import test from 'node:test';
import { nextFire, untilLabel, frequencyLabel } from '../backupSchedule.js';

test('countdowns use the authoritative instant across browser timezones', () => {
    const previous = process.env.TZ;
    try {
        for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
            process.env.TZ = zone;
            const next = nextFire({ schedule_time: '02:00', timezone: 'America/New_York', next_run_at: '2026-09-06T02:00:00-04:00' });
            assert.equal(next.toISOString(), '2026-09-06T06:00:00.000Z');
            assert.equal(untilLabel(next, new Date('2026-09-06T05:30:00Z')), 'in 30m');
        }
    } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
    }
});

test('unknown, invalid, disabled and timezone-less next runs are never guessed', () => {
    for (const next_run_at of [undefined, null, '', 'invalid', '2026-09-06T02:00:00', 1788650000]) {
        assert.equal(nextFire({ schedule_time: '02:00', next_run_at }), null);
    }
    const next_run_at = '2026-09-06T02:00:00Z';
    assert.equal(nextFire({ enabled: false, next_run_at }), null);
    assert.equal(nextFire({ schedule_error: 'Invalid time', next_run_at }), null);
    assert.equal(nextFire({ enabled: true, next_run_at: null }), null); // Global pause.
});

test('DST folds use the backend offset and due slots do not move to tomorrow', () => {
    const first = nextFire({ next_run_at: '2026-11-01T01:30:00-04:00' });
    const second = nextFire({ next_run_at: '2026-11-01T01:30:00-05:00' });
    assert.equal(second - first, 3600000);
    assert.equal(untilLabel(first, first), 'due now');
    assert.equal(untilLabel(first, second), 'due now');
});

test('frequency labels retain the server wall time and state its timezone', () => {
    assert.equal(frequencyLabel({ schedule_time: '02:00', timezone: 'America/New_York' }), 'Daily · 02:00 America/New_York');
    assert.equal(frequencyLabel({ schedule_time: '02:00', days: ['sunday'] }), 'Weekly · Sun 02:00');
});
