"""run_step reasoning trace

Stores the per-turn reasoning trace of an agent loop so the run page can show
what the agent was thinking between a step's input and output.

Revision ID: a3f1c9e7d2b8
Revises: f3a7c2e1d8b4
Create Date: 2026-06-03

"""
from alembic import op
import sqlalchemy as sa

revision = "a3f1c9e7d2b8"
down_revision = "f3a7c2e1d8b4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("run_steps") as batch:
        batch.add_column(sa.Column("reasoning_json", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("run_steps") as batch:
        batch.drop_column("reasoning_json")
