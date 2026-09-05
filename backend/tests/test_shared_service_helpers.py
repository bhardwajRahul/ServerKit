"""Shared protocol/actor/host helpers retain their callers' contracts."""

from datetime import datetime, timedelta, timezone
import pytest
from flask import g
from flask_jwt_extended import verify_jwt_in_request

from app.services.cf_ops_change_service import CfOpsChangeService
from app.services.connect_format import iso_datetime
from app.services.resource_tier_service import ResourceTierService
from app.services.shared_resource_service import _current_user_id
from app.utils.actor import current_actor_id
from factories import make_user, headers_for


@pytest.mark.parametrize('lookup', [current_actor_id, _current_user_id, CfOpsChangeService._current_user_id])
def test_optional_actor_without_request(lookup):
    assert lookup() is None


@pytest.mark.parametrize('kind', ['jwt', 'api-key'])
def test_shared_actor_preserves_authenticated_owner(app, db_session, kind):
    user = make_user(db_session, role='admin', username=f'actor-{kind}')
    headers = {}
    if kind == 'jwt':
        headers = headers_for(str(user.id))
    with app.test_request_context(headers=headers):
        if kind == 'jwt':
            verify_jwt_in_request()
        else:
            g.api_key_user = user
        assert current_actor_id() == user.id
        assert _current_user_id() == user.id
        assert CfOpsChangeService._current_user_id() == user.id


def test_actor_lookup_failure_remains_best_effort(monkeypatch):
    def unavailable():
        raise RuntimeError('identity unavailable')
    monkeypatch.setattr('app.middleware.rbac.get_current_user', unavailable)
    assert current_actor_id() is None


@pytest.mark.parametrize('value,expected', [
    (None, None), ('already formatted', 'already formatted'), (123, None),
    (datetime(2026, 9, 5), '2026-09-05T00:00:00+00:00'),
    (datetime(2026, 9, 5, tzinfo=timezone(timedelta(hours=2))), '2026-09-05T00:00:00+02:00'),
])
def test_connect_date_serialization(value, expected):
    from app.services.connect_policy import _iso as policy_iso
    from app.services.connect_storage import _iso as storage_iso
    assert iso_datetime(value) == expected
    assert policy_iso(value) == expected
    assert storage_iso(value) == expected


@pytest.mark.parametrize('container', [None, 'docker', 'lxc', 'openvz'])
def test_resource_tier_uses_host_inventory_detection(monkeypatch, container):
    monkeypatch.setattr('app.services.host_inventory_service._detect_container', lambda: container)
    assert ResourceTierService._detect_container() == container
