#!/usr/bin/env python3
"""Reproduce source counts without importing the app or opening its database.

Route declarations are source inventory, not live registered endpoint counts.
Use --collect-tests with the backend Python environment for a clean-checkout
pytest collection count. Collection does not mean the tests have passed.
"""

import argparse
import ast
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def source_counts(files):
    routes = 0
    blueprints = 0
    methods = 0
    dynamic_methods = 0
    for source in files:
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                name = getattr(node.func, 'id', None) or getattr(node.func, 'attr', None)
                if name == 'Blueprint':
                    blueprints += 1
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for decorator in node.decorator_list:
                if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
                    continue
                name = decorator.func.attr
                if name not in ('route', 'get', 'post', 'put', 'patch', 'delete'):
                    continue
                routes += 1
                if name != 'route':
                    methods += 1
                    continue
                keyword = next((kw for kw in decorator.keywords if kw.arg == 'methods'), None)
                try:
                    values = ast.literal_eval(keyword.value) if keyword else ['GET']
                    if not isinstance(values, (list, tuple, set)) or not all(isinstance(v, str) for v in values):
                        raise ValueError('nonliteral methods')
                    methods += len(set(values) - {'HEAD', 'OPTIONS'})
                except (ValueError, TypeError):
                    dynamic_methods += 1
    return {
        'core_route_declarations': routes,
        'core_blueprint_declarations': blueprints,
        'explicit_method_route_pairs_excluding_head_options': methods,
        'route_declarations_with_dynamic_methods': dynamic_methods,
    }


def collect_tests():
    spec = importlib.util.spec_from_file_location('count_tests', ROOT / 'backend/tests/check_test_count.py')
    collector = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(collector)
    # conftest normally sweeps shared temp databases. A private URL avoids
    # touching another developer/test process's scratch database during census.
    with tempfile.TemporaryDirectory(prefix='serverkit-census-') as directory:
        before = os.environ.get('TEST_DATABASE_URL')
        os.environ['TEST_DATABASE_URL'] = 'sqlite:///' + (Path(directory) / 'tests.db').as_posix()
        try:
            return collector.collect_count()
        finally:
            if before is None:
                os.environ.pop('TEST_DATABASE_URL', None)
            else:
                os.environ['TEST_DATABASE_URL'] = before


def measure(include_tests=False):
    tracked = subprocess.check_output(
        ['git', 'ls-files', '-z'], cwd=ROOT, stderr=subprocess.DEVNULL,
    ).decode('utf-8').split('\0')
    api_paths = sorted(p for p in tracked if p.startswith('backend/app/api/') and p.endswith('.py'))
    templates = sorted(p for p in tracked if Path(p).parent.as_posix() == 'backend/templates'
                       and Path(p).suffix in ('.yaml', '.yml'))
    fingerprint = hashlib.sha256()
    for path in api_paths + templates:
        fingerprint.update(path.encode('utf-8') + b'\0' + (ROOT / path).read_bytes() + b'\0')
    return {
        'schema_version': 1,
        'measured_at_utc': datetime.now(timezone.utc).isoformat(),
        'source_revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'measured_source_has_uncommitted_changes': subprocess.run(
            ['git', 'diff', '--quiet', 'HEAD', '--', 'backend/app/api', 'backend/templates'],
            cwd=ROOT, check=False,
        ).returncode != 0,
        'measured_source_sha256': fingerprint.hexdigest(),
        'scope': 'Git-tracked core API Python declarations and root-level bundled app YAML templates; excludes extensions, dependencies and generated/install copies.',
        'python_version': platform.python_version(),
        'platform': platform.system(),
        **source_counts([(ROOT / path).read_text(encoding='utf-8-sig') for path in api_paths]),
        'core_api_source_files': len(api_paths),
        'bundled_app_templates': len(templates),
        'backend_tests_clean_collected': collect_tests() if include_tests else None,
        'collection_scope': 'backend/tests, SERVERKIT_CLEAN_COLLECT=1; collected cases, not passed tests',
        'runtime_memory_bytes': None,
        'container_image_bytes': None,
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--collect-tests', action='store_true')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    report = json.dumps(measure(args.collect_tests), indent=2) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(report, encoding='utf-8')
    else:
        print(report, end='')
