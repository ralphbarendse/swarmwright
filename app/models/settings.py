from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import String, Boolean, DateTime, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

# Allowed value_type values
VALUE_TYPE_STRING = "string"
VALUE_TYPE_NUMBER = "number"
VALUE_TYPE_BOOLEAN = "boolean"
VALUE_TYPE_JSON = "json"

VALID_VALUE_TYPES = {
    VALUE_TYPE_STRING,
    VALUE_TYPE_NUMBER,
    VALUE_TYPE_BOOLEAN,
    VALUE_TYPE_JSON,
}


class Setting(Base):
    """One row per configuration key.

    `value_encrypted` holds the Fernet-encrypted string when `is_secret` is true,
    and a plain JSON-encoded value when `is_secret` is false. Storing both kinds
    in the same column keeps the schema flat; the API layer is responsible for
    deciding which interpretation applies based on `is_secret`.
    """

    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String, primary_key=True)              # dotted namespace, e.g. llm.anthropic.api_key
    value_encrypted: Mapped[str | None] = mapped_column(String, nullable=True)
    is_secret: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    value_type: Mapped[str] = mapped_column(String, nullable=False, default=VALUE_TYPE_STRING)  # string | number | boolean | json
    description: Mapped[str | None] = mapped_column(String, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )
    updated_by: Mapped[str | None] = mapped_column(String, nullable=True)

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "is_secret": self.is_secret,
            "value_type": self.value_type,
            "description": self.description,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "updated_by": self.updated_by,
        }


class SettingsAudit(Base):
    """Append-only log of every change to a setting.

    Stores SHA-256 hashes only — never plaintext, never ciphertext. The audit
    log can prove a change happened without ever exposing the value, which is
    important for compliance reviews.
    """

    __tablename__ = "settings_audit"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    key: Mapped[str] = mapped_column(String, nullable=False, index=True)
    previous_value_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    new_value_hash: Mapped[str] = mapped_column(String, nullable=False)
    actor: Mapped[str | None] = mapped_column(String, nullable=True)
    reason: Mapped[str | None] = mapped_column(String, nullable=True)
    changed_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "key": self.key,
            "previous_value_hash": self.previous_value_hash,
            "new_value_hash": self.new_value_hash,
            "actor": self.actor,
            "reason": self.reason,
            "changed_at": self.changed_at.isoformat() if self.changed_at else None,
        }
