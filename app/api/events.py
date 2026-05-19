from __future__ import annotations

import json

from flask import Blueprint, jsonify, request, current_app
from sqlalchemy import select

from app.core.auth import require_permission
from app.db import get_session
from app.models.swarm import Swarm
from app.models.event import Event

bp = Blueprint("events", __name__, url_prefix="/api/v1")


@bp.post("/swarms/<swarm_id>/events")
@require_permission("can_start_run")
def fire_event(swarm_id: str):
    """Fire an event into a swarm — persists and dispatches via event bus."""
    body = request.get_json(force=True)
    if not isinstance(body, dict):
        return jsonify({"error": {"code": "validation_error", "message": "Body must be a JSON object"}}), 400

    payload = dict(body)
    payload.setdefault("type", "api")

    with get_session() as session:
        swarm = session.get(Swarm, swarm_id)
        if not swarm:
            return jsonify({"error": {"code": "not_found", "message": "Swarm not found"}}), 404

        event = Event(
            swarm_id=swarm_id,
            source="api",
            payload_json=json.dumps(payload),
        )
        session.add(event)
        session.commit()
        session.refresh(event)

    current_app.event_bus.publish(event)
    return jsonify(event.to_dict()), 201


@bp.get("/events")
def list_events():
    """List recent events, optionally filtered by swarm."""
    swarm_id = request.args.get("swarm_id")
    limit = min(int(request.args.get("limit", 50)), 200)

    with get_session() as session:
        query = select(Event).order_by(Event.received_at.desc()).limit(limit)
        if swarm_id:
            query = query.where(Event.swarm_id == swarm_id)
        rows = session.execute(query).scalars().all()
        return jsonify([e.to_dict() for e in rows])
