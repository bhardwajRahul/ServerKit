#!/usr/bin/env python3
"""Measure real GET requests; use only against an authorized local/staging panel.

JSON schema version 1: endpoints contain warmup and samples arrays plus summary.
Every attempt records elapsed_ms, status, response_bytes, app_ms, sql_ms,
sql_queries and error (null on success). Missing Server-Timing data stays null.
Summary distributions contain count/min/p50/p95/max, with linearly interpolated
percentiles. Summaries exclude warmup; request_count includes all attempts.
Body contents, credentials and query values are never included in reports.
"""

import argparse
from datetime import datetime, timezone
import ipaddress
from http.client import HTTPException
import json
import math
import os
from pathlib import Path
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def distribution(values):
    present = [value for value in values if value is not None]
    return {
        'count': len(present), 'min': min(present) if present else None,
        'p50': percentile(present, .5), 'p95': percentile(present, .95),
        'max': max(present) if present else None,
    }


def redact_path(path):
    parsed = urlsplit(path)
    query = urlencode([(key, '[redacted]') for key, _ in parse_qsl(parsed.query, keep_blank_values=True)])
    return urlunsplit(('', '', parsed.path, query, ''))


def validate_target(base_url, paths, authenticated):
    base = urlsplit(base_url)
    if (base.scheme not in ('http', 'https') or not base.hostname or base.username is not None
            or base.password is not None or base.query or base.fragment):
        raise ValueError('base-url must be an HTTP(S) URL without credentials, query or fragment')
    try:
        base.port
    except ValueError:
        raise ValueError('base-url has an invalid port') from None
    loopback = base.hostname.lower() == 'localhost'
    try:
        loopback = loopback or ipaddress.ip_address(base.hostname).is_loopback
    except ValueError:
        pass
    if authenticated and base.scheme == 'http' and not loopback:
        raise ValueError('credentials require HTTPS except for a loopback host')
    if any(ord(char) < 32 for char in base_url):
        raise ValueError('base-url contains control characters')
    for path in paths:
        parsed = urlsplit(path)
        decoded = unquote(parsed.path)
        if (parsed.scheme or parsed.netloc or parsed.fragment or not decoded.startswith('/api/')
                or '\\' in decoded or any(part in ('.', '..') for part in decoded.split('/'))
                or any(ord(char) < 32 for char in path + decoded)):
            raise ValueError('each path must be a relative /api/ URL without traversal or fragments')
    return base_url.rstrip('/')


def parse_server_timing(header):
    result = {'app_ms': None, 'sql_ms': None, 'sql_queries': None}
    # The panel emits unquoted numeric durations and a quoted query count.
    # Ignore unrelated metrics or malformed values without inventing zeros.
    for match in re.finditer(r'(?:^|,)\s*(app|db)\s*((?:;[^,]*)?)', header or ''):
        name, params = match.groups()
        duration = re.search(r'(?:^|;)\s*dur\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*(?:;|$)', params)
        if duration:
            value = float(duration.group(1))
            if math.isfinite(value):
                result['app_ms' if name == 'app' else 'sql_ms'] = value
        if name == 'db':
            queries = re.search(r'(?:^|;)\s*desc\s*=\s*"([0-9]+) queries"', params)
            if queries:
                result['sql_queries'] = int(queries.group(1))
    return result


def sample_get(opener, url, headers, timeout):
    started = time.perf_counter()
    sample = {'elapsed_ms': None, 'status': None, 'response_bytes': None,
              'app_ms': None, 'sql_ms': None, 'sql_queries': None, 'error': None}
    response = None
    try:
        try:
            response = opener.open(Request(url, headers=headers, method='GET'), timeout=timeout)
        except HTTPError as exc:
            response = exc
        sample['status'] = response.status
        sample.update(parse_server_timing(', '.join(response.headers.get_all('Server-Timing', []))))
        if 300 <= response.status < 400:
            sample['error'] = 'redirect_refused'
        elif not 200 <= response.status < 300:
            sample['error'] = 'http_error'
        size = 0
        while True:
            chunk = response.read(65536)
            if not chunk:
                break
            size += len(chunk)
        sample['response_bytes'] = size
    except (OSError, URLError, ValueError, HTTPException) as exc:
        # Exception messages may contain the URL/query or proxy credentials.
        sample['error'] = f'transport_error:{type(exc).__name__}'
    finally:
        if response is not None:
            response.close()
        sample['elapsed_ms'] = (time.perf_counter() - started) * 1000
    return sample


