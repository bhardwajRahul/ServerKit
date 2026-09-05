"""Stdlib-only tests: python -m unittest discover -s scripts/test -p test_profile_api.py."""

from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import threading
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('profile_api', Path(__file__).parents[1] / 'profile-api.py')
profile_api = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(profile_api)


class MetricsTests(unittest.TestCase):
    def test_percentiles_and_absent_metrics(self):
        self.assertEqual(profile_api.percentile([30, 10, 20], .5), 20)
        self.assertEqual(profile_api.percentile([10, 20, 30], .95), 29)
        self.assertEqual(profile_api.percentile([10], .95), 10)
        self.assertEqual(profile_api.distribution([None, None]),
                         {'count': 0, 'min': None, 'p50': None, 'p95': None, 'max': None})

    def test_header_and_missing_header(self):
        self.assertEqual(profile_api.parse_server_timing('app;dur=12.50, db;dur=2.100;desc="4 queries"'),
                         {'app_ms': 12.5, 'sql_ms': 2.1, 'sql_queries': 4})
        self.assertEqual(profile_api.parse_server_timing(None),
                         {'app_ms': None, 'sql_ms': None, 'sql_queries': None})
        self.assertEqual(profile_api.parse_server_timing('app;dur=nan, db;dur=-1'),
                         {'app_ms': None, 'sql_ms': None, 'sql_queries': None})

    def test_query_values_redacted_including_repeated_and_empty(self):
        redacted = profile_api.redact_path('/api/v1/find?search=secret+text&search=password&empty=&flag')
        self.assertEqual(redacted, '/api/v1/find?search=%5Bredacted%5D&search=%5Bredacted%5D&empty=%5Bredacted%5D&flag=%5Bredacted%5D')

    def test_targets_reject_auth_leaks_and_non_api_paths(self):
        for base in ['http://example.com', 'https://user:secret@example.com',
                     'https://example.com?secret=key', 'ftp://localhost']:
            with self.subTest(base=base), self.assertRaises(ValueError):
                profile_api.validate_target(base, ['/api/v1/health'], True)
        for path in ['https://other.test/api/v1', '//other.test/api/v1', '/api/../admin',
                     '/api/%2e%2e/admin', '/admin', '/api/v1#secret', '/api/%0dheader']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                profile_api.validate_target('https://example.com', [path], False)
        for base in ['http://localhost:1234', 'http://127.0.0.1:1234', 'http://[::1]:1234', 'https://example.com']:
            self.assertEqual(profile_api.validate_target(base, ['/api/v1/health'], True), base)


class LocalHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                cls.requests.append((self.path, self.headers.get('Authorization'), self.headers.get('X-API-Key')))
                if self.path.startswith('/api/redirect'):
                    self.send_response(302)
                    self.send_header('Location', '/api/secret-destination')
                elif self.path.startswith('/api/fail'):
                    self.send_response(503)
                else:
                    self.send_response(200)
                if self.path.startswith('/api/profiled'):
                    self.send_header('Server-Timing', 'app;dur=12.5, db;dur=2.5;desc="3 queries"')
                self.end_headers()
                self.wfile.write(b'private response body')

            def log_message(self, *args):
                pass

        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def setUp(self):
        self.requests.clear()

    def test_real_samples_warmup_bytes_headers_and_redaction(self):
        result = profile_api.profile(self.base, ['/api/profiled?search=hidden-query'],
                                     samples=3, warmup=1, headers={'Authorization': 'Bearer hidden-token'})
        endpoint = result['endpoints'][0]
        self.assertEqual(result['request_count'], 4)
        self.assertEqual(endpoint['summary']['request_count'], 3)
        self.assertEqual(endpoint['summary']['statuses'], {'200': 3})
        self.assertEqual(endpoint['summary']['response_bytes']['min'], len(b'private response body'))
        self.assertEqual(endpoint['summary']['sql_queries']['p95'], 3)
        self.assertGreater(endpoint['summary']['elapsed_ms']['min'], 0)
        self.assertEqual(self.requests[0], ('/api/profiled?search=hidden-query', 'Bearer hidden-token', None))
        serialized = json.dumps(result)
        for secret in ['hidden-query', 'hidden-token', 'private response body']:
            self.assertNotIn(secret, serialized)

    def test_missing_header_stays_null(self):
        report = profile_api.profile(self.base, ['/api/plain'], samples=1, warmup=0)
        endpoint = report['endpoints'][0]
        self.assertIsNone(endpoint['samples'][0]['sql_queries'])
        self.assertIsNone(endpoint['summary']['app_ms']['p50'])

    def test_http_failure_and_redirect_are_reported_without_following(self):
        report = profile_api.profile(self.base, ['/api/redirect', '/api/fail'], samples=1, warmup=0,
                                     headers={'X-API-Key': 'secret-key'})
        self.assertEqual(report['failed_count'], 2)
        self.assertEqual([entry['samples'][0]['error'] for entry in report['endpoints']],
                         ['redirect_refused', 'http_error'])
        self.assertEqual([path for path, _, _ in self.requests], ['/api/redirect', '/api/fail'])
        self.assertNotIn('secret-key', json.dumps(report))

    def test_cli_failure_exit_and_mutually_exclusive_credentials(self):
        output = io.StringIO()
        with patch.dict(os.environ, {}, clear=True), redirect_stdout(output):
            code = profile_api.main(['--base-url', self.base, '--path', '/api/fail', '--samples', '1', '--warmup', '0'])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output.getvalue())['failed_count'], 1)
        with patch.dict(os.environ, {'SERVERKIT_PROFILE_TOKEN': 'one', 'SERVERKIT_PROFILE_API_KEY': 'two'}):
            with patch('sys.stderr', io.StringIO()), self.assertRaises(SystemExit) as failure:
                profile_api.main([])
        self.assertEqual(failure.exception.code, 2)

    def test_transport_error_does_not_echo_exception_url(self):
        opener = profile_api.build_opener()
        with patch.object(opener, 'open', side_effect=profile_api.URLError('https://host?token=secret')):
            sample = profile_api.sample_get(opener, self.base + '/api/test?token=secret', {}, 1)
        self.assertEqual(sample['error'], 'transport_error:URLError')
        self.assertIsNone(sample['status'])
        self.assertIsNone(sample['response_bytes'])
        self.assertNotIn('secret', json.dumps(sample))


if __name__ == '__main__':
    unittest.main()
