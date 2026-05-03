from __future__ import annotations

import hashlib
import logging
import os

import frontmatter as fm_lib
from flask import Blueprint, current_app, jsonify, request
from pydantic import BaseModel
from sqlalchemy import select

from app.core.hierarchy import VALID_LAYERS, load_and_validate, HierarchyValidationError
from app.db import get_session
from app.models.agent import Agent, SCOPE_SWARM
from app.models.swarm import Swarm
from app.models.workspace import Workspace

logger = logging.getLogger(__name__)
bp = Blueprint("agents", __name__, url_prefix="/api/v1")


class AgentCreate(BaseModel):
    name: str
    layer: str
    model: str = "claude-sonnet-4-6"
    constitution: str = ""


class AgentConstitutionUpdate(BaseModel):
    constitution: str


# ── Read ──────────────────────────────────────────────────────────────────────

@bp.get("/swarms/<swarm_id>/agents")
def list_agents(swarm_id: str):
    with get_session() as session:
        rows = session.execute(
            select(Agent).where(Agent.swarm_id == swarm_id).order_by(Agent.name)
        ).scalars().all()
        return jsonify([a.to_dict() for a in rows])


@bp.get("/agents/<agent_id>")
def get_agent(agent_id: str):
    with get_session() as session:
        agent = session.get(Agent, agent_id)
        if not agent:
            return jsonify({"error": {"code": "not_found", "message": "Agent not found"}}), 404
        data = agent.to_dict()

    if data.get("md_path") and os.path.isfile(data["md_path"]):
        try:
            with open(data["md_path"]) as f:
                data["constitution"] = f.read()
        except OSError:
            data["constitution"] = None
    else:
        data["constitution"] = None
    return jsonify(data)


# ── Create ────────────────────────────────────────────────────────────────────

@bp.post("/swarms/<swarm_id>/agents")
def create_agent(swarm_id: str):
    try:
        body = AgentCreate.model_validate(request.get_json(force=True) or {})
    except Exception as exc:
        return jsonify({"error": {"code": "validation_error", "message": str(exc)}}), 400

    if body.layer not in VALID_LAYERS:
        return jsonify({"error": {"code": "validation_error", "message": f"Invalid layer: {body.layer}"}}), 400

    data_dir = current_app.config["DATA_DIR"]
    with get_session() as session:
        swarm = session.get(Swarm, swarm_id)
        if not swarm:
            return jsonify({"error": {"code": "not_found", "message": "Swarm not found"}}), 404
        workspace = session.get(Workspace, swarm.workspace_id)
        if not workspace:
            return jsonify({"error": {"code": "not_found", "message": "Workspace not found"}}), 404
        existing = session.execute(
            select(Agent).where(Agent.swarm_id == swarm_id, Agent.name == body.name)
        ).scalar_one_or_none()
        if existing:
            return jsonify({"error": {"code": "conflict", "message": f"Agent {body.name!r} already exists"}}), 409
        ws_name = workspace.name
        sw_name = swarm.name
        workspace_id = workspace.id

    swarm_path = os.path.join(data_dir, "workspaces", ws_name, "swarms", sw_name)
    agents_dir = os.path.join(swarm_path, "agents")
    os.makedirs(agents_dir, exist_ok=True)
    md_path = os.path.join(agents_dir, f"{body.name}.md")

    if not body.constitution:
        content = (
            f"---\nname: {body.name}\nlayer: {body.layer}\nmodel: {body.model}\n"
            "knowledge: []\n---\n\nYou are the {name}.\n\n## Role\n\nDescribe this agent's role here.\n"
        ).replace("{name}", body.name)
    else:
        content = body.constitution

    with open(md_path, "w") as f:
        f.write(content)

    md_hash = hashlib.sha256(content.encode()).hexdigest()

    with get_session() as session:
        agent = Agent(
            swarm_id=swarm_id,
            workspace_id=workspace_id,
            scope=SCOPE_SWARM,
            name=body.name,
            layer=body.layer,
            model=body.model,
            md_path=md_path,
            md_hash=md_hash,
            enabled=True,
        )
        session.add(agent)
        session.commit()
        session.refresh(agent)
        return jsonify(agent.to_dict()), 201


