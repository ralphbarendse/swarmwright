"""Human inform queue — Phase 6.1.

When a runtime traverses an `inform` edge, it persists a `HumanInform` row and
immediately continues — the run is NOT suspended. The Inbox UI shows inform
cards alongside call cards; unlike calls, informs need no decision, just
acknowledgment (read or dismiss).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, ForeignKey, Index, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

STATUS_UNREAD = "unread"
STATUS_READ = "read"
STATUS_DISMISSED = "dismissed"
VALID_STATUSES = {STATUS_UNREAD, STATUS_READ, STATUS_DISMISSED}


class HumanInform(Base):
    __tablename__ = "human_informs"
    __table_args__ = (
        Index("ix_human_informs_status", "status"),
        Index("ix_human_informs_informer_status", "informer_id", "status"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    run_id: Mapped[str] = mapped_column(String, ForeignKey("runs.id"), nullable=False)
    step_id: Mapped[str] = mapped_column(String, ForeignKey("run_steps.id"), nullable=False)
    informer_id: Mapped[str] = mapped_column(String, ForeignKey("informers.id"), nullable=False)
    purpose: Mapped[str] = mapped_column(String, nullable=False)
    payload_json: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, default=STATUS_UNREAD)
    read_by: Mapped[str | None] = mapped_column(String, nullable=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    def to_dict(self) -> dict:
        import json
        return {
            "id": self.id,
            "run_id": self.run_id,
            "step_id": self.step_id,
            "informer_id": self.informer_id,
            "purpose": self.purpose,
            "payload": _safe_load(self.payload_json),
            "status": self.status,
            "read_by": self.read_by,
            "read_at": self.read_at.isoformat() if self.read_at else None,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


def _safe_load(s: str | None):
    if not s:
        return None
    try:
        import json
        return json.loads(s)
    except (ValueError, TypeError):
        return s
