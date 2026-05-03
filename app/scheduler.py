from __future__ import annotations

import logging
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


def init_scheduler(app: Flask) -> None:
    """Create and start the APScheduler instance.

    Phase 1: starts the scheduler but registers no jobs.
    Phase 2: the registry will call register_heartbeat() for each enabled trigger.
    """
    global _scheduler

    timezone = app.config.get("SCHEDULER_TIMEZONE", "Europe/Amsterdam")
    _scheduler = BackgroundScheduler(timezone=timezone)
    _scheduler.start()
    logger.info("Scheduler started (timezone=%s)", timezone)


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