# ── Update constitution ───────────────────────────────────────────────────────

@bp.put("/agents/<agent_id>/constitution")
def update_constitution(agent_id: str):
    try:
        body = AgentConstitutionUpdate.model_validate(request.get_json(force=True) or {})
    except Exception as exc:
        return jsonify({"error": {"code": "validation_error", "message": str(exc)}}), 400

    with get_session() as session:
        agent = session.get(Agent, agent_id)
        if not agent:
            return jsonify({"error": {"code": "not_found", "message": "Agent not found"}}), 404
        md_path = agent.md_path

    # Validate frontmatter
    try:
        post = fm_lib.loads(body.constitution)
        layer = post.metadata.get("layer", "")
        if layer not in VALID_LAYERS:
            return jsonify({
                "error": {
                    "code": "invalid_constitution",
                    "message": f"Invalid layer {layer!r}. Must be one of: {', '.join(VALID_LAYERS)}",
                    "field": "layer",
                }
            }), 422
    except Exception as exc:
        return jsonify({"error": {"code": "invalid_constitution", "message": str(exc)}}), 422

    # Write atomically
    tmp_path = md_path + ".tmp"
    with open(tmp_path, "w") as f:
        f.write(body.constitution)
    os.replace(tmp_path, md_path)

    md_hash = hashlib.sha256(body.constitution.encode()).hexdigest()
    new_layer = post.metadata.get("layer", "")
    new_model = post.metadata.get("model")

    with get_session() as session:
        agent = session.get(Agent, agent_id)
        if agent:
            agent.md_hash = md_hash
            if new_layer:
                agent.layer = new_layer
            if new_model:
                agent.model = new_model
            session.commit()
            session.refresh(agent)
            data = agent.to_dict()

    data["constitution"] = body.constitution

    # Save history entry
    _save_history(md_path, body.constitution)

    if hasattr(current_app, "sse_bus"):
        current_app.sse_bus.broadcast("agent.updated", {"agent_id": agent_id})

    return jsonify(data)


# ── Delete ────────────────────────────────────────────────────────────────────

@bp.delete("/agents/<agent_id>")
def delete_agent(agent_id: str):
    with get_session() as session:
        agent = session.get(Agent, agent_id)
        if not agent:
            return jsonify({"error": {"code": "not_found", "message": "Agent not found"}}), 404
        md_path = agent.md_path
        session.delete(agent)
        session.commit()

    if md_path and os.path.isfile(md_path):
        try:
            os.remove(md_path)
        except OSError as exc:
            logger.warning("Could not delete agent file %s: %s", md_path, exc)

    return "", 204


# ── History ───────────────────────────────────────────────────────────────────

@bp.get("/agents/<agent_id>/history")
def get_agent_history(agent_id: str):
    with get_session() as session:
        agent = session.get(Agent, agent_id)
        if not agent:
            return jsonify({"error": {"code": "not_found", "message": "Agent not found"}}), 404
        md_path = agent.md_path

    history_dir = os.path.join(os.path.dirname(md_path), ".history", os.path.basename(md_path))
    if not os.path.isdir(history_dir):
        return jsonify([])

    entries = sorted(
        (f for f in os.listdir(history_dir) if f.endswith(".md")),
        reverse=True,
    )[:20]
    return jsonify([{"timestamp": e[:-3], "path": os.path.join(history_dir, e)} for e in entries])


def _save_history(md_path: str, content: str) -> None:
    from datetime import datetime, timezone
    history_dir = os.path.join(os.path.dirname(md_path), ".history", os.path.basename(md_path))
    os.makedirs(history_dir, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    with open(os.path.join(history_dir, f"{ts}.md"), "w") as f:
        f.write(content)
