"""Per-IP login brute-force throttle (in-memory, single-worker safe).

Complements — does not replace — the per-*user* account lockout in
``User.record_failed_login``. Per-user lockout stops targeted guessing at one
account; this per-IP throttle stops password *spraying* across many accounts
from one source, and closes the shared-bucket gap that let a single attacker
drain everyone's login budget.

State is process-local: after Phase 1 the app trusts the real client IP, and the
panel runs a **single** gunicorn worker (mandated by the in-memory agent
registry — see root ``CLAUDE.md``), so a plain in-process TTL map needs no shared
store. It is guarded by a lock because the shipped worker is threaded.

Thresholds are read from Flask config at call time so they can be tuned via env
(``AUTH_IP_MAX_ATTEMPTS`` / ``AUTH_IP_WINDOW_MINUTES`` / ``AUTH_IP_BLOCK_MINUTES``)
and overridden in tests.
"""
import math
import threading
import time

from flask import current_app

# ip -> list[failure_epoch_seconds] (only failures inside the window are kept)
_attempts = {}
# ip -> block_until_epoch_seconds
_blocks = {}
_lock = threading.Lock()
_last_sweep = 0.0

# Fallbacks used only outside an app context (config is the real source).
_DEFAULT_MAX_ATTEMPTS = 10
_DEFAULT_WINDOW_MINUTES = 15
_DEFAULT_BLOCK_MINUTES = 15


def _cfg(key, default):
    try:
        return current_app.config.get(key, default)
    except RuntimeError:  # no application context
        return default


def _max_attempts():
    return int(_cfg('AUTH_IP_MAX_ATTEMPTS', _DEFAULT_MAX_ATTEMPTS))


def _window_seconds():
    return int(_cfg('AUTH_IP_WINDOW_MINUTES', _DEFAULT_WINDOW_MINUTES)) * 60


def _block_seconds():
    return int(_cfg('AUTH_IP_BLOCK_MINUTES', _DEFAULT_BLOCK_MINUTES)) * 60


def _sweep(now, window):
    """Drop aged-out attempt lists and expired blocks so the maps can't grow
    without bound from one-off IPs. Caller must hold the lock."""
    global _last_sweep
    if now - _last_sweep <= window:
        return
    for ip in list(_attempts.keys()):
        fresh = [t for t in _attempts[ip] if now - t < window]
        if fresh:
            _attempts[ip] = fresh
        else:
            del _attempts[ip]
    for ip in list(_blocks.keys()):
        if _blocks[ip] <= now:
            del _blocks[ip]
    _last_sweep = now


def is_blocked(ip):
    """Return ``(blocked, retry_after_seconds)`` for ``ip``.

    Does NOT record an attempt — call this up front, before checking the
    password, and reject with 429 + ``Retry-After`` when blocked.
    """
    if not ip:
        return False, 0
    now = time.time()
    with _lock:
        until = _blocks.get(ip)
        if until is None:
            return False, 0
        if until <= now:
            _blocks.pop(ip, None)
            return False, 0
        return True, int(math.ceil(until - now))


def register_failure(ip):
    """Record one failed auth from ``ip``. Once failures within the rolling
    window reach ``AUTH_IP_MAX_ATTEMPTS`` the IP is blocked for
    ``AUTH_IP_BLOCK_MINUTES``. Returns ``(blocked_now, retry_after_seconds)``."""
    if not ip:
        return False, 0
    now = time.time()
    window = _window_seconds()
    with _lock:
        _sweep(now, window)
        recent = [t for t in _attempts.get(ip, []) if now - t < window]
        recent.append(now)
        _attempts[ip] = recent
        if len(recent) >= _max_attempts():
            until = now + _block_seconds()
            _blocks[ip] = until
            # Window's failures have done their job; reset so the count starts
            # fresh after the block lifts instead of instantly re-blocking.
            _attempts.pop(ip, None)
            return True, int(math.ceil(until - now))
        return False, 0


def reset(ip):
    """Clear an IP's failure count and any block — call on a successful auth."""
    if not ip:
        return
    with _lock:
        _attempts.pop(ip, None)
        _blocks.pop(ip, None)


def reset_all():
    """Wipe all throttle state. For tests and clean shutdowns."""
    global _last_sweep
    with _lock:
        _attempts.clear()
        _blocks.clear()
        _last_sweep = 0.0
