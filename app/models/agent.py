from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import String, Boolean, DateTime, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

# Valid values for the scope column
SCOPE_COMPANY = "company"
SCOPE_WORKSPACE = "workspace"
SCOPE_SWARM = "swarm"

# Valid values for the layer column
LAYER_POLICY = "policy"
LAYER_ORCHESTRATOR = "orchestrator"
LAYER_EXECUTIONER = "executioner"
LAYER_PERCEPTIONIST = "perceptionist"


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    swarm_id: Mapped[str | None] = mapped_column(String, ForeignKey("swarms.id"), nullable=True)
    workspace_id: Mapped[str | None] = mapped_column(String, ForeignKey("workspaces.id"), nullable=True)
    scope: Mapped[str] = mapped_column(String, nullable=False)        # company | workspace | swarm
    name: Mapped[str] = mapped_column(String, nullable=False)         # filename without .md
    layer: Mapped[str] = mapped_column(String, nullable=False)        # policy | orchestrator | executioner | perceptionist
    model: Mapped[str | None] = mapped_column(String, nullable=True)
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
            "layer": self.layer,
            "model": self.model,
            "md_path": self.md_path,
            "enabled": self.enabled,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
