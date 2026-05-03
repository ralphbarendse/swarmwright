from __future__ import annotations

import json
import logging

from flask import Blueprint, current_app, jsonify, request
from sqlalchemy import select

from app.db import get_session
from app.models.event import Event
from app.models.run import Run
from app.models.run_step import RunStep
from app.models.swarm import Swarm

logger = logging.getLogger(__name__)
bp = Blueprint("runs", __name__, url_prefix="/api/v1")


@bp.get("/runs")
def list_runs():
    swarm_id     = request.args.get("swarm_id")
    workspace_id = request.args.get("workspace_id")
    status       = request.args.get("status")
    limit        = min(int(request.args.get("limit", 50)), 200)
    offset       = int(request.args.get("offset", 0))

    with get_session() as session:
        q = select(Run).order_by(Run.started_at.desc())
        if swarm_id:
            q = q.where(Run.swarm_id == swarm_id)
        elif workspace_id:
            subq = select(Swarm.id).where(Swarm.workspace_id == workspace_id).scalar_subquery()
            q = q.where(Run.swarm_id.in_(subq))
        if status:
            q = q.where(Run.status == status)
        q = q.limit(limit).offset(offset)
        runs = session.execute(q).scalars().all()

        # Enrich with swarm display_name and event source
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

        # Create a new replay event with the same payload
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

    # Publish to event bus so a new run is started
    if hasattr(current_app, "event_bus"):
        current_app.event_bus.publish(event_data)

    return jsonify({"ok": True, "event_id": event_data.id})
