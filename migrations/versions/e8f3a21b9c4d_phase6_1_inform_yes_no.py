"""phase6_1_inform_yes_no

Revision ID: e8f3a21b9c4d
Revises: c7a91d3b8e26
Create Date: 2026-05-02

Phase 6.1 changes:
- `informers` table — registry index of `data/<scope>/informers/*.md` files
- `human_informs` table — non-blocking notification queue
- `run_steps.informer_id` column — audit-trail link to the informer
- `human_actions`: rename `decision_payload_json` → `amend_json`
  (decision values change from approved/rejected to yes/no in code only;
  no DDL change needed as SQLite stores them as plain strings)
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e8f3a21b9c4d"
down_revision: Union[str, Sequence[str], None] = "c7a91d3b8e26"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "informers",
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
        sa.UniqueConstraint("scope", "workspace_id", "swarm_id", "name", name="uq_informer_scope_name"),
    )

    op.create_table(
        "human_informs",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("run_id", sa.String(), nullable=False),
        sa.Column("step_id", sa.String(), nullable=False),
        sa.Column("informer_id", sa.String(), nullable=False),
        sa.Column("purpose", sa.String(), nullable=False),
        sa.Column("payload_json", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("read_by", sa.String(), nullable=True),
        sa.Column("read_at", sa.DateTime(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False,
        ),
        sa.ForeignKeyConstraint(["run_id"], ["runs.id"]),
        sa.ForeignKeyConstraint(["step_id"], ["run_steps.id"]),
        sa.ForeignKeyConstraint(["informer_id"], ["informers.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_human_informs_status", "human_informs", ["status"])
    op.create_index(
        "ix_human_informs_informer_status",
        "human_informs",
        ["informer_id", "status"],
    )

    # run_steps: add informer_id column
    with op.batch_alter_table("run_steps") as batch:
        batch.add_column(sa.Column("informer_id", sa.String(), nullable=True))

    # human_actions: rename decision_payload_json → amend_json
    with op.batch_alter_table("human_actions") as batch:
        batch.add_column(sa.Column("amend_json", sa.String(), nullable=True))
        batch.drop_column("decision_payload_json")


def downgrade() -> None:
    with op.batch_alter_table("human_actions") as batch:
        batch.add_column(sa.Column("decision_payload_json", sa.String(), nullable=True))
        batch.drop_column("amend_json")

    with op.batch_alter_table("run_steps") as batch:
        batch.drop_column("informer_id")

    op.drop_index("ix_human_informs_informer_status", table_name="human_informs")
    op.drop_index("ix_human_informs_status", table_name="human_informs")
    op.drop_table("human_informs")
    op.drop_table("informers")
