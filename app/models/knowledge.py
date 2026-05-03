from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import String, Integer, DateTime, ForeignKey, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class KnowledgeDocument(Base):
    __tablename__ = "knowledge_documents"
    __table_args__ = (
        UniqueConstraint("scope", "workspace_id", "swarm_id", "name", name="uq_knowledge_scope_name"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    scope: Mapped[str] = mapped_column(String, nullable=False)            # company | workspace | swarm
    workspace_id: Mapped[str | None] = mapped_column(String, ForeignKey("workspaces.id"), nullable=True)
    swarm_id: Mapped[str | None] = mapped_column(String, ForeignKey("swarms.id"), nullable=True)
    name: Mapped[str] = mapped_column(String, nullable=False)             # filename without .md
    md_path: Mapped[str] = mapped_column(String, nullable=False)
    md_hash: Mapped[str] = mapped_column(String, nullable=False, default="")
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    title: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "scope": self.scope,
            "workspace_id": self.workspace_id,
            "swarm_id": self.swarm_id,
            "name": self.name,
            "md_path": self.md_path,
            "size_bytes": self.size_bytes,
            "title": self.title,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
