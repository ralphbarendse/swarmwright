from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import String, Integer, DateTime, ForeignKey, Index, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

STEP_AGENT_CALL = "agent_call"
STEP_SKILL_CALL = "skill_call"
STEP_PERCEPTIONIST_CALL = "perceptionist_call"
STEP_HUMAN_ESCALATION = "human_escalation"
STEP_CALLER_CALL = "caller_call"         # Phase 6: agent traversed a `call` edge (blocks)
STEP_INFORMER_NOTIFY = "informer_notify" # Phase 6.1: agent traversed an `inform` edge (non-blocking)
STEP_SWARM_CALL = "swarm_call"           # Cross-swarm delegation
STEP_TOPOLOGY_VIOLATION = "topology_violation"


class RunStep(Base):
    __tablename__ = "run_steps"
    __table_args__ = (
        Index("ix_run_steps_run_id_sequence", "run_id", "sequence"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    run_id: Mapped[str] = mapped_column(String, ForeignKey("runs.id"), nullable=False)
    agent_id: Mapped[str | None] = mapped_column(String, ForeignKey("agents.id"), nullable=True)
    step_type: Mapped[str] = mapped_column(String, nullable=False)
    step_name: Mapped[str] = mapped_column(String, nullable=False)
    edge_purpose: Mapped[str | None] = mapped_column(String, nullable=True)
    caller_id: Mapped[str | None] = mapped_column(String, ForeignKey("callers.id"), nullable=True)
    informer_id: Mapped[str | None] = mapped_column(String, ForeignKey("informers.id"), nullable=True)
    input_json: Mapped[str] = mapped_column(String, nullable=False, default="{}")
    output_json: Mapped[str | None] = mapped_column(String, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    error: Mapped[str | None] = mapped_column(String, nullable=True)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    tokens_input: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tokens_output: Mapped[int | None] = mapped_column(Integer, nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "run_id": self.run_id,
            "agent_id": self.agent_id,
            "step_type": self.step_type,
            "step_name": self.step_name,
            "edge_purpose": self.edge_purpose,
            "caller_id": self.caller_id,
            "informer_id": self.informer_id,
            "sequence": self.sequence,
            "input": _parse_json_field(self.input_json),
            "output": _parse_json_field(self.output_json),
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "ended_at": self.ended_at.isoformat() if self.ended_at else None,
            "error": self.error,
            "tokens_input": self.tokens_input,
            "tokens_output": self.tokens_output,
        }


def _parse_json_field(value: str | None) -> object:
    if not value:
        return None
    try:
        import json
        return json.loads(value)
    except Exception:
        return value
