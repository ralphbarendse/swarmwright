from __future__ import annotations

import hashlib
import json
import logging
import os
import re

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


class AgentDraftRequest(BaseModel):
    prompt: str = ""


# ── Read ──────────────────────────────────────────────────────────────────────

@bp.get("/swarms/<swarm_id>/agents")
def list_agents(swarm_id: str):
    with get_session() as session:
        rows = session.execute(
            select(Agent).where(Agent.swarm_id == swarm_id).order_by(Agent.name)
        ).scalars().all()
        result = []
        for a in rows:
            d = a.to_dict()
            _attach_constitution_preview(d, a.md_path)
            result.append(d)
        return jsonify(result)


def _attach_constitution_preview(d: dict, md_path: str) -> None:
    d["tagline"] = None
    d["constitution_preview"] = None
    if not md_path or not os.path.isfile(md_path):
        return
    try:
        with open(md_path) as f:
            post = fm_lib.loads(f.read())
        paras = [p.strip() for p in post.content.split("\n\n")
                 if p.strip() and not p.strip().startswith("#")]
        if paras:
            d["tagline"] = paras[0][:150]
        if len(paras) > 1:
            d["constitution_preview"] = paras[1][:200]
    except Exception:
        pass


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


# ── AI Draft ─────────────────────────────────────────────────────────────────

@bp.post("/agents/<agent_id>/draft")
def draft_agent_constitution(agent_id: str):
    try:
        body = AgentDraftRequest.model_validate(request.get_json(force=True) or {})
    except Exception as exc:
        return jsonify({"error": {"code": "validation_error", "message": str(exc)}}), 400

    with get_session() as session:
        agent = session.get(Agent, agent_id)
        if not agent:
            return jsonify({"error": {"code": "not_found", "message": "Agent not found"}}), 404
        agent_name = agent.name
        agent_layer = agent.layer
        md_path = agent.md_path
        swarm_id = agent.swarm_id

    # Extract existing body (strip frontmatter) to give as context if refining
    existing_body = ""
    if md_path and os.path.isfile(md_path):
        try:
            with open(md_path) as f:
                raw = f.read()
            m = re.match(r"^---\n[\s\S]*?\n---\n?([\s\S]*)$", raw)
            existing_body = (m.group(1).strip() if m else raw.strip())
        except OSError:
            pass

    # Derive swarm context from hierarchy.json (path is sibling of agents/)
    swarm_context = ""
    if md_path:
        swarm_path = os.path.dirname(os.path.dirname(md_path))
        hierarchy_path = os.path.join(swarm_path, "hierarchy.json")
        if os.path.isfile(hierarchy_path):
            try:
                with open(hierarchy_path) as f:
                    h = json.load(f)
                edges = h.get("edges", [])
                skills = h.get("skills", [])
                calls_to  = [e["to"]   for e in edges if e.get("from") == agent_name]
                called_by = [e["from"] for e in edges if e.get("to")   == agent_name]
                my_skills = [s["skill"] for s in skills if s.get("agent") == agent_name]
                swarm_context = (
                    f"Swarm: {h.get('swarm', 'unknown')}\n"
                    f"All agents in swarm: {', '.join(h.get('agents', []))}\n"
                    f"Entry point: {h.get('entry_point', '?')}\n"
                    f"This agent delegates to: {', '.join(calls_to) or 'none'}\n"
                    f"This agent is called by: {', '.join(called_by) or 'none'}\n"
                    f"Skills available: {', '.join(my_skills) or 'none'}\n"
                )
            except Exception:
                pass

    try:
        from app.core.secrets import get_llm_credentials  # noqa: PLC0415
        llm = get_llm_credentials()
        system = (
            "You are helping write agent constitutions for SwarmWright, an AI agent swarm orchestration platform. "
            "A constitution is a markdown document that defines an agent's identity, role, responsibilities, and behavioral rules. "
            "Write in second person (\"You are the ...\"). Be specific, behavioral, and actionable. "
            "Output ONLY the markdown body — no frontmatter, no --- delimiters. "
            "Use clear ## sections. Suggested sections: Role, Responsibilities, Behavior, Output Format, Constraints."
        )
        user_msg = f"Agent name: {agent_name}\nLayer: {agent_layer}\n"
        if swarm_context:
            user_msg += f"\nSwarm context:\n{swarm_context}"
        if existing_body:
            user_msg += f"\nExisting constitution body (for reference/refinement):\n{existing_body}\n"
        if body.prompt:
            user_msg += f"\nInstructions: {body.prompt}"
        else:
            user_msg += "\nDraft a complete, specific constitution for this agent based on its name, layer, and swarm context."
        content = llm.complete(system, [{"role": "user", "content": user_msg}], max_tokens=2048)
    except Exception as exc:
        logger.error("LLM draft failed: %s", exc)
        return jsonify({"error": {"code": "llm_error", "message": str(exc)}}), 502

    return jsonify({"content": content})


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
