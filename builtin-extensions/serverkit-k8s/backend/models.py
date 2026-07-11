"""Data models for the serverkit-k8s extension.

A :class:`K8sCluster` row is a saved *connection* to an external Kubernetes
cluster: a friendly name, the cluster's **kubeconfig** (stored encrypted with the
panel key), an optional context to select within that kubeconfig, a default flag,
and a small cache of the last reachability probe so the Overview can render
without blocking on a live ``kubectl`` call.

The panel host is never assumed to be a cluster member. All cluster access goes
through ``kubectl --kubeconfig <the decrypted blob>`` (see ``kubectl_service``),
so the only secret we hold is the kubeconfig, and it is **never** returned by
:meth:`K8sCluster.to_dict`.

Tables are namespaced ``ext_serverkit_k8s_*`` (dash -> underscore) per the
extension convention, so ``--purge`` on uninstall drops exactly these.

Registration: importing this module defines the table on the shared metadata as
a side effect; the manifest's ``models: "models:register"`` then calls
:func:`register` (a no-op passthrough) and the platform runs ``db.create_all()``.
"""
import json
from datetime import datetime

from app import db

try:
    from app.utils.crypto import encrypt_secret, decrypt_secret_safe
except Exception:  # pragma: no cover - crypto util should always be present
    encrypt_secret = None
    decrypt_secret_safe = None


class K8sCluster(db.Model):
    __tablename__ = 'ext_serverkit_k8s_clusters'

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), unique=True, nullable=False, index=True)

    # Encrypted kubeconfig YAML. Read/written only through the helpers below so
    # the plaintext never lands in a column or a log line.
    kubeconfig_encrypted = db.Column(db.Text, nullable=False)

    # Optional context to select inside the kubeconfig (kubectl --context).
    context = db.Column(db.String(255), nullable=True)

    is_default = db.Column(db.Boolean, default=False, nullable=False)

    # Cached result of the last reachability probe (test_connection).
    last_reachable = db.Column(db.Boolean, nullable=True)
    last_status = db.Column(db.Text, nullable=True)  # JSON: {server_version, error}
    last_checked_at = db.Column(db.DateTime, nullable=True)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # --- secret helpers -------------------------------------------------
    def set_kubeconfig(self, plaintext):
        """Encrypt and store a kubeconfig YAML string."""
        if encrypt_secret is None:
            # No key configured: store as-is so dev boxes still work. Encryption
            # is expected in any real deployment.
            self.kubeconfig_encrypted = plaintext or ''
        else:
            self.kubeconfig_encrypted = encrypt_secret(plaintext or '')

    def get_kubeconfig(self):
        """Return the decrypted kubeconfig YAML string."""
        if not self.kubeconfig_encrypted:
            return ''
        if decrypt_secret_safe is None:
            return self.kubeconfig_encrypted
        return decrypt_secret_safe(self.kubeconfig_encrypted)

    # --- serialization --------------------------------------------------
    def to_dict(self):
        status = None
        if self.last_status:
            try:
                status = json.loads(self.last_status)
            except (ValueError, TypeError):
                status = None
        return {
            'id': self.id,
            'name': self.name,
            'context': self.context,
            'is_default': self.is_default,
            'last_reachable': self.last_reachable,
            'status': status,
            'last_checked_at': self.last_checked_at.isoformat() if self.last_checked_at else None,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None,
        }


def register(db):  # noqa: A002 - signature dictated by the platform (fn(db))
    """No-op passthrough required by the manifest ``models: "models:register"``.

    Importing this module already defined the table on ``db.metadata``; the
    platform creates it. Nothing else to do here.
    """
    return [K8sCluster]
