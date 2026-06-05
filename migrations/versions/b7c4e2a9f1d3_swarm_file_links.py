"""swarm_file_links

Revision ID: b7c4e2a9f1d3
Revises: a3f1c9e7d2b8
Create Date: 2026-06-05

Adds logical file links: a swarm_files row may point at a canonical row in
another swarm via `links_to_file_id`, letting one file appear in multiple
swarms without duplicating bytes on disk.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b7c4e2a9f1d3"
down_revision: Union[str, Sequence[str], None] = "a3f1c9e7d2b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("swarm_files") as batch:
        batch.add_column(sa.Column("links_to_file_id", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("swarm_files") as batch:
        batch.drop_column("links_to_file_id")
