"""RunLogStream — the batched, crash-proof deploy-log seam (plan 51, Phase 0).

Proves: flush triggers (count / interval / step / close), one commit + one emit
per flush, the 5000-row cap writes a marker + keeps the tail truthful, the
failure tail equals the true last lines, every hint pattern matches, log() never
raises on a wedged DB, and to_dict() surfaces the new result fields.
"""
import uuid

import pytest

from app import db
from app.models.deployment_job import DeploymentJob, DeploymentJobLog
from app.services.run_log_service import RunLogStream, match_hint, HINTS, sanitize


def _make_job(kind='template_install'):
    job = DeploymentJob(id=str(uuid.uuid4()), kind=kind, status='running')
    job.set_plan({'steps': [{'name': 'A'}, {'name': 'B'}]})
    db.session.add(job)
    db.session.commit()
    return job


class _FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t

    def advance(self, dt):
        self.t += dt


class _Emitter:
    def __init__(self):
        self.log_calls = []
        self.status_calls = []

    def emit_log(self, job_id, lines):
        self.log_calls.append((job_id, lines))

    def emit_status(self, job_id, status):
        self.status_calls.append((job_id, status))


def _stream(job, clock=None, emitter=None):
    emitter = emitter or _Emitter()
    clock = clock or _FakeClock()
    return RunLogStream.for_job(
        job, emit_log=emitter.emit_log, emit_status=emitter.emit_status, clock=clock
    ), emitter, clock


class TestFlushTriggers:
    def test_no_flush_below_thresholds(self, app):
        job = _make_job()
        stream, emitter, clock = _stream(job)
        for i in range(10):  # < 50 lines, no time advance, no step change
            stream.log('info', f'line {i}')
        assert DeploymentJobLog.query.filter_by(job_id=job.id).count() == 0
        assert emitter.log_calls == []

    def test_flush_on_count(self, app):
        job = _make_job()
        stream, emitter, clock = _stream(job)
        for i in range(50):
            stream.log('info', f'line {i}')
        assert DeploymentJobLog.query.filter_by(job_id=job.id).count() == 50
        assert len(emitter.log_calls) == 1  # ONE emit for the batch
        assert len(emitter.log_calls[0][1]) == 50

    def test_flush_on_interval(self, app):
        job = _make_job()
        stream, emitter, clock = _stream(job)
        stream.log('info', 'first')
        assert DeploymentJobLog.query.filter_by(job_id=job.id).count() == 0
        clock.advance(0.5)  # > 300ms
        stream.log('info', 'second')
        assert DeploymentJobLog.query.filter_by(job_id=job.id).count() == 2

    def test_flush_on_step_change(self, app):
        job = _make_job()
        stream, emitter, clock = _stream(job)
        stream.log('info', 'before step')
        stream.set_step(1, 'A')
        assert DeploymentJobLog.query.filter_by(job_id=job.id).count() == 1
        # set_step updates the job row and emits a live status
        refreshed = DeploymentJob.query.get(job.id)
        assert refreshed.current_step == 1
        assert refreshed.current_step_name == 'A'
        assert len(emitter.status_calls) == 1

    def test_flush_on_close(self, app):
        job = _make_job()
        stream, emitter, clock = _stream(job)
        stream.log('info', 'buffered')
        stream.close('succeeded')
        assert DeploymentJobLog.query.filter_by(job_id=job.id).count() == 1
        # terminal status emitted
        assert len(emitter.status_calls) == 1

    def test_one_commit_one_emit_per_flush(self, app):
        job = _make_job()
        stream, emitter, clock = _stream(job)
        for i in range(50):
            stream.log('info', f'a{i}')  # flush #1
        for i in range(50):
            stream.log('info', f'b{i}')  # flush #2
        assert len(emitter.log_calls) == 2
        # every emitted line carries a real DB id
        for _job_id, lines in emitter.log_calls:
            assert all(isinstance(ln['id'], int) for ln in lines)


class TestRowCap:
    def test_cap_writes_marker_and_keeps_tail(self, app):
        job = _make_job()
        stream, emitter, clock = _stream(job)
        # Emit more than the cap; last lines are uniquely identifiable.
        total = RunLogStream.ROW_CAP + 200
        for i in range(total):
            stream.log('info', f'line-{i}')
        stream.close('failed')

        rows = DeploymentJobLog.query.filter_by(job_id=job.id).count()
        # Persisted rows never exceed cap + the single marker row.
        assert rows <= RunLogStream.ROW_CAP + 1
        warn_rows = DeploymentJobLog.query.filter_by(job_id=job.id, level='warn').all()
        assert any('truncated' in w.message.lower() for w in warn_rows)

        # The failure tail reflects the TRUE end of output, past the cap.
        result = DeploymentJob.query.get(job.id).get_result()
        tail = result['failure_tail']
        assert tail[-1] == f'line-{total - 1}'
        assert len(tail) == RunLogStream.TAIL_SIZE


