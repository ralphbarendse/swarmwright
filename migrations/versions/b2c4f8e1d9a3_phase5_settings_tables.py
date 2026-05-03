"""phase5_settings_tables

Revision ID: b2c4f8e1d9a3
Revises: f955d8c8e028
Create Date: 2026-05-01

Adds the two tables Phase 5 needs: `settings` (one row per configuration key)
and `settings_audit` (append-only log, hashes only — never values).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b2c4f8e1d9a3"
down_revision: Union[str, Sequence[str], None] = "f955d8c8e028"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "settings",
        sa.Column("key", sa.String(), nullable=False),
        sa.Column("value_encrypted", sa.String(), nullable=True),
        sa.Column("is_secret", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("value_type", sa.String(), nullable=False, server_default=sa.text("'string'")),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column("updated_by", sa.String(), nullable=True),
        sa.PrimaryKeyConstraint("key"),
    )
    op.create_table(
        "settings_audit",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("key", sa.String(), nullable=False),
        sa.Column("previous_value_hash", sa.String(), nullable=True),
        sa.Column("new_value_hash", sa.String(), nullable=False),
        sa.Column("actor", sa.String(), nullable=True),
        sa.Column("reason", sa.String(), nullable=True),
        sa.Column(
            "changed_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_settings_audit_key", "settings_audit", ["key"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_settings_audit_key", table_name="settings_audit")
    op.drop_table("settings_audit")
    op.drop_table("settings")
