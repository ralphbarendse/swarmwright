from __future__ import annotations

import json
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

ALL_PERMISSIONS = [
    "can_create_workspace",
    "can_edit_workspace",
    "can_delete_workspace",
    "can_create_swarm",
    "can_edit_swarm",
    "can_delete_swarm",
    "can_start_run",
    "can_stop_run",
    "can_edit_constitution",
    "can_manage_triggers",
    "can_manage_skills",
    "can_manage_knowledge",
    "can_decide_inbox",
    "can_view_settings",
    "can_manage_users",
    "can_chat_workspace",
    "can_chat_operator",
    "can_read_files",
    "can_write_files",
]

DEFAULT_USER_PERMISSIONS: dict[str, bool] = {
    "can_create_workspace": False,
    "can_edit_workspace": False,
    "can_delete_workspace": False,
    "can_create_swarm": False,
    "can_edit_swarm": False,
    "can_delete_swarm": False,
    "can_start_run": True,
    "can_stop_run": True,
    "can_edit_constitution": False,
    "can_manage_triggers": False,
    "can_manage_skills": False,
    "can_manage_knowledge": False,
    "can_decide_inbox": True,
    "can_view_settings": False,
    "can_manage_users": False,
    "can_chat_workspace": True,
    "can_chat_operator": False,
    "can_read_files": True,
    "can_write_files": False,
}


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    username: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    display_name: Mapped[str | None] = mapped_column(String, nullable=True)
    email: Mapped[str | None] = mapped_column(String, nullable=True)
    password_hash: Mapped[str] = mapped_column(String, nullable=False)
    is_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    permissions_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )

    def get_permissions(self) -> dict[str, bool]:
        if self.is_admin:
            return {p: True for p in ALL_PERMISSIONS}
        stored = json.loads(self.permissions_json) if self.permissions_json else {}
        return {**DEFAULT_USER_PERMISSIONS, **stored}

    def has_permission(self, perm: str) -> bool:
        if self.is_admin:
            return True
        return self.get_permissions().get(perm, False)

    def to_dict(self, include_permissions: bool = False) -> dict:
        d: dict = {
            "id": self.id,
            "username": self.username,
            "display_name": self.display_name,
            "email": self.email,
            "is_admin": self.is_admin,
            "is_active": self.is_active,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
        if include_permissions:
            d["permissions"] = self.get_permissions()
        return d
