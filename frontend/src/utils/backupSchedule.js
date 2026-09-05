const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const scheduleDays = (schedule) => (Array.isArray(schedule.days) ? schedule.days : ['daily']);
const dayIndex = (day) => DAY_INDEX[String(day).slice(0, 3).toLowerCase()];

// The scheduler owns wall-clock/DST calculations. Never turn schedule_time
// into a browser-local estimate: the browser and server may be in different
// zones. Require an explicit offset so malformed/older responses stay unknown.
export function nextFire(schedule) {
    const value = schedule.next_run_at;
    if (schedule.enabled === false || schedule.schedule_error || typeof value !== 'string'
        || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
    const next = new Date(value);
    return Number.isFinite(next.getTime()) ? next : null;
}

export function untilLabel(date, now) {
    const ms = date.getTime() - now.getTime();
    if (ms <= 0) return 'due now';
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `in ${mins}m`;
    const h = Math.floor(mins / 60);
    if (h < 24) return `in ${h}h ${mins % 60}m`;
    return `in ${Math.round(h / 24)}d`;
}

export function frequencyLabel(schedule) {
    const time = [schedule.schedule_time || '—', schedule.timezone].filter(Boolean).join(' ');
    const days = scheduleDays(schedule);
    if (days.length === 0 || days.includes('daily')) return `Daily · ${time}`;
    if (days.length === 1) {
        const idx = dayIndex(days[0]);
        return `Weekly · ${idx == null ? days[0] : DAY_LABEL[idx]} ${time}`;
    }
    return `${days.length}×/week · ${time}`;
}
