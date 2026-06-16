"""Outbound SMTP relay (smarthost) for the mail server.

Persists a single relay configuration (host/port/credentials, password
Fernet-encrypted) and applies it to Postfix when present. The config is stored
platform-agnostically so the dev panel can hold it; the Postfix apply is a no-op
(with a note) on hosts where Postfix isn't installed. `test()` opens a real SMTP
connection so credentials are validated on any OS.
"""

import ssl
import smtplib
import logging

from app import db
from app.models.email import EmailRelayConfig
from app.services.postfix_service import PostfixService
from app.utils.crypto import encrypt_secret, decrypt_secret

logger = logging.getLogger(__name__)


def _is_masked(value):
    """True for our masking sentinels, so a round-tripped masked value never
    overwrites the stored secret."""
    if not value:
        return False
    return value.startswith('****') or set(value) == {'*'}


class EmailRelayService:
    DEFAULT = {
        'enabled': False, 'host': '', 'port': 587, 'username': '',
        'use_tls': True, 'provider_hint': None, 'password_set': False,
    }

    @staticmethod
    def _row():
        return EmailRelayConfig.query.first()

    @classmethod
    def get_config(cls):
        row = cls._row()
        return row.to_dict() if row else dict(cls.DEFAULT)

    @classmethod
    def save_config(cls, data):
        row = cls._row() or EmailRelayConfig()
        row.host = (data.get('host') or '').strip()
        try:
            row.port = int(data.get('port') or 587)
        except (TypeError, ValueError):
            row.port = 587
        row.username = (data.get('username') or '').strip()
        row.use_tls = bool(data.get('use_tls', True))
        row.enabled = bool(data.get('enabled', True))
        row.provider_hint = data.get('provider_hint')
        pw = data.get('password')
        if pw and not _is_masked(pw):
            row.password_encrypted = encrypt_secret(pw)
        if row.id is None:
            db.session.add(row)
        db.session.commit()
        return {'config': row.to_dict(), 'apply': cls.apply(row)}

    @classmethod
    def apply(cls, row=None):
        """Push the stored config to Postfix (if installed)."""
        row = row or cls._row()
        if not row:
            return {'applied': False, 'note': 'No relay configured'}
        status = PostfixService.get_status()
        if not status.get('installed'):
            return {'applied': False, 'note': 'Saved. Postfix is not installed here — the relay applies on a configured mail server.'}
        if row.enabled and row.host:
            password = decrypt_secret(row.password_encrypted) if row.password_encrypted else ''
            result = PostfixService.configure_relay(row.host, row.port, row.username, password, row.use_tls)
        else:
            result = PostfixService.disable_relay()
        result['applied'] = result.get('success', False)
        return result

    @classmethod
    def disable(cls):
        row = cls._row()
        if row:
            row.enabled = False
            db.session.commit()
        return cls.apply(row)

    @classmethod
    def test(cls, data):
        """Open a real SMTP connection to validate host/port/credentials."""
        row = cls._row()
        host = (data.get('host') or (row.host if row else '') or '').strip()
        if not host:
            return {'success': False, 'error': 'A relay host is required'}
        try:
            port = int(data.get('port') or (row.port if row else 587))
        except (TypeError, ValueError):
            port = 587
        username = data.get('username') or (row.username if row else '')
        use_tls = data.get('use_tls', row.use_tls if row else True)
        password = data.get('password')
        if password and _is_masked(password):
            password = None
        if not password and row and row.password_encrypted:
            password = decrypt_secret(row.password_encrypted)

        try:
            if port == 465:
                server = smtplib.SMTP_SSL(host, port, timeout=15)
            else:
                server = smtplib.SMTP(host, port, timeout=15)
                server.ehlo()
                if use_tls:
                    server.starttls(context=ssl.create_default_context())
                    server.ehlo()
            if username:
                server.login(username, password or '')
            server.quit()
            return {'success': True, 'message': f'Connected to {host}:{port}'}
        except Exception as e:
            return {'success': False, 'error': str(e)}
