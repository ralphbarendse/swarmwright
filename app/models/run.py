from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

STATUS_PENDING = "pending"
STATUS_RUNNING = "running"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"
STATUS_AWAITING_HUMAN = "awaiting_human"   # Phase 6 — paused on a `call` edge


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    event_id: Mapped[str] = mapped_column(String, ForeignKey("events.id"), nullable=False)
    swarm_id: Mapped[str] = mapped_column(String, ForeignKey("swarms.id"), nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, default=STATUS_PENDING)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    error: Mapped[str | None] = mapped_column(String, nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "event_id": self.event_id,
            "swarm_id": self.swarm_id,
            "status": self.status,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "ended_at": self.ended_at.isoformat() if self.ended_at else None,
            "error": self.error,
        }