def summarize(samples):
    statuses = {}
    for sample in samples:
        key = str(sample['status']) if sample['status'] is not None else 'unavailable'
        statuses[key] = statuses.get(key, 0) + 1
    return {
        'request_count': len(samples), 'failed_count': sum(bool(sample['error']) for sample in samples),
        'statuses': statuses,
        **{field: distribution([sample[field] for sample in samples])
           for field in ('elapsed_ms', 'response_bytes', 'app_ms', 'sql_ms', 'sql_queries')},
    }


def profile(base_url, paths, *, samples=5, warmup=1, timeout=30, headers=None):
    headers = headers or {}
    base_url = validate_target(base_url, paths, bool(headers))
    # Direct requests avoid implicit proxy authentication/routing from the shell.
    opener = build_opener(ProxyHandler({}), NoRedirects())
    report = {'schema_version': 1, 'generated_at': datetime.now(timezone.utc).isoformat(),
              'base_url': base_url, 'method': 'GET', 'request_count': 0,
              'failed_count': 0, 'endpoints': []}
    for path in paths:
        endpoint = {'path': redact_path(path), 'warmup': [], 'samples': []}
        for phase, count in (('warmup', warmup), ('samples', samples)):
            for _ in range(count):
                sample = sample_get(opener, base_url + path, headers, timeout)
                endpoint[phase].append(sample)
                report['request_count'] += 1
                report['failed_count'] += bool(sample['error'])
        endpoint['summary'] = summarize(endpoint['samples'])
        report['endpoints'].append(endpoint)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--base-url', default='http://127.0.0.1:47927')
    parser.add_argument('--path', action='append', help='repeatable relative /api/ URL; default /api/v1/system/health')
    parser.add_argument('--samples', type=int, default=5)
    parser.add_argument('--warmup', type=int, default=1)
    parser.add_argument('--timeout', type=float, default=30, help='request timeout in seconds (default 30)')
    parser.add_argument('--output', type=Path, help='write JSON to this file instead of stdout')
    parser.epilog = ('Optional authentication: SERVERKIT_PROFILE_TOKEN or SERVERKIT_PROFILE_API_KEY environment '
                     'variable (mutually exclusive). Redirects are refused; credentials require HTTPS except '
                     'on loopback. Exit 1 means one or more attempts failed, including warmup.')
    args = parser.parse_args(argv)
    if args.samples < 1 or args.warmup < 0 or not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error('samples must be positive, warmup nonnegative, and timeout finite and positive')
    token = os.environ.get('SERVERKIT_PROFILE_TOKEN')
    api_key = os.environ.get('SERVERKIT_PROFILE_API_KEY')
    if token and api_key:
        parser.error('set only one of SERVERKIT_PROFILE_TOKEN and SERVERKIT_PROFILE_API_KEY')
    headers = {'Authorization': f'Bearer {token}'} if token else {'X-API-Key': api_key} if api_key else {}
    if any('\r' in value or '\n' in value for value in headers.values()):
        parser.error('authentication value contains a newline')
    try:
        report = profile(args.base_url, args.path or ['/api/v1/system/health'], samples=args.samples,
                         warmup=args.warmup, timeout=args.timeout, headers=headers)
    except ValueError as exc:
        parser.error(str(exc))
    output = json.dumps(report, indent=2, allow_nan=False) + '\n'
    if args.output:
        args.output.write_text(output, encoding='utf-8')
    else:
        print(output, end='')
    return 1 if report['failed_count'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
