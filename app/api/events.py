from __future__ import annotations

import json

from flask import Blueprint, jsonify, request, current_app
from pydantic import BaseModel
from sqlalchemy import select

from app.db import get_session
from app.models.swarm import Swarm
from app.models.event import Event

bp = Blueprint("events", __name__, url_prefix="/api/v1")


class EventFire(BaseModel):
    type: str
    payload: dict = {}
    source: str = "api"


@bp.post("/swarms/<swarm_id>/events")
def fire_event(swarm_id: str):
    """Fire an event into a swarm — persists and dispatches via event bus."""
    try:
        body = EventFire.model_validate(request.get_json(force=True) or {})
    except Exception as exc:
        return jsonify({"error": {"code": "validation_error", "message": str(exc)}}), 400

    with get_session() as session:
        swarm = session.get(Swarm, swarm_id)
        if not swarm:
            return jsonify({"error": {"code": "not_found", "message": "Swarm not found"}}), 404

        payload = {"type": body.type, **body.payload}
        event = Event(
            swarm_id=swarm_id,
            source=body.source,
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
