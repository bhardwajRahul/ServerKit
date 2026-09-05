"""Profiling is opt-in, request-local and never discloses SQL or parameters."""

import re

from flask import Flask
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.middleware.request_profiling import register_request_profiling


def profile_app(enabled):
    app = Flask(__name__)
    app.config.update(SQLALCHEMY_DATABASE_URI='sqlite://', PROFILE_REQUESTS=enabled)
    database = SQLAlchemy(app)
    register_request_profiling(app, database)
    register_request_profiling(app, database)  # registration must be idempotent

    @app.get('/api/v1/query')
    def query():
        database.session.execute(text('SELECT :secret'), {'secret': 'private-value'})
        database.session.execute(text('SELECT 2'))
        return 'ok', 200, {'Server-Timing': 'existing;dur=1'}

    @app.get('/api/v1/empty')
    def empty():
        return 'ok'

    @app.get('/api/v1/fail')
    def fail():
        try:
            database.session.execute(text('SELECT * FROM private_missing_table'))
        except SQLAlchemyError:
            return 'failed', 400
        raise AssertionError('Expected invalid SQL')

    @app.get('/page')
    def page():
        database.session.execute(text('SELECT 1'))
        return 'page'

    return app, database


def test_default_off_installs_no_profile_and_preserves_headers():
    app, _database = profile_app(False)
    response = app.test_client().get('/api/v1/query')
    assert response.headers.getlist('Server-Timing') == ['existing;dur=1']
    assert 'serverkit_request_profiling' not in app.extensions


def test_counts_queries_without_leaking_sql_and_isolates_requests():
    app, database = profile_app(True)
    client = app.test_client()
    # A job/startup query must not be attributed to the next HTTP request.
    with app.app_context():
        database.session.execute(text('SELECT 1'))
    response = client.get('/api/v1/query')
    headers = response.headers.getlist('Server-Timing')
    assert headers[0] == 'existing;dur=1'
    assert re.fullmatch(r'app;dur=\d+\.\d{3}, db;dur=\d+\.\d{3};desc="2 queries"', headers[1])
    assert 'private' not in str(headers)
    assert 'SELECT' not in str(headers)
    assert 'desc="0 queries"' in client.get('/api/v1/empty').headers['Server-Timing']
    assert 'Server-Timing' not in client.get('/page').headers


def test_failed_sql_is_counted_and_does_not_leak_into_the_next_request():
    app, _database = profile_app(True)
    client = app.test_client()
    response = client.get('/api/v1/fail')
    assert response.status_code == 400
    assert 'desc="1 queries"' in response.headers['Server-Timing']
    assert 'private_missing_table' not in response.headers['Server-Timing']
    assert 'desc="0 queries"' in client.get('/api/v1/empty').headers['Server-Timing']
