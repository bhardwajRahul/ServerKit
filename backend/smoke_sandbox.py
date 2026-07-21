"""Manual smoke test for the Test Sandbox service (quick mode, one distro).

Runs the real service against the dev app + local Docker Desktop.
Usage: python smoke_sandbox.py [distro] [mode]
"""
import sys
import time

from app import create_app, db
from app.models.sandbox_run import SandboxRun
from app.services.test_sandbox_service import TestSandboxService

distro = sys.argv[1] if len(sys.argv) > 1 else 'ubuntu22'
mode = sys.argv[2] if len(sys.argv) > 2 else 'quick'
distros = distro.split(',')

app = create_app('development')
with app.app_context():
    print('docker_available:', TestSandboxService.docker_available())
    print('distros:', [d['key'] for d in TestSandboxService.list_distros()])
    run = TestSandboxService.start_run(distros, mode)
    print('started run', run.id)

    deadline = time.time() + (1500 if mode == 'full' else 900)
    while time.time() < deadline:
        time.sleep(10)
        db.session.expire_all()
        run = SandboxRun.query.get(run.id)
        print(f'[{run.status}]', {k: v['status'] for k, v in (run.results or {}).items()})
        if run.status != 'running':
            break

    print('final:', run.to_dict())
    log = TestSandboxService.get_log(run.id, distros[0]) or ''
    print('--- log tail ---')
    print('\n'.join(log.splitlines()[-30:]))
    sys.exit(0 if all(v['status'] == 'passed' for v in (run.results or {}).values()) else 1)
