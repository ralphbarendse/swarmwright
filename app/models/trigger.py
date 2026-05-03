from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import String, Boolean, DateTime, ForeignKey, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

KIND_HEARTBEAT = "heartbeat"
KIND_LISTENER = "listener"
KIND_INVOCATION = "invocation"


class Trigger(Base):
    __tablename__ = "triggers"
    __table_args__ = (UniqueConstraint("swarm_id", "name", name="uq_trigger_swarm_name"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    swarm_id: Mapped[str] = mapped_column(String, ForeignKey("swarms.id"), nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False)         # heartbeat | listener | invocation
    config_json: Mapped[str] = mapped_column(String, nullable=False, default="{}")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    watermark: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    def to_dict(self) -> dict:
        # Parse config_json so the frontend gets `config` as a real dict
        # (target_agent, default_payload, schedule, endpoint, etc.). Without
        # this the canvas can't see persisted trigger settings on reload.
        try:
            import json as _json
            config = _json.loads(self.config_json or "{}")
        except (TypeError, ValueError):
            config = {}
        return {
            "id": self.id,
            "swarm_id": self.swarm_id,
            "name": self.name,
            "kind": self.kind,
            "config": config,
            "enabled": self.enabled,
            "watermark": self.watermark,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
