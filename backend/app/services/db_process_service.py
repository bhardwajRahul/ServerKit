"""Live database process inspection and termination.

Surfaces ``SHOW FULL PROCESSLIST`` (MySQL/MariaDB) and ``pg_stat_activity``
(PostgreSQL) for the Database Explorer, plus a kill/terminate action.

A *target* mirrors the explorer's connection shapes:

    {'engine': 'mysql'|'postgresql',   # which SQL dialect / client to use
     'container': None | 'name',       # set for Docker-hosted databases
     'user': ..., 'password': ...,     # optional credentials
     'database': ...}                  # optional (docker postgres only)

Every statement flows through the single :meth:`DbProcessService._exec_sql`
choke-point (which reuses the exact exec pathways the explorer already uses in
``DatabaseService``), so tests can stub one method to cover everything.
"""
import subprocess

from app.services.database_service import DatabaseService

SUPPORTED_ENGINES = ('mysql', 'postgresql')

_MYSQL_PROCESSLIST = 'SHOW FULL PROCESSLIST;'

# pid | usename | datname | state | time_s | query  (query LAST so the
# separator-based parse can never be broken by user SQL; newlines/tabs are
# flattened server-side for the same reason).
_PG_PROCESSLIST = (
    "SELECT pid, usename, datname, state, "
    "COALESCE(floor(extract(epoch FROM now() - query_start))::bigint, 0), "
    "regexp_replace(COALESCE(query, ''), E'[\\n\\r\\t]+', ' ', 'g') "
    "FROM pg_stat_activity "
    "WHERE pid <> pg_backend_pid() "
    "ORDER BY 5 DESC;"
)


class DbProcessService:
    """List and kill live server processes for MySQL/MariaDB and PostgreSQL."""

    # ------------------------------------------------------------------
    # Single exec choke-point
    # ------------------------------------------------------------------
    @staticmethod
    def _exec_sql(target, sql):
        """Run ``sql`` against the target's engine.

        Returns ``{'success': bool, 'output': str, 'error': str|None}`` —
        the same shape the underlying ``DatabaseService`` helpers return.
        """
        engine = target.get('engine')
        container = target.get('container')
        try:
            if container:
                if engine == 'mysql':
                    return DatabaseService.docker_mysql_execute(
                        container, sql,
                        user=target.get('user') or 'root',
                        password=target.get('password'),
                    )
                # Docker PostgreSQL — same docker-exec pathway, psql client.
                cmd = ['docker', 'exec']
                if target.get('password'):
                    cmd.extend(['-e', f"PGPASSWORD={target['password']}"])
                cmd.extend([
                    container, 'psql',
                    '-U', target.get('user') or 'postgres',
                    '-d', target.get('database') or 'postgres',
                    '-t', '-A', '-c', sql,
                ])
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
                return {
                    'success': result.returncode == 0,
                    'output': result.stdout,
                    'error': result.stderr if result.returncode != 0 else None,
                }
            if engine == 'mysql':
                return DatabaseService.mysql_execute(sql, root_password=target.get('password'))
            return DatabaseService.pg_execute(sql)
        except subprocess.TimeoutExpired:
            return {'success': False, 'output': '', 'error': 'Query timed out'}
        except Exception as e:  # docker/client missing (e.g. Windows dev box)
            return {'success': False, 'output': '', 'error': str(e)}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    @classmethod
    def list_processes(cls, target):
        """List live server processes, normalized across engines.

        Returns ``{'processes': [{id, user, db, state, command, time_s,
        query}, ...]}`` or ``{'error': msg}``.
        """
        engine = (target or {}).get('engine')
        if engine not in SUPPORTED_ENGINES:
            return {'error': 'unsupported engine'}

        sql = _MYSQL_PROCESSLIST if engine == 'mysql' else _PG_PROCESSLIST
        result = cls._exec_sql(target, sql)
        if not result.get('success'):
            return {'error': result.get('error') or 'failed to list processes'}

        output = result.get('output') or ''
        if engine == 'mysql':
            return {'processes': cls._parse_mysql_processlist(output)}
        return {'processes': cls._parse_pg_activity(output)}

    @classmethod
    def kill_process(cls, target, pid):
        """Kill/terminate a server process by id.

        MySQL: ``KILL <id>``; PostgreSQL: ``SELECT pg_terminate_backend(<pid>)``.
        ``pid`` is validated as an integer before it goes anywhere near SQL.
        """
        engine = (target or {}).get('engine')
        if engine not in SUPPORTED_ENGINES:
            return {'error': 'unsupported engine'}
        try:
            pid = int(pid)
        except (TypeError, ValueError):
            return {'error': 'pid must be an integer'}

        if engine == 'mysql':
            sql = f'KILL {pid};'
        else:
            sql = f'SELECT pg_terminate_backend({pid});'

        result = cls._exec_sql(target, sql)
        if not result.get('success'):
            return {'error': result.get('error') or 'failed to kill process'}
        if engine == 'postgresql' and (result.get('output') or '').strip() == 'f':
            return {'error': 'process not found or could not be terminated'}
        return {'success': True, 'pid': pid}

    # ------------------------------------------------------------------
    # Output parsing / normalization
    # ------------------------------------------------------------------
    @staticmethod
    def _parse_mysql_processlist(output):
        """Parse tab-separated ``SHOW FULL PROCESSLIST`` batch output.

        Columns: Id, User, Host, db, Command, Time, State, Info. ``Info``
        (the query) is last, so a bounded split keeps embedded tabs safe —
        the mysql client already escapes newlines in batch mode.
        """
        processes = []
        lines = [ln for ln in output.split('\n') if ln.strip()]
        for line in lines:
            parts = line.split('\t', 7)
            if len(parts) < 7:
                continue
            try:
                proc_id = int(parts[0])
            except ValueError:
                continue  # header row ("Id\tUser\t...") or noise
            info = parts[7] if len(parts) > 7 else ''
            try:
                time_s = int(parts[5])
            except ValueError:
                time_s = 0
            processes.append({
                'id': proc_id,
                'user': parts[1],
                'db': None if parts[3] == 'NULL' else parts[3],
                'command': parts[4],
                'time_s': time_s,
                'state': parts[6],
                'query': '' if info in ('NULL', '') else info,
            })
        return processes

    @staticmethod
    def _parse_pg_activity(output):
        """Parse ``psql -t -A`` ('|'-separated, no header) activity rows.

        The query column is selected last and split with a bound, so query
        text containing '|' cannot shift fields.
        """
        processes = []
        for line in output.split('\n'):
            line = line.strip()
            if not line:
                continue
            parts = line.split('|', 5)
            if len(parts) < 6:
                continue
            try:
                pid = int(parts[0])
            except ValueError:
                continue
            try:
                time_s = int(float(parts[4])) if parts[4] else 0
            except ValueError:
                time_s = 0
            processes.append({
                'id': pid,
                'user': parts[1] or None,
                'db': parts[2] or None,
                'command': '',
                'time_s': time_s,
                'state': parts[3] or 'idle',
                'query': parts[5],
            })
        return processes
