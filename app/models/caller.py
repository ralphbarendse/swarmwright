"""Caller registry — Phase 6.

A Caller is a fifth node type alongside agents, skills, perceptionists, and
triggers. It represents a *human role* in the swarm topology — a reviewer or
approver an agent can ask via a `call` edge in `hierarchy.json`. The Caller
itself never makes an LLM call; it routes a question to the Inbox where a
human responds.

Files on disk live at `data/<scope>/callers/<name>.md` (scope-aware via the
existing resolver). The frontmatter is identity (display name, contacts,
escalation policy); the body is the briefing the human sees in the Inbox.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import String, Boolean, DateTime, ForeignKey, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

# Valid timeout actions for a Caller (when SLAs ship in a later phase).
TIMEOUT_DEFER = "defer"
TIMEOUT_REJECT = "reject"
TIMEOUT_APPROVE = "approve"
VALID_TIMEOUT_ACTIONS = {TIMEOUT_DEFER, TIMEOUT_REJECT, TIMEOUT_APPROVE}


class Caller(Base):
    __tablename__ = "callers"
    __table_args__ = (
        UniqueConstraint("scope", "workspace_id", "swarm_id", "name", name="uq_caller_scope_name"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    swarm_id: Mapped[str | None] = mapped_column(String, ForeignKey("swarms.id"), nullable=True)
    workspace_id: Mapped[str | None] = mapped_column(String, ForeignKey("workspaces.id"), nullable=True)
    scope: Mapped[str] = mapped_column(String, nullable=False)              # company | workspace | swarm
    name: Mapped[str] = mapped_column(String, nullable=False)               # filename without .md
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
