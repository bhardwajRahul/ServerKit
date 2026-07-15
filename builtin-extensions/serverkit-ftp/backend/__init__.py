"""ServerKit FTP extension backend package.

Extracted from core (plan 47): the FTP blueprint + service ship here so a fresh
panel that never touches FTP loads none of it. Mounted under ``/api/v1/ftp`` via
the manifest's ``url_prefix``; upgrades re-acquire it automatically
(``CONVERTED_BUILTIN_SLUGS``).
"""
from .ftp import ftp_bp

__all__ = ['ftp_bp']
