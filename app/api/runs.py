from __future__ import annotations

import json
import logging
from datetime import datetime, date

from flask import Blueprint, current_app, jsonify, request
from sqlalchemy import select, func

from app.db import get_session
from app.models.event import Event
from app.models.run import Run, STATUS_RUNNING, STATUS_COMPLETED, STATUS_FAILED, STATUS_AWAITING_HUMAN
from app.models.run_step import RunStep
from app.models.swarm import Swarm

logger = logging.getLogger(__name__)
bp = Blueprint("runs", __name__, url_prefix="/api/v1")


@bp.get("/runs/stats")
def run_stats():
    today_start = datetime.combine(date.today(), datetime.min.time())
    with get_session() as session:
        running = session.execute(
            select(func.count()).select_from(Run).where(Run.status == STATUS_RUNNING)
        ).scalar() or 0
        awaiting = session.execute(
            select(func.count()).select_from(Run).where(Run.status == STATUS_AWAITING_HUMAN)
        ).scalar() or 0
        completed_today = session.execute(
            select(func.count()).select_from(Run).where(
                Run.status == STATUS_COMPLETED,
                Run.ended_at >= today_start,
            )
        ).scalar() or 0
        failed_today = session.execute(
            select(func.count()).select_from(Run).where(
                Run.status == STATUS_FAILED,
                Run.ended_at >= today_start,
            )
        ).scalar() or 0
    return jsonify({
        "running": running,
        "awaiting_human": awaiting,
        "completed_today": completed_today,
        "failed_today": failed_today,
    })


@bp.get("/runs")
def list_runs():
    swarm_id       = request.args.get("swarm_id")
    workspace_id   = request.args.get("workspace_id")
    status         = request.args.get("status")
    started_after  = request.args.get("started_after")
    started_before = request.args.get("started_before")
    limit          = min(int(request.args.get("limit", 50)), 200)
    offset         = int(request.args.get("offset", 0))

    with get_session() as session:
        q = select(Run).order_by(Run.started_at.desc())
        if swarm_id:
            q = q.where(Run.swarm_id == swarm_id)
        elif workspace_id:
            subq = select(Swarm.id).where(Swarm.workspace_id == workspace_id).scalar_subquery()
            q = q.where(Run.swarm_id.in_(subq))
        if status:
            q = q.where(Run.status == status)
        if started_after:
            try:
                q = q.where(Run.started_at >= datetime.fromisoformat(started_after))
            except ValueError:
                pass
        if started_before:
            try:
                q = q.where(Run.started_at <= datetime.fromisoformat(started_before))
            except ValueError:
                pass
        q = q.limit(limit).offset(offset)
        runs = session.execute(q).scalars().all()

        results = []
        for run in runs:
            data = run.to_dict()
            swarm = session.get(Swarm, run.swarm_id)
            data["swarm_display_name"] = swarm.display_name if swarm else None
            event = session.get(Event, run.event_id)
            data["source"] = event.source if event else None
            results.append(data)

        return jsonify(results)


@bp.get("/runs/<run_id>")
def get_run(run_id: str):
    with get_session() as session:
        run = session.get(Run, run_id)
        if not run:
            return jsonify({"error": {"code": "not_found", "message": "Run not found"}}), 404

        steps = session.execute(
            select(RunStep)
            .where(RunStep.run_id == run_id)
            .order_by(RunStep.sequence)
        ).scalars().all()

        result = run.to_dict()
        result["steps"] = [s.to_dict() for s in steps]

        swarm = session.get(Swarm, run.swarm_id)
        result["swarm_display_name"] = swarm.display_name if swarm else None

        event = session.get(Event, run.event_id)
        if event:
            result["source"] = event.source
            try:
                result["event_payload"] = json.loads(event.payload_json or "{}")
            except Exception:
                result["event_payload"] = {}
        else:
            result["source"] = None
            result["event_payload"] = {}

        return jsonify(result)


@bp.post("/runs/<run_id>/stop")
def stop_run(run_id: str):
    """Signal a running run to stop at its next agent turn."""
    with get_session() as session:
        run = session.get(Run, run_id)
        if not run:
            return jsonify({"error": {"code": "not_found", "message": "Run not found"}}), 404
        if run.status not in (STATUS_RUNNING,):
            return jsonify({"error": {"code": "not_running", "message": f"Run is {run.status}, not running"}}), 409

    from app.core.runtime import cancel_run
    cancel_run(run_id)
    return jsonify({"ok": True})


@bp.post("/runs/<run_id>/replay")
def replay_run(run_id: str):
    """Re-fire the same event that triggered this run."""
    with get_session() as session:
        run = session.get(Run, run_id)
        if not run:
            return jsonify({"error": {"code": "not_found", "message": "Run not found"}}), 404

        original_event = session.get(Event, run.event_id)
        if not original_event:
            return jsonify({"error": {"code": "not_found", "message": "Original event not found"}}), 404

        new_event = Event(
            swarm_id=original_event.swarm_id,
            trigger_id=None,
            source="api",
            payload_json=original_event.payload_json,
        )
        session.add(new_event)
        session.commit()
        session.refresh(new_event)
        event_data = new_event

    if hasattr(current_app, "event_bus"):
        current_app.event_bus.publish(event_data)

    return jsonify({"ok": True, "event_id": event_data.id})
