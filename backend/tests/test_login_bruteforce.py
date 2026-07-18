"""Proving tests for the per-IP login brute-force throttle (plan 48, Phase 2).

The per-IP throttle (app/services/auth_throttle_service.py) complements the
existing per-user account lockout: it blocks an IP after AUTH_IP_MAX_ATTEMPTS
failed auths, *before* the password is checked, so spraying wrong passwords
across many usernames from one source is stopped and a single attacker can't
silently drain the shared login rate-limit bucket.

Notes:
- These build a trust-ON app so the real client IP is driven via the rightmost
  X-Forwarded-For hop (Phase 1), letting one test exercise several distinct
  clients and prove a forged leftmost value can't dodge the block.
- Thresholds are lowered via config so the throttle trips well within
  flask-limiter's own 5/min on /login. Every test keeps each IP at <=5 requests
  for the same reason, and uses TEST-NET-2 (198.51.100.x) addresses distinct
  from other suites to avoid cross-test limiter contamination.
"""
import pytest
from datetime import datetime, timedelta

from app import create_app, db
from app.services import auth_throttle_service


@pytest.fixture(autouse=True)
def _reset_throttle():
    auth_throttle_service.reset_all()
    yield
    auth_throttle_service.reset_all()


@pytest.fixture
def make_app(monkeypatch):
    """Factory: build a trust-ON testing app with a tunable per-IP threshold.

    Monkeypatching the class attribute before create_app drives the real config
    (from_object reads it at create time). Cleans up DB + app context after.
    """
    created = []

    def _make(max_attempts=3, hops=1):
        from config import TestingConfig
        monkeypatch.setattr(TestingConfig, 'TRUST_PROXY_HEADERS', True)
        monkeypatch.setattr(TestingConfig, 'TRUSTED_PROXY_HOPS', hops)
        monkeypatch.setattr(TestingConfig, 'AUTH_IP_MAX_ATTEMPTS', max_attempts)
        app = create_app('testing')
        ctx = app.app_context()
        ctx.push()
        db.create_all()
        created.append(ctx)
        return app

    yield _make

    for ctx in created:
        db.session.remove()
        db.drop_all()
        ctx.pop()


def _mk_user(username='victim', password='correct-horse-battery'):
    from app.models import User
    u = User(email=f'{username}@t.local', username=username,
             role=User.ROLE_ADMIN, is_active=True)
    u.set_password(password)
    db.session.add(u)
    db.session.commit()
    return u


def _login(client, password, peer, leftmost='9.9.9.9'):
    return client.post(
        '/api/v1/auth/login',
        json={'email': 'victim@t.local', 'password': password},
        headers={'X-Forwarded-For': f'{leftmost}, {peer}'},
    )


THROTTLE_MSG = 'Too many failed login attempts. Try again later.'


def test_ip_blocked_after_max_failures_before_password_check(make_app):
    app = make_app(max_attempts=3)
    _mk_user(password='rightpass')
    client = app.test_client()
    peer = '198.51.100.10'

    # Three wrong-password failures from one IP arm the block.
    for _ in range(3):
        assert _login(client, 'wrong', peer).status_code == 401

    # The next attempt is rejected with 429 + Retry-After even with the CORRECT
    # password — proving the IP block precedes the password check.
    r = _login(client, 'rightpass', peer)
    assert r.status_code == 429
    assert r.get_json()['error'] == THROTTLE_MSG
    assert int(r.headers.get('Retry-After', '0')) > 0

    # A different real client IP is unaffected (still reaches the password check).
    r2 = _login(client, 'wrong', '198.51.100.99')
    assert r2.status_code == 401


def test_forged_leftmost_xff_cannot_dodge_the_block(make_app):
    """Regression tie-in to Phase 1: rotating the client-controlled leftmost
    X-Forwarded-For value can neither spread the failures across buckets nor
    escape the block, because the trusted IP is the rightmost proxy hop."""
    app = make_app(max_attempts=3)
    _mk_user(password='rightpass')
    client = app.test_client()
    peer = '198.51.100.20'

    # Each failure forges a DIFFERENT leftmost value, but the real peer is one.
    for i in range(3):
        assert _login(client, 'wrong', peer, leftmost=f'{i}.{i}.{i}.{i}').status_code == 401

    # A brand-new forged prefix + the correct password is still blocked.
    r = _login(client, 'rightpass', peer, leftmost='250.250.250.250')
    assert r.status_code == 429
    assert r.get_json()['error'] == THROTTLE_MSG


def test_per_user_lockout_still_enforced_at_endpoint(make_app):
    """The pre-existing per-user lockout must still fire (defense in depth).
    Per-IP is set high here so it can't mask the per-user path."""
    app = make_app(max_attempts=100)
    u = _mk_user(password='rightpass')
    u.locked_until = datetime.utcnow() + timedelta(minutes=5)
    db.session.commit()

    client = app.test_client()
    r = _login(client, 'rightpass', '198.51.100.30')
    assert r.status_code == 429
    assert 'locked' in r.get_json()['error'].lower()


def test_record_failed_login_locks_user_after_max(make_app):
    """Model-level: the per-user lockout mechanism itself is untouched."""
    make_app(max_attempts=100)
    from app.models import User
    u = _mk_user()
    for _ in range(User.MAX_FAILED_ATTEMPTS):
        u.record_failed_login()
    assert u.is_locked is True


def test_successful_login_clears_ip_failure_count(make_app):
    app = make_app(max_attempts=2)
    _mk_user(password='rightpass')
    client = app.test_client()
    peer = '198.51.100.40'

    assert _login(client, 'wrong', peer).status_code == 401       # count = 1
    assert _login(client, 'rightpass', peer).status_code == 200   # success -> reset
    # Fresh window after the reset: it takes a NEW max failures to re-arm.
    assert _login(client, 'wrong', peer).status_code == 401       # count = 1
    r4 = _login(client, 'wrong', peer)                            # count = 2 -> arms
    assert r4.status_code == 401                                   # not blocked yet
    r5 = _login(client, 'wrong', peer)                            # now blocked
    assert r5.status_code == 429
    assert r5.get_json()['error'] == THROTTLE_MSG


def test_different_ip_not_blocked_by_another_ips_failures(make_app):
    app = make_app(max_attempts=2)
    _mk_user(password='rightpass')
    client = app.test_client()

    # Arm the block for peer A.
    assert _login(client, 'wrong', '198.51.100.50').status_code == 401
    assert _login(client, 'wrong', '198.51.100.50').status_code == 401
    assert _login(client, 'wrong', '198.51.100.50').status_code == 429

    # Peer B, sharing the same forged leftmost, is a clean bucket.
    assert _login(client, 'wrong', '198.51.100.51').status_code == 401
