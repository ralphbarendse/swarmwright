"""Informer registry — Phase 6.1.

An Informer is a human role that agents can notify without pausing the run.
Unlike a Caller (which suspends execution until the human decides), an Informer
receives fire-and-forget messages that land in the Inbox as read-only cards.

Files on disk live at `data/<scope>/informers/<name>.md` (scope-aware via the
existing resolver). Frontmatter is identity (display name, contacts); the body
is the briefing the human sees alongside the notification payload.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import String, Boolean, DateTime, ForeignKey, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Informer(Base):
    __tablename__ = "informers"
    __table_args__ = (
        UniqueConstraint("scope", "workspace_id", "swarm_id", "name", name="uq_informer_scope_name"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    swarm_id: Mapped[str | None] = mapped_column(String, ForeignKey("swarms.id"), nullable=True)
    workspace_id: Mapped[str | None] = mapped_column(String, ForeignKey("workspaces.id"), nullable=True)
    scope: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    display_name: Mapped[str] = mapped_column(String, nullable=False)
    md_path: Mapped[str] = mapped_column(String, nullable=False)
    md_hash: Mapped[str] = mapped_column(String, nullable=False, default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "swarm_id": self.swarm_id,
            "workspace_id": self.workspace_id,
            "scope": self.scope,
            "name": self.name,
            "display_name": self.display_name,
            "md_path": self.md_path,
            "enabled": self.enabled,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
