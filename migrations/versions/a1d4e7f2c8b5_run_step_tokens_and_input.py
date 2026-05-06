"""run_step tokens and input exposure

Revision ID: a1d4e7f2c8b5
Revises: e8f3a21b9c4d
Create Date: 2026-05-06

"""
from alembic import op
import sqlalchemy as sa

revision = "a1d4e7f2c8b5"
down_revision = "e8f3a21b9c4d"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("run_steps") as batch:
        batch.add_column(sa.Column("tokens_input", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("tokens_output", sa.Integer(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("run_steps") as batch:
        batch.drop_column("tokens_output")
        batch.drop_column("tokens_input")
