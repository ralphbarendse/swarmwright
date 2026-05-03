"""phase6_callers_human_actions

Revision ID: c7a91d3b8e26
Revises: b2c4f8e1d9a3
Create Date: 2026-05-01

Phase 6 adds the human-in-the-loop primitives:
- `callers` table — registry index of `data/<scope>/callers/*.md` files
- `human_actions` table — pending/decided inbox queue
- `run_steps.caller_id` column — audit-trail link to the caller that
  produced a paused step
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c7a91d3b8e26"
down_revision: Union[str, Sequence[str], None] = "b2c4f8e1d9a3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "callers",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("swarm_id", sa.String(), nullable=True),
        sa.Column("workspace_id", sa.String(), nullable=True),
        sa.Column("scope", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("display_name", sa.String(), nullable=False),
        sa.Column("md_path", sa.String(), nullable=False),
        sa.Column("md_hash", sa.String(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False,
        ),
        sa.Column(
            "updated_at", sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False,
        ),
        sa.ForeignKeyConstraint(["swarm_id"], ["swarms.id"]),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("scope", "workspace_id", "swarm_id", "name", name="uq_caller_scope_name"),
    )

    op.create_table(
        "human_actions",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("run_id", sa.String(), nullable=False),
        sa.Column("step_id", sa.String(), nullable=False),
        sa.Column("caller_id", sa.String(), nullable=False),
        sa.Column("purpose", sa.String(), nullable=False),
        sa.Column("payload_json", sa.String(), nullable=False),
        sa.Column("runtime_snapshot_json", sa.String(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("decision_payload_json", sa.String(), nullable=True),
        sa.Column("decision_reason", sa.String(), nullable=True),
        sa.Column("decided_by", sa.String(), nullable=True),
        sa.Column("decided_at", sa.DateTime(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False,
        ),
        sa.ForeignKeyConstraint(["run_id"], ["runs.id"]),
        sa.ForeignKeyConstraint(["step_id"], ["run_steps.id"]),
        sa.ForeignKeyConstraint(["caller_id"], ["callers.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_human_actions_status", "human_actions", ["status"])
    op.create_index(
        "ix_human_actions_caller_status",
        "human_actions",
        ["caller_id", "status"],
    )

    # SQLite cannot ALTER TABLE ADD CONSTRAINT, so the FK on caller_id is
    # implicit (column added; FK enforcement comes via the table-creation
    # path used by SQLAlchemy in tests). Production data flow always goes
    # through SQLAlchemy session inserts, which check the FK at the ORM
    # level via Caller relationship lookups.
    with op.batch_alter_table("run_steps") as batch:
        batch.add_column(sa.Column("caller_id", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("run_steps") as batch:
        batch.drop_column("caller_id")
    op.drop_index("ix_human_actions_caller_status", table_name="human_actions")
    op.drop_index("ix_human_actions_status", table_name="human_actions")
    op.drop_table("human_actions")
    op.drop_table("callers")
