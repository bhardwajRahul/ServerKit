import assert from 'node:assert/strict';
import test from 'node:test';
import { nextFire, untilLabel, frequencyLabel } from '../backupSchedule.js';

test('daily schedules use one clock and roll an elapsed slot across midnight', () => {
    const now = new Date(2026, 8, 5, 23, 45);
    const next = nextFire({ schedule_time: '00:15' }, now);
    assert.equal(next.getDate(), 6);
    assert.equal(untilLabel(next, now), 'in 30m');
    assert.equal(now.getDate(), 5);
    assert.equal(nextFire({ schedule_time: '23:45' }, now).getDate(), 6);
});

test('weekly schedules accept full and abbreviated weekdays, including next week', () => {
    const now = new Date(2026, 8, 5, 12); // Saturday
    assert.equal(nextFire({ schedule_time: '13:00', days: ['Saturday'] }, now).getDate(), 5);
    assert.equal(nextFire({ schedule_time: '11:00', days: ['sat'] }, now).getDate(), 12);
    assert.equal(frequencyLabel({ schedule_time: '02:00', days: ['sunday'] }), 'Weekly · Sun 02:00');
});

test('malformed schedules cannot silently normalize into a different run time', () => {
    const now = new Date(2026, 8, 5);
    for (const schedule_time of ['', '12', ':30', '24:00', '12:60', '-1:00', '12:30:00']) {
        assert.equal(nextFire({ schedule_time }, now), null, schedule_time);
    }
    assert.equal(nextFire({ schedule_time: '12:30', days: ['noday'] }, now), null);
    assert.equal(nextFire({ schedule_time: '12:30' }, new Date(NaN)), null);
});

test('spring-forward skips a wall-clock slot the server cannot execute', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
        const now = new Date(2026, 2, 8, 0);
        const next = nextFire({ schedule_time: '02:30', days: ['daily'] }, now);
        assert.equal(next.getDate(), 9);
        assert.equal(next.getHours(), 2);
    } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
    }
});
