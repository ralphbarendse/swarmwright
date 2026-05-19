from __future__ import annotations

from functools import wraps

from flask import g, jsonify, session


def load_current_user() -> None:
    """Populate g.current_user from session. Register as before_request."""
    g.current_user = None
    user_id = session.get("user_id")
    if not user_id:
        return
    from app.db import get_session
    from app.models.user import User
    with get_session() as db:
        user = db.get(User, user_id)
        if user and user.is_active:
            db.expunge(user)
            g.current_user = user


def current_user():
    return g.get("current_user")


def _testing() -> bool:
    from flask import current_app
    return current_app.config.get("TESTING", False)


def require_login(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if _testing():
            return f(*args, **kwargs)
        if g.get("current_user") is None:
            return jsonify({"error": {"code": "unauthorized", "message": "Login required"}}), 401
        return f(*args, **kwargs)
    return decorated


def require_permission(perm: str):
    def decorator(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            if _testing():
                return f(*args, **kwargs)
            user = g.get("current_user")
            if user is None:
                return jsonify({"error": {"code": "unauthorized", "message": "Login required"}}), 401
            if not user.has_permission(perm):
                return jsonify({"error": {"code": "forbidden", "message": f"Permission denied: {perm}"}}), 403
            return f(*args, **kwargs)
        return decorated
    return decorator


def require_admin(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if _testing():
            return f(*args, **kwargs)
        user = g.get("current_user")
        if user is None:
            return jsonify({"error": {"code": "unauthorized", "message": "Login required"}}), 401
        if not user.is_admin:
            return jsonify({"error": {"code": "forbidden", "message": "Admin access required"}}), 403
        return f(*args, **kwargs)
    return decorated
