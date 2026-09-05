"""Server-local legacy backup schedules, shared by the API and job tick.

Wall-clock schedules retain their original behavior: a missing spring-forward
minute is skipped; both occurrences of a repeated autumn minute can run.
All comparisons use UTC so Python's same-zone arithmetic cannot collapse folds.
"""

from datetime import datetime, timedelta, timezone
import re

from tzlocal import reload_localzone

WEEKDAYS = ('monday', 'tuesday', 'wednesday', 'thursday', 'friday',
            'saturday', 'sunday')


def server_timezone():
    # A panel timezone change must take effect without restarting the process.
    return reload_localzone()


def validate_schedule(schedule):
    value = schedule.get('schedule_time')
    if not isinstance(value, str) or not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', value):
        raise ValueError('schedule_time must be a valid HH:MM time')
    days = schedule.get('days', ['daily'])
    if (not isinstance(days, list) or not days
            or any(not isinstance(day, str) or day not in (*WEEKDAYS, 'daily') for day in days)):
        raise ValueError('days must contain daily or valid lowercase weekday names')
    return tuple(map(int, value.split(':'))), days


def _last_run(schedule, zone):
    try:
        last = datetime.fromisoformat(schedule.get('last_run') or '')
        # Existing records have naive server-local timestamps. New writes carry
        # an offset; retain compatibility without changing persisted schedules.
        return (last if last.tzinfo else last.replace(tzinfo=zone)).astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def next_run(schedule, *, now=None, zone=None):
    """Return the next eligible minute (including the current minute), or None.

    Uses the same 120-second duplicate suppression as the original job tick.
    There is no missed-run catchup: only this minute or a future minute qualifies.
    Invalid legacy schedules remain readable and inert rather than breaking ticks.
    """
    try:
        (hour, minute), days = validate_schedule(schedule)
    except ValueError:
        return None
    if not schedule.get('enabled', False):
        return None
    zone = zone or server_timezone()
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise ValueError('now must include a timezone')
    local_now = now.astimezone(zone)
    start = local_now.replace(second=0, microsecond=0).astimezone(timezone.utc)
    last = _last_run(schedule, zone)
    # A weekly occurrence can be absent during a DST jump; search through the
    # following week's occurrence as well.
    for offset in range(15):
        date = local_now.date() + timedelta(days=offset)
        if 'daily' not in days and WEEKDAYS[date.weekday()] not in days:
            continue
        wall = datetime(date.year, date.month, date.day, hour, minute)
        candidates = set()
        for fold in (0, 1):
            candidate = wall.replace(tzinfo=zone, fold=fold).astimezone(timezone.utc)
            # A nonexistent local minute round-trips to a different wall time.
            if candidate.astimezone(zone).replace(tzinfo=None) == wall:
                candidates.add(candidate)
        for candidate in sorted(candidates):
            if candidate < start:
                continue
            # For a due minute compare against the real tick time, preserving
            # dedup behavior for records stamped partway through that minute.
            check_time = max(candidate, now.astimezone(timezone.utc))
            if last is not None and (check_time - last).total_seconds() < 120:
                continue
            return candidate.astimezone(zone)
    return None


def describe_schedule(schedule, *, globally_enabled=True, now=None, zone=None):
    zone = zone or server_timezone()
    result = dict(schedule)
    result['timezone'] = str(zone)
    try:
        validate_schedule(schedule)
    except ValueError as exc:
        result['schedule_error'] = str(exc)
    following = next_run(schedule, now=now, zone=zone) if globally_enabled else None
    result['next_run_at'] = following.isoformat() if following else None
    return result
