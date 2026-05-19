from __future__ import annotations

import json

from flask import Blueprint, g, jsonify, request
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from werkzeug.security import generate_password_hash

from app.core.auth import require_admin
from app.db import get_session
from app.models.user import ALL_PERMISSIONS, DEFAULT_USER_PERMISSIONS, User

bp = Blueprint("users", __name__, url_prefix="/api/v1/users")


class UserCreate(BaseModel):
    username: str
    password: str
    display_name: str | None = None
    email: str | None = None
    is_admin: bool = False
    permissions: dict[str, bool] | None = None

    @field_validator("username")
    @classmethod
    def username_valid(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 2:
            raise ValueError("username must be at least 2 characters")
        return v

    @field_validator("password")
    @classmethod
    def password_valid(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("password must be at least 8 characters")
        return v


class UserUpdate(BaseModel):
    display_name: str | None = None
    email: str | None = None
    is_admin: bool | None = None
    is_active: bool | None = None
    permissions: dict[str, bool] | None = None
    password: str | None = None

    @field_validator("password")
    @classmethod
    def password_valid(cls, v: str | None) -> str | None:
        if v is not None and len(v) < 8:
            raise ValueError("password must be at least 8 characters")
        return v


@bp.get("")
@require_admin
def list_users():
    with get_session() as db:
        users = db.execute(select(User).order_by(User.created_at)).scalars().all()
        return jsonify([u.to_dict(include_permissions=True) for u in users])


@bp.get("/<user_id>")
@require_admin
def get_user(user_id: str):
    with get_session() as db:
        user = db.get(User, user_id)
        if not user:
            return jsonify({"error": {"code": "not_found", "message": "User not found"}}), 404
        return jsonify(user.to_dict(include_permissions=True))


@bp.post("")
@require_admin
def create_user():
    try:
        body = UserCreate.model_validate(request.get_json(force=True) or {})
    except Exception as exc:
        return jsonify({"error": {"code": "validation_error", "message": str(exc)}}), 400

    with get_session() as db:
        if db.execute(select(User).where(User.username == body.username)).scalar_one_or_none():
            return jsonify({"error": {"code": "conflict", "message": "Username already taken"}}), 409

        perms = body.permissions if body.permissions is not None else dict(DEFAULT_USER_PERMISSIONS)
        perms = {k: bool(v) for k, v in perms.items() if k in ALL_PERMISSIONS}

        user = User(
            username=body.username,
            display_name=body.display_name,
            email=body.email,
            password_hash=generate_password_hash(body.password),
            is_admin=body.is_admin,
            permissions_json=None if body.is_admin else json.dumps(perms),
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return jsonify(user.to_dict(include_permissions=True)), 201


@bp.put("/<user_id>")
@require_admin
def update_user(user_id: str):
    try:
        body = UserUpdate.model_validate(request.get_json(force=True) or {})
    except Exception as exc:
        return jsonify({"error": {"code": "validation_error", "message": str(exc)}}), 400

    caller = g.get("current_user")

    with get_session() as db:
        user = db.get(User, user_id)
        if not user:
            return jsonify({"error": {"code": "not_found", "message": "User not found"}}), 404

        if caller and caller.id == user_id:
            if body.is_admin is False:
                return jsonify({"error": {"code": "forbidden", "message": "Cannot remove own admin status"}}), 403
            if body.is_active is False:
                return jsonify({"error": {"code": "forbidden", "message": "Cannot deactivate own account"}}), 403

        if body.display_name is not None:
            user.display_name = body.display_name
        if body.email is not None:
            user.email = body.email
        if body.is_admin is not None:
            user.is_admin = body.is_admin
        if body.is_active is not None:
            user.is_active = body.is_active
        if body.password is not None:
            user.password_hash = generate_password_hash(body.password)
        if body.permissions is not None and not user.is_admin:
            perms = {k: bool(v) for k, v in body.permissions.items() if k in ALL_PERMISSIONS}
            user.permissions_json = json.dumps(perms)

        db.commit()
        db.refresh(user)
        return jsonify(user.to_dict(include_permissions=True))


@bp.delete("/<user_id>")
@require_admin
def delete_user(user_id: str):
    caller = g.get("current_user")
    if caller and caller.id == user_id:
        return jsonify({"error": {"code": "forbidden", "message": "Cannot delete own account"}}), 403

    with get_session() as db:
        user = db.get(User, user_id)
        if not user:
            return jsonify({"error": {"code": "not_found", "message": "User not found"}}), 404
        db.delete(user)
        db.commit()
    return "", 204
