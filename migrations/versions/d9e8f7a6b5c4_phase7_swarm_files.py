"""phase7_swarm_files

Revision ID: d9e8f7a6b5c4
Revises: a1d4e7f2c8b5
Create Date: 2026-05-10

Phase 7 adds the Swarm File Store:
- `swarm_files` table — DB index of files/ directories inside each swarm folder
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d9e8f7a6b5c4"
down_revision: Union[str, Sequence[str], None] = "a1d4e7f2c8b5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "swarm_files",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("swarm_id", sa.String(), nullable=False),
        sa.Column("path", sa.String(), nullable=False),
        sa.Column("filename", sa.String(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("mime_type", sa.String(), nullable=True),
        sa.Column("checksum", sa.String(), nullable=False, server_default=""),
        sa.Column("origin", sa.String(), nullable=False, server_default="unknown"),
        sa.Column(
            "created_at", sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False,
        ),
        sa.Column(
            "updated_at", sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False,
        ),
        sa.Column("created_by_run_id", sa.String(), nullable=True),
        sa.Column("created_by_step_id", sa.String(), nullable=True),
        sa.Column("updated_by_run_id", sa.String(), nullable=True),
        sa.Column("updated_by_step_id", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(["swarm_id"], ["swarms.id"]),
        sa.ForeignKeyConstraint(["created_by_run_id"], ["runs.id"]),
        sa.ForeignKeyConstraint(["created_by_step_id"], ["run_steps.id"]),
        sa.ForeignKeyConstraint(["updated_by_run_id"], ["runs.id"]),
        sa.ForeignKeyConstraint(["updated_by_step_id"], ["run_steps.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("swarm_id", "path", name="uq_swarm_file_path"),
    )
    op.create_index("ix_swarm_files_swarm_created", "swarm_files", ["swarm_id", "created_at"])
    op.create_index("ix_swarm_files_run", "swarm_files", ["created_by_run_id"])


def downgrade() -> None:
    op.drop_index("ix_swarm_files_run", table_name="swarm_files")
    op.drop_index("ix_swarm_files_swarm_created", table_name="swarm_files")
    op.drop_table("swarm_files")
