from __future__ import annotations

import os
import tempfile

# Phase 5: provide a deterministic Fernet master key for the test session so
# the encryption layer can encrypt/decrypt without operator setup. This is set
# before any `app.*` import that might read it at module load time.
os.environ.setdefault(
    "SWARM_ENCRYPTION_KEY",
    "FEUEm0ZuxNdlvGmNknpILxl9lZfEJblP-qRLm8mLHmc=",
)

import pytest

from app.config import TestingConfig
from app.db import Base, get_engine


@pytest.fixture(scope="session")
def data_dir():
    """Temporary data directory tree for the test session."""
    with tempfile.TemporaryDirectory() as tmp:
        # Create the canonical data layout
        for path in [
            "company/knowledge",
            "company/skills",
            "company/perceptionists",
            "company/callers",
            "workspaces",
            "branding",
        ]:
            os.makedirs(os.path.join(tmp, path), exist_ok=True)
        yield tmp


@pytest.fixture(scope="session")
def app(data_dir):
    """Application instance backed by in-memory SQLite."""
    cfg = TestingConfig()
    cfg.DATA_DIR = data_dir

    from app import create_app
    application = create_app(config=cfg)
    application.config["TESTING"] = True

    # Create all tables directly for tests (no Alembic needed)
    with application.app_context():
        Base.metadata.create_all(get_engine())

    yield application


@pytest.fixture()
def client(app):
    """Flask test client."""
    return app.test_client()
