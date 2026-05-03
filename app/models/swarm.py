from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, ForeignKey, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Swarm(Base):
    __tablename__ = "swarms"
    __table_args__ = (UniqueConstraint("workspace_id", "name", name="uq_swarm_workspace_name"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    workspace_id: Mapped[str] = mapped_column(String, ForeignKey("workspaces.id"), nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    display_name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str | None] = mapped_column(String, nullable=True)
    icon: Mapped[str | None] = mapped_column(String, nullable=True)
    meta_hash: Mapped[str] = mapped_column(String, nullable=False, default="")
    hierarchy_hash: Mapped[str] = mapped_column(String, nullable=False, default="")
    enabled: Mapped[bool] = mapped_column(default=True, nullable=False)
    validation_error: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "workspace_id": self.workspace_id,
            "name": self.name,
            "display_name": self.display_name,
            "description": self.description,
            "enabled": self.enabled,
            "validation_error": self.validation_error,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
