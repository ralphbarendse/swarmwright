from __future__ import annotations

import os


class Config:
    # ── LLM ───────────────────────────────────────────────────────────────────
    LLM_PROVIDER: str = os.environ.get("LLM_PROVIDER", "anthropic")
    LLM_MODEL: str = os.environ.get("LLM_MODEL", "claude-opus-4-6")
    ANTHROPIC_API_KEY: str | None = os.environ.get("ANTHROPIC_API_KEY")
    OPENAI_API_KEY: str | None = os.environ.get("OPENAI_API_KEY")

    # ── Encryption ────────────────────────────────────────────────────────────
    SWARM_ENCRYPTION_KEY: str | None = os.environ.get("SWARM_ENCRYPTION_KEY")

    # ── Database ──────────────────────────────────────────────────────────────
    DATABASE_URL: str = os.environ.get(
        "DATABASE_URL", "sqlite:////data/swarm.db"
    )

    # ── Filesystem ────────────────────────────────────────────────────────────
    DATA_DIR: str = os.environ.get("DATA_DIR", "/data")

    # ── Logging ───────────────────────────────────────────────────────────────
    LOG_LEVEL: str = os.environ.get("LOG_LEVEL", "INFO")

    # ── Scheduler ─────────────────────────────────────────────────────────────
    SCHEDULER_TIMEZONE: str = os.environ.get(
        "SCHEDULER_TIMEZONE", "Europe/Amsterdam"
    )

    # ── Flask ─────────────────────────────────────────────────────────────────
    SECRET_KEY: str = os.environ.get("SECRET_KEY", "dev-secret-change-me")
    TESTING: bool = False


class TestingConfig(Config):
    TESTING: bool = True
    DATABASE_URL: str = "sqlite:///:memory:"
    DATA_DIR: str = "/tmp/swarmwright-test"
    LOG_LEVEL: str = "WARNING"
