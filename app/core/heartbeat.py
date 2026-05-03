from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from typing import TYPE_CHECKING

from sqlalchemy import select

from app.db import get_session
from app.models.event import Event
from app.models.swarm import Swarm
from app.models.trigger import Trigger, KIND_HEARTBEAT
from app.models.workspace import Workspace

if TYPE_CHECKING:
    from flask import Flask
    from app.core.event_bus import EventBus

logger = logging.getLogger(__name__)


def register_heartbeat_trigger(
    app: Flask, event_bus: EventBus, data_dir: str, trigger: Trigger
) -> bool:
    """Register a single heartbeat trigger with APScheduler.

    Returns True when the job was registered, False when skipped (missing
    config, script, swarm, or workspace).  Safe to call repeatedly — the
    scheduler replaces existing jobs with the same id.
    """
    from app.scheduler import register_heartbeat

    if trigger.kind != KIND_HEARTBEAT or not trigger.enabled:
        return False

    config = json.loads(trigger.config_json or "{}")
    schedule = config.get("schedule")
    script = config.get("script")
    if not schedule or not script:
        logger.warning(
            "Heartbeat trigger %r (%s) missing 'schedule' or 'script' — skipping",
            trigger.name,
            trigger.id,
        )
        return False

    with get_session() as session:
        swarm = session.get(Swarm, trigger.swarm_id)
        if not swarm:
            return False
        workspace = session.get(Workspace, swarm.workspace_id)
        if not workspace:
            return False
        ws_name = workspace.name
        sw_name = swarm.name

    swarm_path = os.path.join(data_dir, "workspaces", ws_name, "swarms", sw_name)
    script_path = os.path.join(swarm_path, "triggers", script)
    timeout = int(config.get("timeout_seconds", 60))

    job_fn = _make_heartbeat_job(
        app=app,
        event_bus=event_bus,
        trigger_id=trigger.id,
        swarm_id=trigger.swarm_id,
        script_path=script_path,
        timeout=timeout,
    )
    register_heartbeat(trigger.id, schedule, job_fn)
    logger.info("Wired heartbeat trigger %r  schedule=%r", trigger.name, schedule)
    return True


def register_all_heartbeats(app: Flask, event_bus: EventBus, data_dir: str) -> None:
    """Query the database for every enabled heartbeat trigger and register with the scheduler.

    Called once after boot_scan completes.
    """
    with get_session() as session:
        triggers = session.execute(
            select(Trigger).where(
                Trigger.kind == KIND_HEARTBEAT,
                Trigger.enabled.is_(True),
            )
        ).scalars().all()

    for trigger in triggers:
        register_heartbeat_trigger(app, event_bus, data_dir, trigger)


# ── Job factory ───────────────────────────────────────────────────────────────

def _make_heartbeat_job(
    app: Flask,
    event_bus: EventBus,
    trigger_id: str,
    swarm_id: str,
    script_path: str,
    timeout: int,
):
    """Return a no-arg callable that APScheduler can fire on each tick."""

    def job() -> None:
        with app.app_context():
            _fire_heartbeat(
                event_bus=event_bus,
                trigger_id=trigger_id,
                swarm_id=swarm_id,
                script_path=script_path,
                timeout=timeout,
            )

    return job


# ── Tick execution ────────────────────────────────────────────────────────────

def _fire_heartbeat(
    event_bus: EventBus,
    trigger_id: str,
    swarm_id: str,
    script_path: str,
    timeout: int,
) -> None:
    """Run one heartbeat tick: execute script, persist events, publish to bus."""
    if not os.path.isfile(script_path):
        logger.warning("Heartbeat script not found: %s", script_path)
        return

    # Read current watermark from DB
    with get_session() as session:
        trigger = session.get(Trigger, trigger_id)
        if not trigger or not trigger.enabled:
            return
        current_watermark = trigger.watermark or ""

    # Execute the script
    try:
        result = subprocess.run(
            [sys.executable, script_path, current_watermark],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        logger.error(
            "Heartbeat script %s timed out after %ds", script_path, timeout
        )
        return

    if result.returncode != 0:
        logger.error(
            "Heartbeat script %s exited %d — stderr: %s",
            script_path,
            result.returncode,
            result.stderr.strip()[:500],
        )
        return

    stdout = result.stdout.strip()
    if not stdout:
        logger.debug("Heartbeat script %s produced no output (no events)", script_path)
        return

    try:
        output = json.loads(stdout)
    except json.JSONDecodeError as exc:
        logger.error(
            "Heartbeat script %s produced non-JSON output: %s", script_path, exc
        )
        return

    new_watermark: str = output.get("watermark", current_watermark)
    raw_events: list = output.get("events", [])

    if not isinstance(raw_events, list):
        logger.error(
            "Heartbeat script %s: 'events' must be a list, got %s",
            script_path,
            type(raw_events).__name__,
        )
        return

    # Atomically persist new watermark + all events
    event_objects: list[Event] = []
    with get_session() as session:
        trigger = session.get(Trigger, trigger_id)
        if not trigger:
            return
        trigger.watermark = new_watermark

        # Phase 6.1: each event carries the trigger's per-trigger target so
        # the run handler can override the swarm's entry_point. Re-read the
        # config here because _fire_heartbeat doesn't carry it from the
        # registration path; the trigger row is already in this session.
        try:
            tcfg = json.loads(trigger.config_json or "{}")
        except (TypeError, ValueError):
            tcfg = {}
        target_agent = tcfg.get("target_agent")

        for raw in raw_events:
            if not isinstance(raw, dict):
                continue
            payload = dict(raw.get("payload") or {})
            payload["type"] = raw.get("type", "heartbeat")
            if target_agent:
                payload["_target_agent"] = target_agent
            evt = Event(
                swarm_id=swarm_id,
                trigger_id=trigger_id,
                source="heartbeat",
                payload_json=json.dumps(payload),
            )
            session.add(evt)
            event_objects.append(evt)

        session.commit()
        for evt in event_objects:
            session.refresh(evt)

    # Publish each event to the bus (subscribers run in the thread pool)
    for evt in event_objects:
        try:
            event_bus.publish(evt)
        except Exception:
            logger.exception("Failed to publish heartbeat event %s", evt.id)

    if event_objects:
        logger.info(
            "Heartbeat %s produced %d event(s)", trigger_id, len(event_objects)
        )
