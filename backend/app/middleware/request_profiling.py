"""Opt-in request/SQL costs, without SQL text, parameters or persistent storage."""

from time import perf_counter_ns

from flask import g, has_request_context, request
from sqlalchemy import event


def register_request_profiling(app, database):
    """Attach only when enabled; normal deployments install no query listeners.

    Counts SQLAlchemy statements on the request thread, including failed SQL.
    Streaming body iteration and background jobs occur outside this interval.
    """
    if not app.config.get('PROFILE_REQUESTS'):
        return
    if app.extensions.get('serverkit_request_profiling'):
        return
    app.extensions['serverkit_request_profiling'] = True

    @app.before_request
    def begin_request():
        if request.path.startswith('/api/'):
            g.serverkit_profile = {
                'start': perf_counter_ns(), 'queries': 0, 'sql_ns': 0,
            }

    def before_sql(_conn, _cursor, _statement, _parameters, context, _many):
        if not has_request_context():
            return
        state = getattr(g, 'serverkit_profile', None)
        if state is not None:
            state['queries'] += 1
            context._serverkit_profile = (state, perf_counter_ns())

    def finish_sql(context):
        timing = getattr(context, '_serverkit_profile', None)
        if timing is not None:
            state, start = timing
            state['sql_ns'] += perf_counter_ns() - start
            context._serverkit_profile = None

    def after_sql(_conn, _cursor, _statement, _parameters, context, _many):
        finish_sql(context)

    def failed_sql(error_context):
        finish_sql(error_context.execution_context)

    with app.app_context():
        for engine in set(database.engines.values()):
            event.listen(engine, 'before_cursor_execute', before_sql)
            event.listen(engine, 'after_cursor_execute', after_sql)
            event.listen(engine, 'handle_error', failed_sql)

    @app.after_request
    def expose_profile(response):
        state = getattr(g, 'serverkit_profile', None)
        if state is not None:
            app_ms = (perf_counter_ns() - state['start']) / 1_000_000
            sql_ms = state['sql_ns'] / 1_000_000
            response.headers.add(
                'Server-Timing',
                f'app;dur={app_ms:.3f}, db;dur={sql_ms:.3f};'
                f'desc="{state["queries"]} queries"',
            )
        return response
