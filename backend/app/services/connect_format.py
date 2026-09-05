"""Serialization shared by Connect protocol snapshots."""

from datetime import datetime, timezone


def iso_datetime(value):
    """Preserve strings; serialize naive panel timestamps as UTC."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return None
