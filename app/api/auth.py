from __future__ import annotations

from flask import Blueprint, g, jsonify, request, session
from sqlalchemy import func, select
from werkzeug.security import check_password_hash, generate_password_hash

from app.db import get_session
from app.models.user import User

bp = Blueprint("auth", __name__, url_prefix="/api/v1/auth")


@bp.post("/login")
def login():
    body = request.get_json(force=True) or {}
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""

    if not username or not password:
        return jsonify({"error": {"code": "validation_error", "message": "username and password required"}}), 400

    with get_session() as db:
        user = db.execute(
            select(User).where(User.username == username, User.is_active.is_(True))
        ).scalar_one_or_none()
        if not user or not check_password_hash(user.password_hash, password):
            return jsonify({"error": {"code": "invalid_credentials", "message": "Invalid username or password"}}), 401
        db.expunge(user)

    session.clear()
    session["user_id"] = user.id
    session.permanent = True

    return jsonify({"user": user.to_dict(include_permissions=True)})


@bp.post("/logout")
def logout():
    session.clear()
    return "", 204


@bp.get("/me")
def me():
    user = g.get("current_user")
    if user is None:
        return jsonify({"error": {"code": "unauthorized", "message": "Not logged in"}}), 401
    return jsonify({"user": user.to_dict(include_permissions=True)})


@bp.post("/setup")
def setup():
    """Create the first admin user. Only callable when no users exist."""
    with get_session() as db:
        count = db.execute(select(func.count(User.id))).scalar() or 0
    if count > 0:
        return jsonify({"error": {"code": "already_setup", "message": "Already set up"}}), 409

    body = request.get_json(force=True) or {}
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    display_name = (body.get("display_name") or "").strip() or None

    if len(username) < 2:
        return jsonify({"error": {"code": "validation_error", "message": "Username must be at least 2 characters"}}), 400
    if len(password) < 8:
        return jsonify({"error": {"code": "validation_error", "message": "Password must be at least 8 characters"}}), 400

    with get_session() as db:
        # Re-check inside same session to guard against races
        count = db.execute(select(func.count(User.id))).scalar() or 0
        if count > 0:
            return jsonify({"error": {"code": "already_setup", "message": "Already set up"}}), 409
        user = User(
            username=username,
            display_name=display_name,
            password_hash=generate_password_hash(password),
            is_admin=True,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        db.expunge(user)

    session.clear()
    session["user_id"] = user.id
    session.permanent = True

    return jsonify({"user": user.to_dict(include_permissions=True)}), 201
