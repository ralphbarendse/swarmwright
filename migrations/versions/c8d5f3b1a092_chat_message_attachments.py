"""chat_message_attachments

Revision ID: c8d5f3b1a092
Revises: b7c4e2a9f1d3
Create Date: 2026-06-05

Adds a JSON `attachments` column to chat_messages. Stores a list of file
references the assistant surfaced for the user, e.g.
  [{"swarm_id": "...", "path": "report.csv", "filename": "report.csv",
    "size_bytes": 1234, "mime": "text/csv"}]
so the chat panel can render inline previews / download chips.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c8d5f3b1a092"
down_revision: Union[str, Sequence[str], None] = "b7c4e2a9f1d3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("chat_messages") as batch:
        batch.add_column(sa.Column("attachments", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("chat_messages") as batch:
        batch.drop_column("attachments")
