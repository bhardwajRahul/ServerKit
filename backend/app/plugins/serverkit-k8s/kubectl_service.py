"""Low-level ``kubectl`` engine for the serverkit-k8s extension.

Every cluster operation runs the real ``kubectl`` binary against a per-cluster
kubeconfig that we materialize to a private temp file for the duration of one
call and delete immediately after (never left on disk between calls). This keeps
the panel host free of any standing cluster credentials.

Nothing here is Linux-specific -- ``kubectl`` runs on any OS -- so the extension
is not platform-gated. The temp-file ``chmod 0600`` is guarded with
``os.name != 'nt'`` per the repo's platform rule.
"""
import json
import logging
import os
import subprocess
import tempfile

logger = logging.getLogger(__name__)

KUBECTL_BIN = 'kubectl'
DEFAULT_TIMEOUT = 30


class KubectlError(RuntimeError):
    """Raised when a kubectl invocation fails (non-zero exit)."""

    def __init__(self, message, returncode=None, stderr=None):
        super().__init__(message)
        self.returncode = returncode
        self.stderr = stderr


def is_available():
    """Return True if the ``kubectl`` binary is on the host."""
    try:
        from app.utils.system import is_command_available
        return is_command_available(KUBECTL_BIN)
    except Exception:  # pragma: no cover - fall back to a direct probe
        from shutil import which
        return which(KUBECTL_BIN) is not None


def _write_kubeconfig(kubeconfig_text):
    """Write *kubeconfig_text* to a private temp file and return its path."""
    fd, path = tempfile.mkstemp(prefix='sk8s-', suffix='.yaml')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            fh.write(kubeconfig_text or '')
        if os.name != 'nt':
            os.chmod(path, 0o600)
    except Exception:
        _safe_unlink(path)
        raise
    return path


def _safe_unlink(path):
    try:
        if path and os.path.exists(path):
            os.unlink(path)
    except OSError as e:  # pragma: no cover - best effort cleanup
        logger.warning('serverkit-k8s: could not remove temp kubeconfig %s: %s', path, e)


def build_argv(cluster, args):
    """Return the full ``kubectl`` argv for *args* against *cluster*.

    Separated out so tests can assert on argv construction without running the
    binary. The ``--kubeconfig`` path is appended by :func:`run` since it is only
    known once the temp file is written.
    """
    argv = [KUBECTL_BIN]
    if getattr(cluster, 'context', None):
        argv += ['--context', cluster.context]
    return argv + list(args)


def run(cluster, args, timeout=DEFAULT_TIMEOUT, input_text=None):
    """Run ``kubectl <args>`` against *cluster* and return stdout as a string.

    Raises :class:`KubectlError` on a non-zero exit or missing binary.
    """
    if not is_available():
        raise KubectlError('kubectl is not installed on the panel host.')

    kubeconfig_text = cluster.get_kubeconfig() if hasattr(cluster, 'get_kubeconfig') else cluster
    path = _write_kubeconfig(kubeconfig_text)
    try:
        argv = build_argv(cluster, args)
        argv += ['--kubeconfig', path]
        try:
            result = subprocess.run(
                argv,
                capture_output=True,
                text=True,
                timeout=timeout,
                input=input_text,
            )
        except subprocess.TimeoutExpired as e:
            raise KubectlError(f'kubectl timed out after {timeout}s') from e
        except (OSError, subprocess.SubprocessError) as e:
            raise KubectlError(f'kubectl could not be executed: {e}') from e

        if result.returncode != 0:
            stderr = (result.stderr or '').strip()
            raise KubectlError(
                stderr or f'kubectl exited with code {result.returncode}',
                returncode=result.returncode,
                stderr=stderr,
            )
        return result.stdout or ''
    finally:
        _safe_unlink(path)


def run_json(cluster, args, timeout=DEFAULT_TIMEOUT):
    """Run a kubectl command that emits JSON and return the parsed object.

    The caller is expected to include ``-o json`` (or a get with it) in *args*.
    """
    out = run(cluster, args, timeout=timeout)
    if not out.strip():
        return {}
    try:
        return json.loads(out)
    except ValueError as e:
        raise KubectlError(f'kubectl returned unparseable JSON: {e}') from e