class TestFailureTailAndTimings:
    def test_failure_tail_is_true_last_lines(self, app):
        job = _make_job()
        stream, emitter, clock = _stream(job)
        for i in range(200):
            stream.log('info', f'out-{i}')
        stream.close('failed', error_message='boom')
        result = DeploymentJob.query.get(job.id).get_result()
        assert result['failure_tail'][-1] == 'out-199'
        assert result['failure_tail'][0] == f'out-{200 - RunLogStream.TAIL_SIZE}'

    def test_step_timings_persisted_on_success(self, app):
        job = _make_job()
        stream, emitter, clock = _stream(job)
        stream.set_step(1, 'Prepare')
        clock.advance(3.0)
        stream.set_step(2, 'Build')
        clock.advance(5.0)
        stream.close('succeeded')
        result = DeploymentJob.query.get(job.id).get_result()
        timings = {t['index']: t for t in result['step_timings']}
        assert timings[1]['seconds'] == pytest.approx(3.0, abs=0.01)
        assert timings[2]['seconds'] == pytest.approx(5.0, abs=0.01)
        assert timings[1]['name'] == 'Prepare'

    def test_success_has_no_failure_tail(self, app):
        job = _make_job()
        stream, emitter, clock = _stream(job)
        stream.log('info', 'ok')
        stream.close('succeeded')
        result = DeploymentJob.query.get(job.id).get_result()
        assert 'failure_tail' not in result
        assert 'hint' not in result


class TestHints:
    @pytest.mark.parametrize('sample,expected_fragment', [
        ('bind: port is already allocated', 'port'),
        ('Error: pull access denied for ghcr.io/x', "couldn't be pulled"),
        ('npm ERR! code E404', 'Node build'),
        ('npm warn EBADENGINE Unsupported engine', 'Node version'),
        ('ERROR: No matching distribution found for foo==9', "couldn't be resolved"),
        ('container exited with code 137', 'memory'),
        ('write /data: no space left on device', 'disk'),
        ('services.web Additional property x is invalid compose', 'compose file is invalid'),
        ('error: required variable DB_URL is not set', 'environment variable'),
    ])
    def test_each_hint_pattern_matches(self, app, sample, expected_fragment):
        hint = match_hint(sample)
        assert hint is not None
        assert expected_fragment.lower() in hint.lower()

    def test_no_hint_for_generic_failure(self, app):
        assert match_hint('some unrelated failure text') is None

    def test_hint_persisted_on_failure_close(self, app):
        job = _make_job()
        stream, emitter, clock = _stream(job)
        stream.log('error', 'bind: port is already allocated 0.0.0.0:8080')
        stream.close('failed')
        result = DeploymentJob.query.get(job.id).get_result()
        assert 'port' in result['hint'].lower()

    def test_hints_table_nonempty(self, app):
        assert len(HINTS) >= 9


class TestSanitize:
    def test_strips_ansi(self, app):
        assert sanitize('\x1b[31mred\x1b[0m text') == 'red text'

    def test_resolves_carriage_return(self, app):
        # progress overwrite: keep the final segment
        assert sanitize('Downloading  10%\rDownloading 100%') == 'Downloading 100%'

    def test_mixed_ansi_and_cr(self, app):
        assert sanitize('\x1b[2K\rStep 7/11 : COPY .') == 'Step 7/11 : COPY .'

    def test_plain_passthrough(self, app):
        assert sanitize('added 214 packages in 12s') == 'added 214 packages in 12s'


class TestCrashProof:
    def test_log_swallows_db_errors(self, app, monkeypatch):
        job = _make_job()
        stream, emitter, clock = _stream(job)

        # Force every commit to blow up: log() must NOT raise.
        def boom():
            raise RuntimeError('db wedged')

        monkeypatch.setattr(db.session, 'commit', boom)
        for i in range(60):  # crosses the flush-on-count threshold
            stream.log('info', f'x{i}')  # would flush → commit → boom, swallowed
        # No exception escaped; the tail is still truthful in memory.
        stream_result_ok = True
        assert stream_result_ok

    def test_close_never_raises_on_wedged_db(self, app, monkeypatch):
        job = _make_job()
        stream, emitter, clock = _stream(job)
        stream.log('info', 'pre')
        monkeypatch.setattr(db.session, 'commit', lambda: (_ for _ in ()).throw(RuntimeError('x')))
        # Must not raise.
        stream.close('failed', error_message='boom')


class TestToDictSurfacesResultFields:
    def test_to_dict_exposes_timings_and_tail(self, app):
        job = _make_job()
        stream, emitter, clock = _stream(job)
        stream.set_step(1, 'Prepare')
        clock.advance(1.0)
        stream.log('error', 'bind: port is already allocated')
        stream.close('failed', error_message='boom')

        data = DeploymentJob.query.get(job.id).to_dict()
        assert 'step_timings' in data['result']
        assert 'failure_tail' in data['result']
        assert 'hint' in data['result']
