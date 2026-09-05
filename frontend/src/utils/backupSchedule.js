const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const scheduleDays = (schedule) => (Array.isArray(schedule.days) ? schedule.days : ['daily']);
const dayIndex = (day) => DAY_INDEX[String(day).slice(0, 3).toLowerCase()];

// Legacy schedules contain wall-clock time, without an IANA timezone. Execution
// is server-local; this preserves the existing browser-local *estimate*. An
// authoritative cross-zone countdown requires a next_run/timezone API field.
// Use a single explicit clock for both calculation and wording in each render.
export function nextFire(schedule, now) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(schedule.schedule_time || ''));
    if (!match || !Number.isFinite(now?.getTime())) return null;
    const hh = Number(match[1]);
    const mm = Number(match[2]);
    if (hh > 23 || mm > 59) return null;
    const days = scheduleDays(schedule);
    const daily = days.length === 0 || days.includes('daily');
    const wanted = new Set(days.map(dayIndex).filter((day) => day != null));
    if (!daily && wanted.size === 0) return null;
    for (let offset = 0; offset <= 7; offset += 1) {
        const candidate = new Date(now);
        candidate.setDate(candidate.getDate() + offset);
        candidate.setHours(hh, mm, 0, 0);
        // Spring-forward can normalize a nonexistent 02:30 into 03:30. The
        // scheduler matches wall time exactly, so skip that day's absent slot.
        if (candidate.getHours() !== hh || candidate.getMinutes() !== mm) continue;
        if (candidate.getTime() <= now.getTime()) continue;
        if (daily || wanted.has(candidate.getDay())) return candidate;
    }
    return null;
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
    const time = schedule.schedule_time || '—';
    const days = scheduleDays(schedule);
    if (days.length === 0 || days.includes('daily')) return `Daily · ${time}`;
    if (days.length === 1) {
        const idx = dayIndex(days[0]);
        return `Weekly · ${idx == null ? days[0] : DAY_LABEL[idx]} ${time}`;
    }
    return `${days.length}×/week · ${time}`;
}
