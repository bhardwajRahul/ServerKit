"""
LocalKit Bridge API — endpoints for the LocalKit desktop app.

Mounted at ``/api/v1/localkit`` (see plugin.json). Every route accepts
``X-API-Key`` auth because it is guarded by the RBAC decorators
(``auth_required`` / ``admin_required``) that honor the API-key middleware
(``g.api_key_user``) — bare flask ``@jwt_required()`` would reject API keys
(see docs/WORDPRESS_ROADMAP.md; this blueprint is the API-key-friendly
surface for WordPress automation).

Endpoints (all JSON unless noted):
  GET  /pair        — validate the API key + report panel info + `features`
  GET  /sites       — list WordPress sites (delegates to serverkit-wordpress)
  POST /sites       — provision a new WordPress site to push into
  POST /push/code   — multipart: site_id + wp-content tar.gz -> docker cp into the site
  POST /push/db     — multipart: site_id + SQL dump + local_url -> import + search-replace
  GET  /pull/db     — ?site_id= -> gzipped SQL dump of the site's database
  GET  /pull/code   — ?site_id= -> tar.gz of the site's wp-content directory

Sync v2 (chunked, resumable — plan 19), for `<kind>` in {code, db}:
  POST /push/<kind>/init    — describe the transfer -> {transfer_id, received}
  PUT  /push/<kind>/chunk   — ?transfer_id&offset&sha256 + raw body -> {received}
  POST /push/<kind>/finish  — verify the whole-file sha256, then run the *same*
                              v1 processing path on the assembled file

v1 push runs inline and is bounded by the panel's MAX_CONTENT_LENGTH (100MB).
v2 lifts that: every request is one 8 MiB chunk, so the limit stops applying to
the payload. Both directions end in the same `_install_code` / `_import_db`
helper — there is exactly one processing path, and v2 only changes how the
bytes arrive. Processing still happens inline in `finish` (no job queue yet),
but only *after* the hash verifies, so an abandoned transfer can never leave
half-applied state: it is just a temp directory the next `init` reaps.

`FEATURES` below is the capability contract LocalKit gates its UI on: an older
copy of this extension simply omits a name, and the client disables the
matching button instead of failing halfway through an operation.
"""

import hashlib
import importlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import uuid

from flask import Blueprint, after_this_request, jsonify, request, send_file

from app.middleware.rbac import admin_required, auth_required, get_current_user
from app.services.db_sync_service import DatabaseSyncService
from app.services.settings_service import SettingsService
from app.utils.domain import canonical_origin
from app.utils.version import get_panel_version

localkit_bp = Blueprint('localkit', __name__)

# What this build of the extension can do — reported by GET /pair so LocalKit
# can gate its UI on capability instead of discovering a 404 mid-operation.
# Append only; never rename an entry (clients match on the literal string).
FEATURES = ['sites', 'push-code', 'push-db', 'pull-db', 'pull-code', 'sync-v2']

# A transfer with no chunk activity for this long is abandoned; the next
# ``init`` sweeps it. Long enough that a user pausing on a slow link keeps
# their resume point, short enough that a dead client's partial upload does
# not sit on the panel's disk overnight.
TRANSFER_TTL_SECONDS = 30 * 60


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _wp_service():
    """Import the serverkit-wordpress service layer (cross-extension), or
    return None when that extension is not installed."""
    try:
        return importlib.import_module(
            'app.plugins.serverkit-wordpress.wordpress_service').WordPressService
    except Exception:
        pass
    try:
        from app.services.plugin_service import _ensure_importable
        if _ensure_importable('serverkit-wordpress'):
            return importlib.import_module(
                'app.plugins.serverkit-wordpress.wordpress_service').WordPressService
    except Exception:
        pass
    return None


def _require_wp_service():
    svc = _wp_service()
    if svc is None:
        return None, (jsonify({
            'error': 'The serverkit-wordpress extension is not installed on this server'
        }), 409)
    return svc, None


