"""Legacy schedule API and execution agree across zones and DST boundaries."""

from copy import deepcopy
from datetime import datetime, timezone
from unittest.mock import Mock
from zoneinfo import ZoneInfo

import pytest

from app.services import backup_schedule_service as schedules
from app.services.backup_service import BackupService


def schedule(**overrides):
    return {'id': 'nightly', 'enabled': True, 'schedule_time': '02:30',
            'days': ['daily'], **overrides}


@pytest.mark.parametrize('zone_name,now,expected', [
    ('America/New_York', '2026-09-05T03:00:00+00:00', '2026-09-05T02:30:00-04:00'),
    ('Asia/Kolkata', '2026-09-05T00:00:00+00:00', '2026-09-06T02:30:00+05:30'),
    # 02:30 never occurs on the spring-forward date.
    ('America/New_York', '2026-03-08T05:00:00+00:00', '2026-03-09T02:30:00-04:00'),
])
def test_next_run_uses_server_zone(zone_name, now, expected):
    result = schedules.next_run(schedule(), now=datetime.fromisoformat(now), zone=ZoneInfo(zone_name))
    assert result.isoformat() == expected


@pytest.mark.parametrize('now', ['2026-03-08T05:00:00+00:00', '2026-03-01T09:00:00+00:00'])
def test_weekly_spring_gap_skips_to_next_week(now):
    result = schedules.next_run(schedule(days=['sunday']),
                                now=datetime.fromisoformat(now),
                                zone=ZoneInfo('America/New_York'))
    assert result.isoformat() == '2026-03-15T02:30:00-04:00'


def test_fall_back_retains_both_legacy_wall_clock_runs_without_double_enqueue():
    zone = ZoneInfo('America/New_York')
    entry = schedule(schedule_time='01:30')
    first = datetime.fromisoformat('2026-11-01T05:30:10+00:00')
    assert schedules.next_run(entry, now=first, zone=zone).isoformat() == '2026-11-01T01:30:00-04:00'
    entry['last_run'] = first.isoformat()
    assert schedules.next_run(entry, now=first, zone=zone).isoformat() == '2026-11-01T01:30:00-05:00'
    second = datetime.fromisoformat('2026-11-01T06:30:10+00:00')
    assert schedules.next_run(entry, now=second, zone=zone).isoformat() == '2026-11-01T01:30:00-05:00'
    entry['last_run'] = second.isoformat()
    assert schedules.next_run(entry, now=second, zone=zone).isoformat() == '2026-11-02T01:30:00-05:00'


def test_naive_legacy_last_run_is_server_local_and_suppresses_current_minute():
    result = schedules.next_run(schedule(last_run='2026-09-05T02:30:05'),
                                now=datetime.fromisoformat('2026-09-05T06:30:10+00:00'),
                                zone=ZoneInfo('America/New_York'))
    assert result.isoformat() == '2026-09-06T02:30:00-04:00'


@pytest.mark.parametrize('overrides', [
    {'schedule_time': '25:00'}, {'schedule_time': '2:30'}, {'schedule_time': None},
    {'days': []}, {'days': 'daily'}, {'days': ['MONDAY']}, {'days': [None]},
])
def test_invalid_legacy_entries_are_visible_but_never_due(overrides):
    entry = schedule(**overrides)
    result = schedules.describe_schedule(entry, zone=ZoneInfo('UTC'))
    assert result['next_run_at'] is None
    assert result['schedule_error']
    assert result['timezone'] == 'UTC'
    assert 'next_run_at' not in entry


@pytest.mark.parametrize('global_enabled,entry_enabled', [(False, True), (True, False)])
def test_disabled_schedules_have_no_countdown(global_enabled, entry_enabled):
    result = schedules.describe_schedule(schedule(enabled=entry_enabled),
                                          globally_enabled=global_enabled, zone=ZoneInfo('UTC'))
    assert result['next_run_at'] is None


def test_invalid_create_or_update_does_not_write_or_mutate_config(monkeypatch):
    config = {'enabled': True, 'schedules': [schedule()]}
    original = deepcopy(config)
    save = Mock()
    monkeypatch.setattr(BackupService, 'get_config', lambda: config)
    monkeypatch.setattr(BackupService, 'save_config', save)
    assert not BackupService.add_schedule('test', 'files', '/srv', '24:01')['success']
    assert not BackupService.add_schedule('test', 'files', '/srv', '02:30', days=[])['success']
    assert not BackupService.update_schedule('nightly', {'schedule_time': '99:99'})['success']
    assert config == original
    save.assert_not_called()


def test_list_and_scheduler_use_same_due_instant_without_persisting_metadata(monkeypatch):
    from app.jobs.service import JobService
    from app.services import backup_service
    zone = ZoneInfo('America/New_York')
    now = datetime.fromisoformat('2026-09-05T06:30:10+00:00')
    clock = Mock()
    clock.now.return_value = now
    monkeypatch.setattr(backup_service, 'datetime', clock)
    monkeypatch.setattr(schedules, 'server_timezone', lambda: zone)
    config = {'enabled': True, 'schedules': [schedule()]}
    monkeypatch.setattr(BackupService, 'get_config', lambda: config)
    monkeypatch.setattr(BackupService, 'save_config', Mock())
    enqueue = Mock()
    monkeypatch.setattr(JobService, 'enqueue', enqueue)
    shown = BackupService.get_schedules()[0]
    assert shown['next_run_at'] == '2026-09-05T02:30:00-04:00'
    BackupService.check_backup_schedules()
    enqueue.assert_called_once()
    assert datetime.fromisoformat(config['schedules'][0]['last_run']).astimezone(timezone.utc) == now
    assert 'next_run_at' not in config['schedules'][0]
    BackupService.check_backup_schedules()
    enqueue.assert_called_once()
    assert BackupService.get_schedules()[0]['next_run_at'] == '2026-09-06T02:30:00-04:00'


def test_empty_schedule_api_still_exposes_server_timezone(client, auth_headers, monkeypatch):
    monkeypatch.setattr(BackupService, 'get_config', lambda: {'enabled': True, 'schedules': []})
    monkeypatch.setattr(schedules, 'server_timezone', lambda: ZoneInfo('Asia/Kolkata'))
    response = client.get('/api/v1/backups/schedules', headers=auth_headers)
    assert response.status_code == 200
    assert response.get_json() == {'schedules': [], 'timezone': 'Asia/Kolkata'}
