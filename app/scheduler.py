from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from apscheduler.schedulers.background import BackgroundScheduler

if TYPE_CHECKING:
    from flask import Flask

logger = logging.getLogger(__name__)

_scheduler: BackgroundScheduler | None = None


def get_scheduler() -> BackgroundScheduler:
    if _scheduler is None:
        raise RuntimeError("Scheduler not initialised. Call init_scheduler() first.")
    return _scheduler


def _prune_audit_log(app: Flask) -> None:
    """Delete settings_audit rows older than security.audit_retention_days."""
    with app.app_context():
        import json as _json
        from sqlalchemy import delete as sa_delete
        from app.db import get_session
        from app.models.settings import Setting, SettingsAudit

        try:
            with get_session() as session:
                row = session.get(Setting, "security.audit_retention_days")
                days = int(_json.loads(row.value_encrypted)) if row and row.value_encrypted else 365
                cutoff = datetime.now(timezone.utc) - timedelta(days=days)
                result = session.execute(
                    sa_delete(SettingsAudit).where(SettingsAudit.changed_at < cutoff)
                )
                session.commit()
                if result.rowcount:
                    logger.info("Pruned %d old audit entries (retention=%d days)", result.rowcount, days)
        except Exception:
            logger.exception("Failed to prune audit log")


def init_scheduler(app: Flask) -> None:
    """Create and start the APScheduler instance.

    Phase 1: starts the scheduler but registers no jobs.
    Phase 2: the registry will call register_heartbeat() for each enabled trigger.
    """
    global _scheduler

    timezone_name = app.config.get("SCHEDULER_TIMEZONE", "Europe/Amsterdam")
    _scheduler = BackgroundScheduler(timezone=timezone_name)
    _scheduler.start()
    logger.info("Scheduler started (timezone=%s)", timezone_name)

    _scheduler.add_job(
        _prune_audit_log,
        args=[app],
        trigger="cron",
        id="_audit_prune",
        hour=3,
        minute=0,
        replace_existing=True,
    )
    logger.info("Registered daily audit-log prune job")


def register_heartbeat(trigger_id: str, cron_expression: str, job_fn) -> None:
    """Register a heartbeat trigger as a cron job.

    Called by the Phase 2 registry when it picks up a heartbeat trigger config.
    Replaces any existing job for the same trigger_id.
    """
    scheduler = get_scheduler()

    # Remove existing job if present (e.g. trigger was re-configured)
    if scheduler.get_job(trigger_id):
        scheduler.remove_job(trigger_id)

    # Parse the five-field cron expression
    minute, hour, day, month, day_of_week = cron_expression.strip().split()

    scheduler.add_job(
        job_fn,
        trigger="cron",
        id=trigger_id,
        minute=minute,
        hour=hour,
        day=day,
        month=month,
        day_of_week=day_of_week,
        replace_existing=True,
    )
    logger.info("Registered heartbeat job %s with schedule '%s'", trigger_id, cron_expression)


def remove_heartbeat(trigger_id: str) -> None:
    """Deregister a heartbeat job (e.g. trigger was deleted or disabled)."""
    scheduler = get_scheduler()
    if scheduler.get_job(trigger_id):
        scheduler.remove_job(trigger_id)
        logger.info("Removed heartbeat job %s", trigger_id)