def _resolve_site(site_id):
    from app.models import WordPressSite
    try:
        site_id = int(site_id)
    except (TypeError, ValueError):
        return None, (jsonify({'error': 'site_id is required'}), 400)
    site = WordPressSite.query.get(site_id)
    if not site or not site.application:
        return None, (jsonify({'error': 'Site not found'}), 404)
    return site, None


def _site_url(site):
    """Public URL of a site: primary domain if set, else localhost:port —
    mirrors WordPressService._enrich_site_data."""
    app = site.application
    domains = app.domains
    primary = next((d for d in domains if d.is_primary), None)
    if primary is None and domains:
        primary = domains[0]
    if primary is not None:
        scheme = 'https' if primary.ssl_enabled else 'http'
        return f'{scheme}://{primary.name}'
    if app.port:
        return f'http://localhost:{app.port}'
    return None


def _read_env_value(root_path, key):
    try:
        with open(os.path.join(root_path, '.env')) as f:
            for line in f:
                if '=' in line:
                    k, v = line.split('=', 1)
                    if k.strip() == key:
                        return v.strip()
    except OSError:
        pass
    return None


def _compose_file(site):
    root_path = site.application.root_path
    if not root_path:
        return None
    compose_file = os.path.join(root_path, 'docker-compose.yml')
    return compose_file if os.path.exists(compose_file) else None


def _php_version(site):
    """PHP version of a Docker-stack site, read from the compose image tag
    (``wordpress:<core>-php<ver>-apache`` — the same tag
    ``WordPressService.set_php_version`` rewrites).

    Deliberately a file read rather than ``get_php_info``: that shells into the
    container, and this runs once per site in a listing.
    """
    compose_file = _compose_file(site)
    if not compose_file:
        return None
    try:
        with open(compose_file) as f:
            content = f.read()
    except OSError:
        return None
    m = re.search(r'image:\s*wordpress:\S*?-php(\d+\.\d+)', content)
    return m.group(1) if m else None


def _safe_extract_tar_gz(archive_path, dest_dir):
    """Extract a .tar.gz into dest_dir, rejecting path traversal and links
    (same policy as WordPressService._safe_extract_zip)."""
    dest_abs = os.path.abspath(dest_dir)
    try:
        with tarfile.open(archive_path, 'r:gz') as tf:
            for member in tf.getmembers():
                if member.issym() or member.islnk():
                    return {'success': False,
                            'error': f'Links are not allowed in archive: {member.name}'}
                target = os.path.abspath(os.path.join(dest_abs, member.name))
                if target != dest_abs and not target.startswith(dest_abs + os.sep):
                    return {'success': False, 'error': f'Unsafe path in archive: {member.name}'}
            tf.extractall(dest_abs)
        return {'success': True}
    except (tarfile.TarError, OSError, EOFError) as e:
        return {'success': False, 'error': f'Not a valid tar.gz archive: {e}'}


# ---------------------------------------------------------------------------
# Processing (shared by the v1 one-shot uploads and the v2 chunked `finish`)
# ---------------------------------------------------------------------------

