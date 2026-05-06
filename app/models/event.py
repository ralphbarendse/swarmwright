from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Event(Base):
    __tablename__ = "events"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    swarm_id: Mapped[str] = mapped_column(String, ForeignKey("swarms.id"), nullable=False)
    trigger_id: Mapped[str | None] = mapped_column(String, ForeignKey("triggers.id"), nullable=True)
    source: Mapped[str] = mapped_column(String, nullable=False)       # heartbeat | listener | invocation | api
    payload_json: Mapped[str] = mapped_column(String, nullable=False, default="{}")
    received_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    def to_dict(self) -> dict:
        import json
        try:
            payload = json.loads(self.payload_json or "{}")
        except Exception:
            payload = {}
        return {
            "id": self.id,
            "swarm_id": self.swarm_id,
            "trigger_id": self.trigger_id,
            "source": self.source,
            "payload": payload,
            "received_at": self.received_at.isoformat() if self.received_at else None,
        }
