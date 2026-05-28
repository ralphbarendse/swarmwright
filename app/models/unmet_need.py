from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

STATUS_OPEN = "open"
STATUS_DISMISSED = "dismissed"
STATUS_ADDRESSED = "addressed"


class UnmetNeed(Base):
    __tablename__ = "unmet_needs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    workspace_id: Mapped[str] = mapped_column(String, ForeignKey("workspaces.id"), nullable=False)
    session_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("chat_sessions.id"), nullable=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    verbatim_request: Mapped[str] = mapped_column(Text, nullable=False)
    concierge_summary: Mapped[str] = mapped_column(Text, nullable=False, default="")
    status: Mapped[str] = mapped_column(String, nullable=False, default=STATUS_OPEN)
    addressed_by_run_id: Mapped[str | None] = mapped_column(String, ForeignKey("runs.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "workspace_id": self.workspace_id,
            "session_id": self.session_id,
            "user_id": self.user_id,
            "verbatim_request": self.verbatim_request,
            "concierge_summary": self.concierge_summary,
            "status": self.status,
            "addressed_by_run_id": self.addressed_by_run_id,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
