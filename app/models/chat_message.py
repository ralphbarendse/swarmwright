from __future__ import annotations

import json
import logging
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

logger = logging.getLogger(__name__)

ROLE_USER = "user"
ROLE_ASSISTANT = "assistant"
ROLE_SYSTEM = "system"


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(Integer, ForeignKey("chat_sessions.id"), nullable=False)
    role: Mapped[str] = mapped_column(String, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    run_id: Mapped[str | None] = mapped_column(String, ForeignKey("runs.id"), nullable=True)
    # JSON list of file refs the assistant surfaced; see migration c8d5f3b1a092.
    attachments: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    def attachments_list(self) -> list[dict]:
        if not self.attachments:
            return []
        try:
            data = json.loads(self.attachments)
            return data if isinstance(data, list) else []
        except Exception:
            logger.debug("Bad attachments JSON on chat_message %s", self.id, exc_info=True)
            return []

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "session_id": self.session_id,
            "role": self.role,
            "content": self.content,
            "run_id": self.run_id,
            "attachments": self.attachments_list(),
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
