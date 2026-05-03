"""Human-action queue — Phase 6.

When a runtime traverses a `call` edge, it persists a `HumanAction` row,
sets `runs.status='awaiting_human'`, and suspends. The Inbox UI reads from
this table; an approve/reject API writes the decision back and resumes the
run via the existing event bus.

Stores hashes? No. The audit trail of decisions IS the value here, and
the row is necessarily ephemeral state (no SLA timer in v1, no auth, just
a queue). Sensitive payloads should not be stored in plaintext if they ever
contain secrets — but the runtime never puts secrets into action payloads,
so this is fine for now.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, ForeignKey, Index, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

# HumanAction.status values
STATUS_PENDING = "pending"
STATUS_YES = "yes"
STATUS_NO = "no"
STATUS_EXPIRED = "expired"
VALID_STATUSES = {STATUS_PENDING, STATUS_YES, STATUS_NO, STATUS_EXPIRED}


class HumanAction(Base):
    __tablename__ = "human_actions"
    __table_args__ = (
        Index("ix_human_actions_status", "status"),
        Index("ix_human_actions_caller_status", "caller_id", "status"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    run_id: Mapped[str] = mapped_column(String, ForeignKey("runs.id"), nullable=False)
    step_id: Mapped[str] = mapped_column(String, ForeignKey("run_steps.id"), nullable=False)
    caller_id: Mapped[str] = mapped_column(String, ForeignKey("callers.id"), nullable=False)
    purpose: Mapped[str] = mapped_column(String, nullable=False)              # denormalised edge purpose
    payload_json: Mapped[str] = mapped_column(String, nullable=False)         # what the agent proposed
    runtime_snapshot_json: Mapped[str] = mapped_column(String, nullable=False, default="{}")  # internal: messages list + agent name to resume
    status: Mapped[str] = mapped_column(String, nullable=False, default=STATUS_PENDING)
    amend_json: Mapped[str | None] = mapped_column(String, nullable=True)
    decision_reason: Mapped[str | None] = mapped_column(String, nullable=True)
    decided_by: Mapped[str | None] = mapped_column(String, nullable=True)     # null until auth lands
    decided_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    def to_dict(self) -> dict:
        import json
        return {
            "id": self.id,
            "run_id": self.run_id,
            "step_id": self.step_id,
            "caller_id": self.caller_id,
            "purpose": self.purpose,
            "payload": _safe_load(self.payload_json),
            "status": self.status,
            "amend": _safe_load(self.amend_json),
            "decision_reason": self.decision_reason,
            "decided_by": self.decided_by,
            "decided_at": self.decided_at.isoformat() if self.decided_at else None,
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