def _install_code(svc, site, archive_path):
    """Extract a wp-content tar.gz and install it into the site's container.

    Returns ``(payload, status)``. This is the single code-push processing
    path: v1 hands it the multipart upload, v2 hands it the file its chunks
    were assembled into.
    """
    tmp = tempfile.mkdtemp(prefix='localkit_extract_')
    try:
        extract_dir = os.path.join(tmp, 'x')
        os.makedirs(extract_dir, exist_ok=True)
        # The archive is hash-verified by the time v2 gets here, which proves
        # it arrived intact — not that it is friendly. The safe-extract policy
        # stays mandatory in both paths.
        ext = _safe_extract_tar_gz(archive_path, extract_dir)
        if not ext.get('success'):
            return ext, 400

        wpc = svc._resolve_wp_content_dir(extract_dir)
        if not wpc:
            return {'error': 'No wp-content found in the archive'}, 400

        container = site.application.name
        cp = subprocess.run(
            ['docker', 'cp', f'{wpc}/.', f'{container}:/var/www/html/wp-content'],
            capture_output=True, text=True, timeout=600,
        )
        if cp.returncode != 0:
            return {'error': f'docker cp failed: {cp.stderr}'}, 500
        # Imported files land root-owned; hand them to the web user.
        subprocess.run(
            ['docker', 'exec', container, 'chown', '-R', 'www-data:www-data',
             '/var/www/html/wp-content'],
            capture_output=True, text=True, timeout=300,
        )
        if site.application.root_path:
            svc.wp_cli(site.application.root_path, ['cache', 'flush'])
        return {'success': True, 'message': 'wp-content pushed to the site'}, 200
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _import_db(svc, site, dump_path, local_url):
    """Import a SQL dump over the site's database and rewrite local -> remote
    URLs. Returns ``(payload, status)``. Shared by v1 and v2, as above."""
    compose_file = _compose_file(site)
    if not compose_file:
        return {'error': 'Not a Docker-stack site (no docker-compose.yml)'}, 409

    result = DatabaseSyncService.import_to_container(
        compose_path=compose_file,
        snapshot_path=dump_path,
        db_name='wordpress',
        db_user='root',
        db_password=_read_env_value(site.application.root_path, 'DB_PASSWORD'),
    )
    if not result.get('success'):
        return {'error': f"Database import failed: {result.get('error')}"}, 500

    remote_url = _site_url(site)
    search_replaced = False
    local_url = (local_url or '').strip().rstrip('/')
    if local_url and remote_url and local_url != remote_url:
        root_path = site.application.root_path
        svc.wp_cli(root_path, ['option', 'update', 'home', remote_url])
        svc.wp_cli(root_path, ['option', 'update', 'siteurl', remote_url])
        sr = svc.search_replace(root_path, local_url, remote_url)
        search_replaced = bool(sr.get('success'))
        svc.wp_cli(root_path, ['cache', 'flush'])
        svc.wp_cli(root_path, ['rewrite', 'flush'])

    return {
        'success': True,
        'message': 'Database imported',
        'remote_url': remote_url,
        'search_replace': search_replaced,
    }, 200


# ---------------------------------------------------------------------------
# Pairing
# ---------------------------------------------------------------------------

@localkit_bp.route('/pair', methods=['GET'])
@auth_required()
def pair():
    """Validate the API key and return panel info for LocalKit's settings UI."""
    user = get_current_user()
    canonical_domain = SettingsService.get('canonical_domain', '') or ''
    https_enabled = bool(SettingsService.get('canonical_https_enabled', False))
    return jsonify({
        'status': 'ok',
        'service': 'serverkit-localkit',
        'panel': 'ServerKit',
        'version': get_panel_version(),
        'user': (getattr(user, 'username', None) or getattr(user, 'email', None)
                 or getattr(user, 'name', None)),
        'canonical_domain': canonical_domain,
        'canonical_origin': canonical_origin(canonical_domain, https_enabled) if canonical_domain else None,
        'features': FEATURES,
    }), 200


# ---------------------------------------------------------------------------
# Sites
# ---------------------------------------------------------------------------

@localkit_bp.route('/sites', methods=['GET'])
@admin_required
def list_sites():
    """List WordPress sites — the API-key-friendly equivalent of
    GET /api/v1/wordpress/sites (which is JWT-only).

    Enriched with the fields LocalKit's import flow needs and the hub payload
    does not carry: ``php_version`` (to pick the closest local image) and
    ``site_url`` (an explicit alias of ``url``, which is what search-replace
    rewrites from). ``multisite`` already comes from the model — LocalKit
    refuses to import those.
    """
    svc, err = _require_wp_service()
    if err:
        return err
    payload = svc.get_sites()

    from app.models import WordPressSite
    for entry in payload.get('sites') or []:
        site = WordPressSite.query.get(entry.get('id')) if entry.get('id') else None
        if site is None or not site.application:
            continue
        entry['php_version'] = _php_version(site)
        entry['site_url'] = entry.get('url') or _site_url(site)
    return jsonify(payload), 200


