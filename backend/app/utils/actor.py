"""Optional identity attribution for best-effort service audit records."""


def current_actor_id():
    """Return the JWT/API-key owner ID, or None if unavailable.

    This helper is for attribution only, never for access control. Background
    jobs and audit callers without a request keep their existing None actor.
    """
    try:
        from app.middleware.rbac import get_current_user
        user = get_current_user()
        return user.id if user else None
    except Exception:
        return None
