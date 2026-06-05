from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

SCOPE_ORG = "org"
SCOPE_WORKSPACE = "workspace"

# Default titles a session keeps until its first user message names it.
DEFAULT_TITLES = {"New conversation", "Operator", "Concierge"}


class ChatSession(Base):
    __tablename__ = "chat_sessions"
    # No unique constraint on (user, scope, workspace): a user keeps a history of
    # multiple conversations per scope. See migration d1e6a4b9c273.

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    scope: Mapped[str] = mapped_column(String, nullable=False)
    workspace_id: Mapped[str | None] = mapped_column(String, ForeignKey("workspaces.id"), nullable=True)
    title: Mapped[str] = mapped_column(String, nullable=False, default="New conversation")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "user_id": self.user_id,
            "scope": self.scope,
            "workspace_id": self.workspace_id,
            "title": self.title,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