@localkit_bp.route('/sites', methods=['POST'])
@admin_required
def create_site():
    """Provision a fresh WordPress site to push into."""
    svc, err = _require_wp_service()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'Site name is required'}), 400
    user = get_current_user()
    admin_email = (data.get('admin_email') or getattr(user, 'email', None)
                   or 'admin@example.com')
    result = svc.create_site(
        name,
        admin_email,
        user.id,
        php_version=data.get('php_version') or None,
    )
    return jsonify(result), (201 if result.get('success') else 400)


# ---------------------------------------------------------------------------
# Push / pull
# ---------------------------------------------------------------------------

@localkit_bp.route('/push/code', methods=['POST'])
@admin_required
def push_code():
    """Receive a tar.gz of wp-content and install it into the site's container."""
    svc, err = _require_wp_service()
    if err:
        return err
    site, err = _resolve_site(request.form.get('site_id'))
    if err:
        return err
    upload = request.files.get('file')
    if upload is None:
        return jsonify({'error': 'file is required (multipart tar.gz of wp-content)'}), 400

    tmp = tempfile.mkdtemp(prefix='localkit_push_')
    try:
        archive_path = os.path.join(tmp, 'wp-content.tar.gz')
        upload.save(archive_path)
        payload, status = _install_code(svc, site, archive_path)
        return jsonify(payload), status
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@localkit_bp.route('/push/db', methods=['POST'])
@admin_required
def push_db():
    """Receive a SQL dump, import it over the site's database and rewrite the
    site URL local -> remote (serialization-safe wp-cli search-replace)."""
    svc, err = _require_wp_service()
    if err:
        return err
    site, err = _resolve_site(request.form.get('site_id'))
    if err:
        return err
    upload = request.files.get('file')
    if upload is None:
        return jsonify({'error': 'file is required (multipart .sql or .sql.gz dump)'}), 400
    local_url = request.form.get('local_url')

    suffix = '.sql.gz' if (upload.filename or '').endswith('.gz') else '.sql'
    fd, dump_path = tempfile.mkstemp(prefix='localkit_push_', suffix=suffix)
    os.close(fd)
    try:
        upload.save(dump_path)
        payload, status = _import_db(svc, site, dump_path, local_url)
        return jsonify(payload), status
    finally:
        try:
            os.remove(dump_path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Chunked push (sync v2, plan 19)
# ---------------------------------------------------------------------------
#
# A transfer is a directory, not a database row — the panel owns no schema for
# something this short-lived, and a directory is trivially reapable:
#
#   <tmp>/localkit_transfers/<transfer_id>/
#       meta.json         written once at init, read-only afterwards
#       payload           the assembled file (written at offsets, sparse until full)
#       chunks/<offset>   marker per confirmed chunk, containing its sha256
#
# Confirmed chunks are marker *files* rather than a list inside meta.json on
# purpose: two chunk requests can then never race each other rewriting shared
# state, without the extension having to take a lock.

_HEX64 = re.compile(r'^[0-9a-f]{64}$')
_TRANSFER_ID = re.compile(r'^[0-9a-f]{32}$')

# Bounds ``request.get_data()`` on a chunk PUT. The panel's own
# MAX_CONTENT_LENGTH (100MB) is the hard stop; this keeps a client from
# negotiating a chunk size that makes each request pathologically large.
MAX_CHUNK_SIZE = 64 * 1024 * 1024


def _transfer_root():
    root = os.path.join(tempfile.gettempdir(), 'localkit_transfers')
    os.makedirs(root, exist_ok=True)
    return root


def _transfer_dir(transfer_id):
    """Directory for a transfer id, or None if the id is not one we minted.

    The id lands in a filesystem path, so it is validated against the exact
    shape ``uuid4().hex`` produces rather than sanitized — anything else is a
    client sending something it was never given.
    """
    if not transfer_id or not _TRANSFER_ID.match(transfer_id):
        return None
    return os.path.join(_transfer_root(), transfer_id)


def _load_meta(transfer_id):
    tdir = _transfer_dir(transfer_id)
    if not tdir:
        return None, None
    try:
        with open(os.path.join(tdir, 'meta.json')) as f:
            return json.load(f), tdir
    except (OSError, ValueError):
        return None, None


def _received_offsets(tdir):
    try:
        names = os.listdir(os.path.join(tdir, 'chunks'))
    except OSError:
        return []
    out = []
    for name in names:
        try:
            out.append(int(name))
        except ValueError:
            continue
    return sorted(out)


def _touched_at(tdir):
    """Last sign of life for a transfer directory: the newest mtime among the
    directory itself and everything immediately inside it. Covers both shapes
    living under the transfer root — an upload's ``chunks/`` subdirectory and a
    download session's cached export file."""
    try:
        children = os.listdir(tdir)
    except OSError:
        children = []
    stamps = []
    for path in (tdir, *(os.path.join(tdir, n) for n in children)):
        try:
            stamps.append(os.path.getmtime(path))
        except OSError:
            pass
    return max(stamps) if stamps else 0


def _discard_transfer(tdir):
    shutil.rmtree(tdir, ignore_errors=True)


def _reap_stale_transfers():
    """Lazy sweep, run on every ``init``. No cron, no background thread: an
    abandoned transfer costs disk, and the next person to start one pays the
    (cheap) cost of cleaning up after them."""
    root = _transfer_root()
    cutoff = time.time() - TRANSFER_TTL_SECONDS
    try:
        entries = os.listdir(root)
    except OSError:
        return
    for name in entries:
        tdir = os.path.join(root, name)
        if os.path.isdir(tdir) and _touched_at(tdir) < cutoff:
            _discard_transfer(tdir)


def _find_resumable(site_id, kind, sha256, total_bytes, chunk_size):
    """An existing transfer of the exact same payload, if one survived.

    Every field must match, chunk_size included: a different chunking of the
    same bytes puts the confirmed offsets in the wrong places, and resuming
    onto it would assemble a file that fails the final hash check for reasons
    nobody could debug.
    """
    root = _transfer_root()
    try:
        entries = sorted(os.listdir(root))
    except OSError:
        return None
    for name in entries:
        meta, tdir = _load_meta(name)
        if not meta or not os.path.isdir(tdir or ''):
            continue
        if (meta.get('site_id') == site_id and meta.get('kind') == kind
                and meta.get('sha256') == sha256
                and meta.get('total_bytes') == total_bytes
                and meta.get('chunk_size') == chunk_size):
            return name
    return None


def _download_cache(session, kind, site_id):
    """Path where a resumable download session caches its materialized export,
    or None when the client did not ask for one.

    Why a session id rather than plain ``Range`` against a freshly built
    export: pull/db and pull/code *materialize* their payload per request
    (mysqldump, ``tar czf``). Ranges taken from two different exports would
    assemble into a file that is neither. Pinning an export to a client-chosen
    session id makes the bytes stable for the life of that download, while a
    new pull still gets a brand-new export — no staleness, no cross-request
    corruption. Clients that send no session (v1) keep the old
    export-and-delete behavior exactly.
    """
    if not session or not _TRANSFER_ID.match(session):
        return None
    ddir = os.path.join(_transfer_root(), f'dl{session}')
    os.makedirs(ddir, exist_ok=True)
    return os.path.join(ddir, f'{kind}-{site_id}')


def _serve_export(path, download_name, session):
    """Send a materialized export, with Range support when it is session-cached.

    Without a session the file is deleted after the response (v1 behavior).
    With one it survives for the transfer TTL, and ``conditional=True`` gives
    Range/If-Range for free — a client resuming a dropped download re-requests
    only the tail, and a cache that has been reaped simply serves a 200 with
    the whole body, which the client handles by starting over.
    """
    if session:
        # Keep an actively-downloading session from being reaped mid-transfer.
        try:
            os.utime(path, None)
        except OSError:
            pass
    else:
        @after_this_request
        def _cleanup(response):
            try:
                os.remove(path)
            except OSError:
                pass
            return response

    return send_file(
        path,
        mimetype='application/gzip',
        as_attachment=True,
        download_name=download_name,
        conditional=True,
    )


def _expected_chunk_len(meta, offset):
    """Length the chunk at `offset` must have, or None if `offset` is not a
    chunk boundary of this transfer."""
    total, chunk_size = meta['total_bytes'], meta['chunk_size']
    if offset < 0 or offset >= total or offset % chunk_size != 0:
        return None
    return min(chunk_size, total - offset)


@localkit_bp.route('/push/<kind>/init', methods=['POST'])
@admin_required
def push_init(kind):
    """Open (or re-open) a chunked transfer and report what is already here.

    Resume lives entirely in the ``received`` array of this response: the
    client subtracts it from its own chunk plan, so a retry after a dropped
    connection re-sends only what was actually lost.
    """
    if kind not in ('code', 'db'):
        return jsonify({'error': 'Unknown transfer kind'}), 404
    svc, err = _require_wp_service()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    site, err = _resolve_site(data.get('site_id'))
    if err:
        return err

    sha256 = (data.get('sha256') or '').lower()
    if not _HEX64.match(sha256):
        return jsonify({'error': 'sha256 must be a hex-encoded SHA-256 digest'}), 400
    try:
        total_bytes = int(data.get('total_bytes'))
        chunk_size = int(data.get('chunk_size'))
    except (TypeError, ValueError):
        return jsonify({'error': 'total_bytes and chunk_size are required'}), 400
    if total_bytes < 0:
        return jsonify({'error': 'total_bytes must not be negative'}), 400
    if not 0 < chunk_size <= MAX_CHUNK_SIZE:
        return jsonify({'error': f'chunk_size must be between 1 and {MAX_CHUNK_SIZE}'}), 400

    _reap_stale_transfers()

    existing = _find_resumable(site.id, kind, sha256, total_bytes, chunk_size)
    if existing:
        tdir = _transfer_dir(existing)
        return jsonify({
            'transfer_id': existing,
            'chunk_size': chunk_size,
            'received': _received_offsets(tdir),
            'resumed': True,
        }), 200

    transfer_id = uuid.uuid4().hex
    tdir = _transfer_dir(transfer_id)
    os.makedirs(os.path.join(tdir, 'chunks'), exist_ok=True)
    meta = {
        'transfer_id': transfer_id,
        'site_id': site.id,
        'kind': kind,
        'total_bytes': total_bytes,
        'chunk_size': chunk_size,
        'sha256': sha256,
        'local_url': (data.get('local_url') or '').strip(),
        'filename': data.get('filename') or ('wp-content.tar.gz' if kind == 'code' else 'dump.sql'),
        'created': time.time(),
    }
    with open(os.path.join(tdir, 'meta.json'), 'w') as f:
        json.dump(meta, f)
    # Create the payload so chunk writes only ever have to seek into it.
    with open(os.path.join(tdir, 'payload'), 'wb'):
        pass

    return jsonify({
        'transfer_id': transfer_id,
        'chunk_size': chunk_size,
        'received': [],
        'resumed': False,
    }), 201


@localkit_bp.route('/push/<kind>/chunk', methods=['PUT'])
@admin_required
def push_chunk(kind):
    """Write one chunk into the transfer's payload file.

    Idempotent by design: re-sending a chunk that is already confirmed with the
    same hash is a 200 no-op, so a client that loses the response to a chunk it
    actually delivered can simply send it again.
    """
    transfer_id = request.args.get('transfer_id')
    meta, tdir = _load_meta(transfer_id)
    if not meta or meta.get('kind') != kind:
        return jsonify({'error': 'Unknown or expired transfer'}), 404

    try:
        offset = int(request.args.get('offset'))
    except (TypeError, ValueError):
        return jsonify({'error': 'offset is required'}), 400
    expected_len = _expected_chunk_len(meta, offset)
    if expected_len is None:
        return jsonify({'error': f'offset {offset} is not a chunk boundary of this transfer'}), 400

    sha256 = (request.args.get('sha256') or '').lower()
    if not _HEX64.match(sha256):
        return jsonify({'error': 'sha256 must be a hex-encoded SHA-256 digest'}), 400

    marker = os.path.join(tdir, 'chunks', str(offset))
    if os.path.exists(marker):
        try:
            with open(marker) as f:
                if f.read().strip() == sha256:
                    return jsonify({
                        'received': _received_offsets(tdir),
                        'duplicate': True,
                    }), 200
        except OSError:
            pass

    body = request.get_data()
    if len(body) != expected_len:
        return jsonify({
            'error': f'chunk at offset {offset} must be {expected_len} bytes, got {len(body)}'
        }), 400
    if hashlib.sha256(body).hexdigest() != sha256:
        return jsonify({'error': f'chunk at offset {offset} failed its checksum'}), 400

    payload = os.path.join(tdir, 'payload')
    try:
        # r+b keeps the bytes already written; the file is created at init.
        with open(payload, 'r+b') as f:
            f.seek(offset)
            f.write(body)
    except OSError as e:
        return jsonify({'error': f'failed to store chunk: {e}'}), 500

    # Marker last: a chunk is only "received" once its bytes are on disk, so a
    # crash mid-write costs one re-sent chunk rather than a corrupt payload.
    with open(marker, 'w') as f:
        f.write(sha256)

    return jsonify({'received': _received_offsets(tdir), 'duplicate': False}), 200


@localkit_bp.route('/push/<kind>/finish', methods=['POST'])
@admin_required
def push_finish(kind):
    """Verify the assembled payload and run the v1 processing path on it."""
    if kind not in ('code', 'db'):
        return jsonify({'error': 'Unknown transfer kind'}), 404
    svc, err = _require_wp_service()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    meta, tdir = _load_meta(data.get('transfer_id'))
    if not meta or meta.get('kind') != kind:
        return jsonify({'error': 'Unknown or expired transfer'}), 404

    # Missing chunks are a resumable condition, not a failure: report what is
    # here so the client can send the rest and call finish again.
    expected = list(range(0, meta['total_bytes'], meta['chunk_size']))
    received = _received_offsets(tdir)
    missing = [o for o in expected if o not in received]
    if missing:
        return jsonify({
            'error': f'{len(missing)} chunk(s) are still missing',
            'received': received,
            'missing': missing,
        }), 409

    payload = os.path.join(tdir, 'payload')
    digest = hashlib.sha256()
    try:
        with open(payload, 'rb') as f:
            for block in iter(lambda: f.read(1024 * 1024), b''):
                digest.update(block)
        size = os.path.getsize(payload)
    except OSError as e:
        _discard_transfer(tdir)
        return jsonify({'error': f'failed to read the assembled upload: {e}'}), 500

    if size != meta['total_bytes'] or digest.hexdigest() != meta['sha256']:
        # Unrecoverable: the bytes on disk are not the bytes the client meant
        # to send, and no amount of resuming fixes that. Start over.
        _discard_transfer(tdir)
        return jsonify({
            'error': 'The assembled upload failed its checksum — nothing was applied.'
        }), 400

    site, err = _resolve_site(meta.get('site_id'))
    if err:
        _discard_transfer(tdir)
        return err

    # Processing only ever runs here, on verified bytes — which is why an
    # abandoned transfer can never leave the site half-updated.
    if kind == 'code':
        result, status = _install_code(svc, site, payload)
    else:
        result, status = _import_db(svc, site, payload, meta.get('local_url'))

    # A processing failure keeps the transfer: the upload was fine, so a retry
    # should resume straight to finish instead of re-sending the whole payload.
    if status == 200:
        _discard_transfer(tdir)
    return jsonify(result), status


@localkit_bp.route('/pull/db', methods=['GET'])
@admin_required
def pull_db():
    """Stream a gzipped SQL dump of the site's database.

    ``?session=`` (plan 19) pins the export for the life of a resumable
    download; without it the behavior is exactly v1's export-and-delete.
    """
    site, err = _resolve_site(request.args.get('site_id'))
    if err:
        return err
    compose_file = _compose_file(site)
    if not compose_file:
        return jsonify({'error': 'Not a Docker-stack site (no docker-compose.yml)'}), 409

    session = request.args.get('session')
    download_name = f'{site.application.name}-db.sql.gz'

    cached = _download_cache(session, 'db', site.id)
    if cached and os.path.exists(cached) and os.path.getsize(cached) > 0:
        # A resumed range request: serve the same bytes the client started on.
        return _serve_export(cached, download_name, session)

    if cached:
        dump_path = cached
    else:
        fd, dump_path = tempfile.mkstemp(prefix='localkit_pull_', suffix='.sql.gz')
        os.close(fd)

    result = DatabaseSyncService.export_from_container(
        compose_path=compose_file,
        db_name='wordpress',
        db_user='root',
        db_password=_read_env_value(site.application.root_path, 'DB_PASSWORD'),
        output_path=dump_path,
        compress=True,
    )
    if not result.get('success'):
        try:
            os.remove(dump_path)
        except OSError:
            pass
        return jsonify({'error': f"Database export failed: {result.get('error')}"}), 500

    return _serve_export(dump_path, download_name, session)


@localkit_bp.route('/pull/code', methods=['GET'])
@admin_required
def pull_code():
    """Stream a tar.gz of the site's ``wp-content`` directory.

    The mirror image of ``POST /push/code``, and the missing half LocalKit's
    "import this site as a new local site" flow needs. The archive is built
    *inside* the container (``docker exec ... tar czf -``) rather than from the
    host: the site's files are container-owned, and tarring in place keeps
    permissions and directory structure intact. Entries are prefixed
    ``wp-content/``, exactly like the archive push/code accepts, so the two
    directions share one format.

    ``?session=`` (plan 19) pins the archive for the life of a resumable
    download — ranges taken from two different ``tar czf`` runs of a live site
    would not assemble into anything valid.
    """
    site, err = _resolve_site(request.args.get('site_id'))
    if err:
        return err
    container = site.application.name
    if not container:
        return jsonify({'error': 'Site has no container'}), 409

    session = request.args.get('session')
    download_name = f'{container}-wp-content.tar.gz'

    cached = _download_cache(session, 'code', site.id)
    if cached and os.path.exists(cached) and os.path.getsize(cached) > 0:
        return _serve_export(cached, download_name, session)

    if cached:
        archive_path = cached
        fd = os.open(archive_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    else:
        fd, archive_path = tempfile.mkstemp(prefix='localkit_pullcode_', suffix='.tar.gz')

    def _discard():
        try:
            os.remove(archive_path)
        except OSError:
            pass

    try:
        with os.fdopen(fd, 'wb') as out:
            proc = subprocess.run(
                ['docker', 'exec', container, 'tar', 'czf', '-',
                 '-C', '/var/www/html', 'wp-content'],
                stdout=out, stderr=subprocess.PIPE, timeout=900,
            )
    except (subprocess.SubprocessError, OSError) as e:
        _discard()
        return jsonify({'error': f'wp-content export failed: {e}'}), 500

    # GNU tar exits 1 for "file changed as we read it" — a live site writing
    # cache/uploads mid-archive is normal and the archive is still usable.
    stderr = (proc.stderr or b'').decode('utf-8', 'replace').strip()
    if proc.returncode not in (0, 1) or os.path.getsize(archive_path) == 0:
        _discard()
        return jsonify({
            'error': f'wp-content export failed: {stderr or "is the site running?"}'
        }), 500

    return _serve_export(archive_path, download_name, session)
