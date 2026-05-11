from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import String, Integer, DateTime, ForeignKey, Index, func, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

ORIGIN_AGENT = "agent"
ORIGIN_HUMAN = "human"
ORIGIN_UNKNOWN = "unknown"


class SwarmFile(Base):
    __tablename__ = "swarm_files"
    __table_args__ = (
        UniqueConstraint("swarm_id", "path", name="uq_swarm_file_path"),
        Index("ix_swarm_files_swarm_created", "swarm_id", "created_at"),
        Index("ix_swarm_files_run", "created_by_run_id"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    swarm_id: Mapped[str] = mapped_column(String, ForeignKey("swarms.id"), nullable=False)
    path: Mapped[str] = mapped_column(String, nullable=False)
    filename: Mapped[str] = mapped_column(String, nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    mime_type: Mapped[str | None] = mapped_column(String, nullable=True)
    checksum: Mapped[str] = mapped_column(String, nullable=False, default="")
    origin: Mapped[str] = mapped_column(String, nullable=False, default=ORIGIN_UNKNOWN)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)
    created_by_run_id: Mapped[str | None] = mapped_column(String, ForeignKey("runs.id"), nullable=True)
    created_by_step_id: Mapped[str | None] = mapped_column(String, ForeignKey("run_steps.id"), nullable=True)
    updated_by_run_id: Mapped[str | None] = mapped_column(String, ForeignKey("runs.id"), nullable=True)
    updated_by_step_id: Mapped[str | None] = mapped_column(String, ForeignKey("run_steps.id"), nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "swarm_id": self.swarm_id,
            "path": self.path,
            "filename": self.filename,
            "size_bytes": self.size_bytes,
            "mime_type": self.mime_type,
            "checksum": self.checksum,
            "origin": self.origin,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "created_by_run_id": self.created_by_run_id,
            "created_by_step_id": self.created_by_step_id,
            "updated_by_run_id": self.updated_by_run_id,
            "updated_by_step_id": self.updated_by_step_id,
        }
