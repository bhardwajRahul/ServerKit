"""Stalwart mail-server engine service (serverkit-mail extension).

Runs the Stalwart all-in-one mail server (SMTP/IMAP/JMAP/Sieve) in a managed
Docker container so a ServerKit box can host mailboxes for its domains. Driven
entirely through Stalwart's HTTP **admin API**, published on loopback only.

Design mirrors the serverkit-dns-server extension exactly:

* **Two choke-points** — every Docker invocation goes through :meth:`_docker`
  (privilege escalation, timeouts, error shaping) and every admin-API call goes
  through :meth:`_api` (HTTP Basic auth, JSON, error shaping). Nothing else
  shells out or talks HTTP.
* **Best-effort, Linux-only** — on Windows (dev) or when Docker is absent, calls
  return a clean error dict instead of raising.
* **Panel DB is the source of truth** — our tables describe what *should* exist;
  the thin reconcile methods (:meth:`upsert_account`, :meth:`upsert_domain`, …)
  push best-effort to Stalwart and **degrade gracefully**: a 404 / shape change
  in the version-sensitive admin API returns ``{success: False, error}`` and
  never raises, so :class:`MailService` can still record a row with
  ``sync_state='error'``.
* **Secrets in the config store** — the generated admin password lives in the
  plugin config store (``plugins_sdk.config`` + the ``_save_config`` pattern),
  used as HTTP Basic auth to the admin API.

Version note: the Stalwart admin API is version-sensitive. All endpoint paths are
centralized as module constants below and each reconcile call is wrapped so a
future API change degrades to a reported drift rather than a crash.
"""
import logging
import os
import secrets
import subprocess

import requests

from app.utils.system import run_privileged, is_command_available

logger = logging.getLogger(__name__)

SLUG = 'serverkit-mail'

# Official Stalwart all-in-one mail server image. NOTE: the image is
# ``stalwartlabs/stalwart`` — the older ``stalwartlabs/mail-server`` name no
# longer resolves on Docker Hub (verified against a live pull, v0.16.11).
IMAGE = 'stalwartlabs/stalwart:latest'
CONTAINER_NAME = 'serverkit-mail'
DATA_DIR = '/var/serverkit/mail'
# Stalwart splits config from data inside the container (its CMD is
# ``--config /etc/stalwart/config.json``). We bind two host sub-dirs so both
# survive a container recreate: the local bootstrap config and the data store.
CONTAINER_CONFIG_DIR = '/etc/stalwart'   # holds config.json (written at setup)
CONTAINER_DATA_DIR = '/opt/stalwart'     # holds the data/blob/fts store
HOST_CONFIG_DIR = f'{DATA_DIR}/etc'
HOST_DATA_DIR = f'{DATA_DIR}/data'

# Admin HTTP API — published on 127.0.0.1 only, never reachable off-host.
API_HOST = '127.0.0.1'
API_PORT = 8080
API_BASE = f'http://{API_HOST}:{API_PORT}/api'
API_TIMEOUT = 10
DOCKER_TIMEOUT = 180

# Default admin account Stalwart provisions on first start. The recovery/admin
# credential is pinned via a single ``STALWART_RECOVERY_ADMIN=user:secret`` env
# var (verified from the container's first-boot log, v0.16.11).
ADMIN_USER = 'admin'

# The web setup + admin SPA the recovery listener serves on the API port. On a
# fresh container Stalwart boots into *bootstrap mode*: only this UI + a recovery
# listener are up, and the whole ``/api/*`` management surface 404s until the
# one-time initial setup is completed here.
ADMIN_UI = '/account'

# Mail ports published on the host (SMTP / submission / IMAP / Sieve).
MAIL_PORTS = ('25', '465', '587', '993', '143', '4190')

DOCS_URL = 'https://stalw.art/docs/'

# ── Admin-API endpoint paths (version-sensitive; centralized on purpose) ──
# Each reconcile method wraps these so a 404 / shape change degrades gracefully.
# These management paths only exist once initial setup is complete (see
# ``get_status`` bootstrap detection); before that every ``/api/*`` is a 404.
EP_PRINCIPAL = '/principal'          # accounts / mailboxes / domains (CRUD)
EP_DKIM = '/dkim'                    # DKIM signature management
EP_QUEUE = '/queue/messages'         # outbound queue introspection
EP_RECONFIG = '/reload'              # ask Stalwart to reload config
EP_SESSION = '/session'              # logged-in principal probe (readiness/bootstrap)


