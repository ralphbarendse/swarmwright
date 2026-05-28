"""phase8_chat

Revision ID: f3a7c2e1d8b4
Revises: d9e8f7a6b5c4
Create Date: 2026-05-20

Phase 8 adds the conversational interface:
- `chat_sessions` table
- `chat_messages` table
- `unmet_needs` table
- `swarms.source` column ("user" | "builtin")
- `runs.trigger_kind` column
- `can_chat_workspace`, `can_chat_operator` permission flags (stored in users.permissions_json, no column needed)
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f3a7c2e1d8b4"
down_revision: Union[str, Sequence[str], None] = "f1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "chat_sessions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("scope", sa.String(), nullable=False),           # "org" | "workspace"
        sa.Column("workspace_id", sa.String(), nullable=True),
        sa.Column("title", sa.String(), nullable=False, server_default="New conversation"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "scope", "workspace_id", name="uq_chat_session_user_scope"),
    )
    op.create_index("ix_chat_sessions_user", "chat_sessions", ["user_id"])

    op.create_table(
        "chat_messages",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("session_id", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(), nullable=False),            # "user" | "assistant" | "system"
        sa.Column("content", sa.Text(), nullable=False, server_default=""),
        sa.Column("run_id", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False),
        sa.ForeignKeyConstraint(["session_id"], ["chat_sessions.id"]),
        sa.ForeignKeyConstraint(["run_id"], ["runs.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_chat_messages_session_created", "chat_messages", ["session_id", "created_at"])

    op.create_table(
        "unmet_needs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("workspace_id", sa.String(), nullable=False),
        sa.Column("session_id", sa.Integer(), nullable=True),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("verbatim_request", sa.Text(), nullable=False),
        sa.Column("concierge_summary", sa.Text(), nullable=False, server_default=""),
        sa.Column("status", sa.String(), nullable=False, server_default="open"),
        sa.Column("addressed_by_run_id", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"]),
        sa.ForeignKeyConstraint(["session_id"], ["chat_sessions.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["addressed_by_run_id"], ["runs.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_unmet_needs_workspace_status", "unmet_needs", ["workspace_id", "status", "created_at"])

    op.add_column("swarms", sa.Column("source", sa.String(), nullable=False, server_default="user"))
    op.add_column("runs", sa.Column("trigger_kind", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("runs", "trigger_kind")
    op.drop_column("swarms", "source")
    op.drop_index("ix_unmet_needs_workspace_status", table_name="unmet_needs")
    op.drop_table("unmet_needs")
    op.drop_index("ix_chat_messages_session_created", table_name="chat_messages")
    op.drop_table("chat_messages")
    op.drop_index("ix_chat_sessions_user", table_name="chat_sessions")
    op.drop_table("chat_sessions")
