"""chat_multi_session

Revision ID: d1e6a4b9c273
Revises: c8d5f3b1a092
Create Date: 2026-06-05

Drops the (user_id, scope, workspace_id) unique constraint on chat_sessions so a
user can keep multiple operator/concierge conversations ("chat history") instead
of a single eternal thread.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "d1e6a4b9c273"
down_revision: Union[str, Sequence[str], None] = "c8d5f3b1a092"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # SQLite can't ALTER away a constraint in place — batch mode recreates the
    # table without the unique constraint.
    with op.batch_alter_table("chat_sessions") as batch:
        batch.drop_constraint("uq_chat_session_user_scope", type_="unique")


def downgrade() -> None:
    with op.batch_alter_table("chat_sessions") as batch:
        batch.create_unique_constraint(
            "uq_chat_session_user_scope", ["user_id", "scope", "workspace_id"]
        )