class StalwartService:
    """Stateless wrapper around Docker + the Stalwart admin HTTP API."""

    # ---------- config (plugin config store) ----------

    @classmethod
    def _config(cls):
        """Saved extension settings from the plugin config store."""
        from app.plugins_sdk import config as plugin_config
        return plugin_config(SLUG)

    @classmethod
    def _save_config(cls, updates):
        """Merge *updates* into the plugin's stored config.

        The SDK ``config()`` helper is read-only (the panel owns writes), so the
        generated admin password is persisted through the InstalledPlugin row
        directly. Returns False when the plugin row is absent (dev shells).
        """
        from app import db
        from app.models.plugin import InstalledPlugin
        row = InstalledPlugin.query.filter_by(slug=SLUG).first()
        if not row:
            logger.warning('%s: no InstalledPlugin row; config not persisted', SLUG)
            return False
        merged = dict(row.config or {})
        merged.update(updates)
        row.config = merged
        db.session.commit()
        return True

    # ---------- docker choke-point ----------

    @classmethod
    def _docker(cls, args, timeout=DOCKER_TIMEOUT):
        """Run ``docker <args>`` and return a normalized result dict."""
        if os.name == 'nt':
            return {'success': False,
                    'error': 'The mail server extension is not supported on Windows.'}
        if not is_command_available('docker'):
            return {'success': False, 'not_installed': True,
                    'error': 'Docker is not installed on this host.'}
        cmd = ['docker'] + list(args)
        try:
            result = run_privileged(cmd, timeout=timeout)
        except subprocess.TimeoutExpired:
            return {'success': False, 'error': f'docker timed out after {timeout}s'}
        except (OSError, subprocess.SubprocessError) as e:
            return {'success': False, 'error': f'Failed to run docker: {e}'}
        out = {
            'success': result.returncode == 0,
            'returncode': result.returncode,
            'stdout': result.stdout or '',
            'stderr': result.stderr or '',
        }
        if not out['success']:
            out['error'] = (out['stderr'] or out['stdout'] or 'docker failed').strip()
        return out

    # ---------- Stalwart admin-API choke-point ----------

    @classmethod
    def _api(cls, method, path, payload=None):
        """Call the container's Stalwart admin HTTP API (loopback only).

        Returns ``{'success': True, 'data': <json-or-None>}`` or an error dict.
        Auth is HTTP Basic with the generated admin password. The API is
        published on 127.0.0.1 exclusively, so this never leaves the host.
        Never raises.
        """
        if os.name == 'nt':
            return {'success': False,
                    'error': 'The mail server extension is not supported on Windows.'}
        password = cls._config().get('admin_password')
        if not password:
            return {'success': False,
                    'error': 'Stalwart admin password is not configured. Reinstall the mail server.'}
        try:
            resp = requests.request(
                method, API_BASE + path,
                auth=(ADMIN_USER, password),
                json=payload,
                timeout=API_TIMEOUT,
            )
        except requests.RequestException as e:
            return {'success': False,
                    'error': f'Stalwart admin API is unreachable: {e}'}
        if resp.status_code >= 400:
            # Stalwart returns RFC-7807 problem+json: {type,status,title,detail}.
            try:
                body = resp.json()
                detail = (body.get('detail') or body.get('title')
                          or body.get('error') or resp.text)
            except ValueError:
                detail = resp.text
            return {'success': False, 'status_code': resp.status_code,
                    'error': f'Stalwart admin API error ({resp.status_code}): {detail}'.strip()}
        if not resp.content:
            return {'success': True, 'data': None}
        try:
            return {'success': True, 'data': resp.json()}
        except ValueError:
            return {'success': True, 'data': resp.text}

    # ---------- container lifecycle ----------

    @classmethod
    def is_installed(cls):
        """True when the managed container exists (running or not)."""
        if os.name == 'nt':
            return False
        res = cls._docker(['inspect', '--format', '{{.State.Running}}',
                           CONTAINER_NAME], timeout=20)
        return bool(res.get('success'))

    @classmethod
    def get_status(cls):
        """Installed / running / version / ports summary, best-effort."""
        status = {
            'installed': False,
            'running': False,
            'needs_setup': None,   # True until Stalwart's one-time setup is done
            'setup_url': None,
            'version': None,
            'engine': 'stalwart',
            'image': IMAGE,
            'container': CONTAINER_NAME,
            'ports': list(MAIL_PORTS),
            'admin_api': f'{API_HOST}:{API_PORT}',
            'hostname': cls._config().get('hostname') if os.name != 'nt' else None,
            'docs_url': DOCS_URL,
        }
        if os.name == 'nt':
            return status
        res = cls._docker(['inspect', '--format', '{{.State.Running}}',
                           CONTAINER_NAME], timeout=20)
        if not res.get('success'):
            return status
        status['installed'] = True
        status['running'] = res.get('stdout', '').strip() == 'true'
        if status['running']:
            # A fresh container boots into bootstrap mode: only the recovery
            # setup UI is up and every /api/* is a 404 until initial setup is
            # completed. Detect that so the panel can guide the operator instead
            # of firing management calls that will all fail.
            probe = cls._api('GET', EP_SESSION)
            if probe.get('status_code') == 404:
                status['needs_setup'] = True
                status['setup_url'] = f'http://{API_HOST}:{API_PORT}{ADMIN_UI}'
            elif probe.get('success'):
                status['needs_setup'] = False
                data = probe.get('data')
                if isinstance(data, dict):
                    status['version'] = data.get('version') or status['version']
            # Any other error (unreachable, still starting): leave needs_setup
            # None so the UI shows "checking…" rather than a false ready state.
        return status

    @classmethod
    def install(cls, hostname):
        """Create and start the Stalwart container.

        * Data + config bind-mounted at ``DATA_DIR`` (Stalwart bootstraps on
          first start).
        * Mail ports published on the host so the box can send/receive mail.
        * Admin HTTP API published on **127.0.0.1 only** with a generated
          password persisted to the plugin config store.
        """
        if os.name == 'nt':
            return {'success': False,
                    'error': 'The mail server extension is not supported on Windows.'}
        hostname = (hostname or '').strip().lower().rstrip('.')
        if not hostname:
            return {'success': False, 'error': 'A mail server hostname is required'}
        if cls.is_installed():
            return {'success': False,
                    'error': 'The mail server container already exists. Uninstall it first.'}

        dir_res = run_privileged(['mkdir', '-p', HOST_CONFIG_DIR, HOST_DATA_DIR])
        if getattr(dir_res, 'returncode', 1) != 0:
            return {'success': False,
                    'error': f'Could not create data directory {DATA_DIR}: '
                             f'{(getattr(dir_res, "stderr", "") or "").strip()}'}

        admin_password = secrets.token_urlsafe(24)
        run_args = [
            'run', '-d',
            '--name', CONTAINER_NAME,
            '--restart', 'unless-stopped',
            '--hostname', hostname,
        ]
        for port in MAIL_PORTS:
            run_args += ['-p', f'{port}:{port}']
        # Admin API bound to loopback on the host — never reachable off-box.
        run_args += ['-p', f'{API_HOST}:{API_PORT}:{API_PORT}']
        # Config and data on separate host dirs (see the module constants).
        run_args += [
            '-v', f'{HOST_CONFIG_DIR}:{CONTAINER_CONFIG_DIR}',
            '-v', f'{HOST_DATA_DIR}:{CONTAINER_DATA_DIR}',
        ]
        # Pin the recovery/admin credential Stalwart reads on first boot — a
        # single ``user:secret`` env var. Without this Stalwart prints a random
        # one-time password to the container log that we could never recover.
        run_args += [
            '-e', f'STALWART_RECOVERY_ADMIN={ADMIN_USER}:{admin_password}',
            IMAGE,
        ]
        res = cls._docker(run_args)
        if not res.get('success'):
            return {'success': False,
                    'error': res.get('error', 'Failed to start the Stalwart container')}

        persisted = cls._save_config({
            'admin_password': admin_password,
            'hostname': hostname,
        })
        result = {'success': True,
                  'message': 'Stalwart mail server installed — complete the one-time '
                             'setup to activate the admin API',
                  'container': CONTAINER_NAME,
                  'hostname': hostname,
                  'needs_setup': True,
                  'setup_url': f'http://{API_HOST}:{API_PORT}{ADMIN_UI}'}
        if not persisted:
            result['warning'] = ('Container started but the admin password could not '
                                 'be persisted to the plugin config store.')
        return result

    @classmethod
    def uninstall(cls, keep_data=True):
        """Remove the container; optionally delete the mail data directory."""
        if os.name == 'nt':
            return {'success': False,
                    'error': 'The mail server extension is not supported on Windows.'}
        res = cls._docker(['rm', '-f', CONTAINER_NAME])
        if not res.get('success'):
            return {'success': False,
                    'error': res.get('error', 'Failed to remove the Stalwart container')}
        if not keep_data:
            rm = run_privileged(['rm', '-rf', DATA_DIR])
            if getattr(rm, 'returncode', 1) != 0:
                return {'success': True,
                        'warning': f'Container removed but mail data at {DATA_DIR} '
                                   f'could not be deleted: {(getattr(rm, "stderr", "") or "").strip()}'}
        cls._save_config({'admin_password': None})
        return {'success': True,
                'message': 'Mail server removed'
                           + ('' if keep_data else ' (mail data deleted)')}

    @classmethod
    def control(cls, action):
        """Start / stop / restart the managed container."""
        if action not in ('start', 'stop', 'restart'):
            return {'success': False, 'error': f'Invalid action: {action!r}'}
        if not cls.is_installed():
            return {'success': False, 'error': 'The mail server is not installed.'}
        res = cls._docker([action, CONTAINER_NAME], timeout=60)
        if not res.get('success'):
            return {'success': False, 'error': res.get('error', f'docker {action} failed')}
        return {'success': True, 'message': f'Mail server {action}ed', 'action': action}

    # ---------- thin reconcile methods (best-effort, never raise) ----------
    #
    # Each of these pushes the panel's intent to Stalwart via the version-
    # sensitive admin API and returns {success, ...}. On any error they report
    # {success: False, error} so MailService can flag the row's sync_state.

    @classmethod
    def _principal_payload(cls, ptype, name, **extra):
        payload = {'type': ptype, 'name': name}
        payload.update({k: v for k, v in extra.items() if v is not None})
        return payload

    @classmethod
    def upsert_account(cls, email, password=None, quota_mb=0, display_name=None):
        """Create/update a mailbox account principal on Stalwart. Best-effort."""
        if not cls.is_installed():
            return {'success': False, 'error': 'Mail server not installed', 'skipped': True}
        extra = {}
        if password:
            extra['secrets'] = [password]
        if display_name:
            extra['description'] = display_name
        if quota_mb:
            extra['quota'] = int(quota_mb) * 1024 * 1024  # bytes
        payload = cls._principal_payload('individual', email, **extra)
        res = cls._api('POST', EP_PRINCIPAL, payload)
        if res.get('success'):
            return {'success': True, 'email': email}
        return {'success': False, 'error': res.get('error', 'Stalwart account upsert failed')}

    @classmethod
    def delete_account(cls, email):
        """Delete a mailbox account principal on Stalwart. Best-effort."""
        if not cls.is_installed():
            return {'success': False, 'error': 'Mail server not installed', 'skipped': True}
        res = cls._api('DELETE', f'{EP_PRINCIPAL}/{email}')
        if res.get('success') or res.get('status_code') == 404:
            return {'success': True, 'email': email}
        return {'success': False, 'error': res.get('error', 'Stalwart account delete failed')}

    @classmethod
    def set_password(cls, email, password):
        """Set a mailbox account's password on Stalwart. Best-effort."""
        if not cls.is_installed():
            return {'success': False, 'error': 'Mail server not installed', 'skipped': True}
        if not password:
            return {'success': False, 'error': 'A password is required'}
        res = cls._api('PATCH', f'{EP_PRINCIPAL}/{email}', {'secrets': [password]})
        if res.get('success'):
            return {'success': True, 'email': email}
        # Fall back to a full upsert if PATCH is unsupported in this version.
        return cls.upsert_account(email, password=password)

    @classmethod
    def upsert_domain(cls, name):
        """Register a domain principal on Stalwart. Best-effort."""
        if not cls.is_installed():
            return {'success': False, 'error': 'Mail server not installed', 'skipped': True}
        payload = cls._principal_payload('domain', name)
        res = cls._api('POST', EP_PRINCIPAL, payload)
        if res.get('success'):
            return {'success': True, 'domain': name}
        return {'success': False, 'error': res.get('error', 'Stalwart domain upsert failed')}

    @classmethod
    def delete_domain(cls, name):
        """Remove a domain principal from Stalwart. Best-effort."""
        if not cls.is_installed():
            return {'success': False, 'error': 'Mail server not installed', 'skipped': True}
        res = cls._api('DELETE', f'{EP_PRINCIPAL}/{name}')
        if res.get('success') or res.get('status_code') == 404:
            return {'success': True, 'domain': name}
        return {'success': False, 'error': res.get('error', 'Stalwart domain delete failed')}

    @classmethod
    def list_queue(cls):
        """List outbound queue messages from the admin API. ``[]`` when down."""
        if not cls.is_installed():
            return {'success': True, 'messages': []}
        res = cls._api('GET', EP_QUEUE)
        if not res.get('success'):
            return {'success': True, 'messages': [], 'note': res.get('error')}
        data = res.get('data')
        if isinstance(data, list):
            messages = data
        elif isinstance(data, dict):
            messages = data.get('items', [])
        else:
            messages = []
        return {'success': True, 'messages': messages}

    @classmethod
    def flush_queue(cls):
        """Ask Stalwart to retry/flush the outbound queue. Best-effort."""
        if not cls.is_installed():
            return {'success': False, 'error': 'Mail server not installed', 'skipped': True}
        res = cls._api('PATCH', EP_QUEUE, {'action': 'retry'})
        if res.get('success'):
            return {'success': True, 'message': 'Queue flush requested'}
        return {'success': False, 'error': res.get('error', 'Queue flush failed')}
