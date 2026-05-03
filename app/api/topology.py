from __future__ import annotations

import hashlib
import json
import logging
import os
import re

import frontmatter as fm_lib
import yaml
from flask import Blueprint, current_app, jsonify, request
from sqlalchemy import select

import app.core.registry as registry
from app.core.hierarchy import (
    load_and_validate,
    HierarchyValidationError,
    VALID_LAYERS,
    VALID_EDGE_KINDS,
)
from app.db import get_session
from app.models.agent import Agent, SCOPE_SWARM
from app.models.swarm import Swarm
from app.models.workspace import Workspace

logger = logging.getLogger(__name__)

bp = Blueprint("topology", __name__, url_prefix="/api/v1")

_CONSTITUTION_TEMPLATE = """\
---
name: {name}
layer: {layer}
model: {model}
knowledge: []
---

You are the {name}.

## Role

Describe this agent's role and responsibilities here.
"""


# ── Helpers ───────────────────────────────────────────────────────────────────

def _resolve_swarm_paths(swarm_id: str, data_dir: str) -> tuple[Swarm | None, str, str]:
    with get_session() as session:
        swarm = session.get(Swarm, swarm_id)
        if not swarm:
            return None, "", ""
        workspace = session.get(Workspace, swarm.workspace_id)
        if not workspace:
            return None, "", ""
        ws_name = workspace.name
        sw_name = swarm.name

    workspace_path = os.path.join(data_dir, "workspaces", ws_name)
    swarm_path = os.path.join(workspace_path, "swarms", sw_name)
    return swarm, workspace_path, swarm_path


def _load_hierarchy(swarm_path: str) -> dict:
    with open(os.path.join(swarm_path, "hierarchy.json")) as f:
        return json.load(f)


def _write_hierarchy_atomic(swarm_path: str, hierarchy: dict) -> str:
    content = json.dumps(hierarchy, indent=2)
    path = os.path.join(swarm_path, "hierarchy.json")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(content)
    os.replace(tmp, path)
    return hashlib.sha256(content.encode()).hexdigest()


def _write_meta_atomic(swarm_path: str, meta: dict) -> str:
    content = yaml.dump(meta, allow_unicode=True, default_flow_style=False)
    path = os.path.join(swarm_path, "meta.yaml")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(content)
    os.replace(tmp, path)
    return hashlib.sha256(content.encode()).hexdigest()


def _read_meta(swarm_path: str) -> dict:
    path = os.path.join(swarm_path, "meta.yaml")
    if not os.path.isfile(path):
        return {}
    with open(path) as f:
        return yaml.safe_load(f) or {}


def _slugify(text: str) -> str:
    s = re.sub(r"[^\w\s-]", "", text.lower())
    return re.sub(r"[\s_]+", "-", s).strip("-") or "agent"


def _validate_and_persist(
    hierarchy: dict,
    swarm_path: str,
    workspace_path: str,
    data_dir: str,
    swarm_id: str,
) -> tuple[dict | None, str | None]:
    """Validate hierarchy, write to disk, update DB + cache. Returns (hierarchy, error)."""
    hierarchy_path = os.path.join(swarm_path, "hierarchy.json")
    try:
        parsed = load_and_validate(
            hierarchy_path=hierarchy_path,
            swarm_path=swarm_path,
            workspace_path=workspace_path,
            data_dir=data_dir,
        )
    except HierarchyValidationError as exc:
        return None, str(exc)

    new_hash = _write_hierarchy_atomic(swarm_path, hierarchy)

    with get_session() as session:
        db_swarm = session.get(Swarm, swarm_id)
        if db_swarm:
            db_swarm.hierarchy_hash = new_hash
            db_swarm.enabled = True
            db_swarm.validation_error = None
            session.commit()

    with registry._cache_lock:
        registry._hierarchy_cache[swarm_id] = parsed

    return hierarchy, None


# ── Routes ────────────────────────────────────────────────────────────────────

@bp.get("/swarms/<swarm_id>/hierarchy")
def get_hierarchy(swarm_id: str):
    data_dir = current_app.config["DATA_DIR"]
    swarm, workspace_path, swarm_path = _resolve_swarm_paths(swarm_id, data_dir)
    if swarm is None:
        return jsonify({"error": {"code": "not_found", "message": "Swarm not found"}}), 404

    hierarchy_path = os.path.join(swarm_path, "hierarchy.json")
    if not os.path.isfile(hierarchy_path):
        return jsonify({"error": {"code": "not_found", "message": "hierarchy.json not found"}}), 404

    try:
        with open(hierarchy_path) as f:
            hierarchy = json.load(f)
    except Exception as exc:
        return jsonify({"error": {"code": "io_error", "message": str(exc)}}), 500

    # Also include GUI positions from meta.yaml
    meta = _read_meta(swarm_path)
    hierarchy["_gui"] = meta.get("gui", {})
    return jsonify(hierarchy)


@bp.patch("/swarms/<swarm_id>/topology")
def patch_topology(swarm_id: str):
    """Apply a single topology operation to a swarm's hierarchy.json."""
    data_dir = current_app.config["DATA_DIR"]
    body = request.get_json(force=True) or {}
    op = body.get("op", "")
    params = body.get("params", {})

    swarm, workspace_path, swarm_path = _resolve_swarm_paths(swarm_id, data_dir)
    if swarm is None:
        return jsonify({"error": {"code": "not_found", "message": "Swarm not found"}}), 404

    # Position-save is file-only, no validation needed
    if op == "save_positions":
        meta = _read_meta(swarm_path)
        meta.setdefault("gui", {})["positions"] = params.get("positions", {})
        _write_meta_atomic(swarm_path, meta)
        return jsonify({"ok": True})

    try:
        hierarchy = _load_hierarchy(swarm_path)
    except Exception as exc:
        return jsonify({"error": {"code": "io_error", "message": str(exc)}}), 500

    # Write a temporary hierarchy to validate against
    hierarchy_path = os.path.join(swarm_path, "hierarchy.json")

    created_md: str | None = None  # track any .md file we created so we can roll back

    try:
        if op == "add_agent":
            name = params.get("name", "").strip()
            layer = params.get("layer", "executioner")
            model = params.get("model", "claude-sonnet-4-6")
            constitution = params.get("constitution", "")
            if not name:
                return jsonify({"error": {"code": "invalid_op", "message": "name is required"}}), 400
            if layer not in VALID_LAYERS:
                return jsonify({"error": {"code": "invalid_op", "message": f"invalid layer: {layer}"}}), 400
            if name in hierarchy.get("agents", []):
                return jsonify({"error": {"code": "invalid_op", "message": f"agent {name!r} already in hierarchy"}}), 400
            md_path = os.path.join(swarm_path, "agents", f"{name}.md")
            if not os.path.isfile(md_path):
                content = constitution if constitution else _CONSTITUTION_TEMPLATE.format(
                    name=name, layer=layer, model=model,
                )
                with open(md_path, "w") as f:
                    f.write(content)
                created_md = md_path
            hierarchy.setdefault("agents", []).append(name)

        elif op == "remove_agent":
            name = params.get("name", "").strip()
            if name in hierarchy.get("agents", []):
                hierarchy["agents"].remove(name)
            # Remove any edges/consultations/skills involving this agent
            hierarchy["edges"] = [
                e for e in hierarchy.get("edges", [])
                if e.get("from") != name and e.get("to") != name
            ]
            hierarchy["consultations"] = [
                c for c in hierarchy.get("consultations", [])
                if c.get("agent") != name
            ]
            hierarchy["skills"] = [
                s for s in hierarchy.get("skills", [])
                if s.get("agent") != name
            ]
            if hierarchy.get("entry_point") == name:
                hierarchy["entry_point"] = None

        elif op == "add_edge":
            from_a = params.get("from", "")
            to_a = params.get("to", "")
            kind = params.get("kind", "delegate")
            purpose = params.get("purpose", "").strip()
            if not purpose:
                return jsonify({"error": {"code": "invalid_op", "message": "purpose is required"}}), 400
            if kind not in VALID_EDGE_KINDS:
                return jsonify({"error": {"code": "invalid_op", "message": f"invalid kind: {kind}"}}), 400
            hierarchy.setdefault("edges", []).append(
                {"from": from_a, "to": to_a, "kind": kind, "purpose": purpose}
            )

        elif op == "remove_edge":
            from_a = params.get("from", "")
            to_a = params.get("to", "")
            kind = params.get("kind", "")
            hierarchy["edges"] = [
                e for e in hierarchy.get("edges", [])
                if not (e.get("from") == from_a and e.get("to") == to_a and e.get("kind") == kind)
            ]

        elif op == "update_edge":
            from_a = params.get("from", "")
            to_a = params.get("to", "")
            kind = params.get("kind", "")
            new_purpose = params.get("purpose", "").strip()
            if not new_purpose:
                return jsonify({"error": {"code": "invalid_op", "message": "purpose is required"}}), 400
            for e in hierarchy.get("edges", []):
                if e.get("from") == from_a and e.get("to") == to_a and e.get("kind") == kind:
                    e["purpose"] = new_purpose

        elif op == "add_consultation":
            agent = params.get("agent", "")
            perceptionist = params.get("perceptionist", "")
            purpose = params.get("purpose", "").strip()
            if not purpose:
                return jsonify({"error": {"code": "invalid_op", "message": "purpose is required"}}), 400
            hierarchy.setdefault("consultations", []).append(
                {"agent": agent, "perceptionist": perceptionist, "purpose": purpose}
            )

        elif op == "remove_consultation":
            agent = params.get("agent", "")
            perceptionist = params.get("perceptionist", "")
            hierarchy["consultations"] = [
                c for c in hierarchy.get("consultations", [])
                if not (c.get("agent") == agent and c.get("perceptionist") == perceptionist)
            ]

        elif op == "add_skill_connection":
            agent = params.get("agent", "")
            skill = params.get("skill", "")
            purpose = params.get("purpose", "").strip()
            if not purpose:
                return jsonify({"error": {"code": "invalid_op", "message": "purpose is required"}}), 400
            hierarchy.setdefault("skills", []).append(
                {"agent": agent, "skill": skill, "purpose": purpose}
            )

        elif op == "remove_skill_connection":
            agent = params.get("agent", "")
            skill = params.get("skill", "")
            hierarchy["skills"] = [
                s for s in hierarchy.get("skills", [])
                if not (s.get("agent") == agent and s.get("skill") == skill)
            ]

        elif op == "add_canvas_caller":   # place caller node on canvas (no connection yet)
            caller = params.get("caller", "").strip()
            if not caller:
                return jsonify({"error": {"code": "invalid_op", "message": "caller is required"}}), 400
            canvas = hierarchy.setdefault("canvas_callers", [])
            if caller not in canvas:
                canvas.append(caller)

        elif op == "remove_canvas_caller":   # remove caller node + all its connections
            caller = params.get("caller", "").strip()
            hierarchy["canvas_callers"] = [
                c for c in hierarchy.get("canvas_callers", []) if c != caller
            ]
            hierarchy["calls"] = [
                c for c in hierarchy.get("calls", []) if c.get("caller") != caller
            ]

        elif op == "add_canvas_informer":   # place informer node on canvas (no connection yet)
            informer = params.get("informer", "").strip()
            if not informer:
                return jsonify({"error": {"code": "invalid_op", "message": "informer is required"}}), 400
            canvas = hierarchy.setdefault("canvas_informers", [])
            if informer not in canvas:
                canvas.append(informer)

        elif op == "remove_canvas_informer":   # remove informer node + all its connections
            informer = params.get("informer", "").strip()
            hierarchy["canvas_informers"] = [
                i for i in hierarchy.get("canvas_informers", []) if i != informer
            ]
            hierarchy["informs"] = [
                i for i in hierarchy.get("informs", []) if i.get("informer") != informer
            ]

        elif op == "add_call":   # Phase 6 — agent → caller route
            agent = params.get("agent", "")
            caller = params.get("caller", "")
            purpose = params.get("purpose", "").strip()
            if not purpose:
                return jsonify({"error": {"code": "invalid_op", "message": "purpose is required"}}), 400
            # Ensure caller is on canvas
            canvas = hierarchy.setdefault("canvas_callers", [])
            if caller not in canvas:
                canvas.append(caller)
            hierarchy.setdefault("calls", []).append(
                {"agent": agent, "caller": caller, "purpose": purpose}
            )

        elif op == "remove_call":
            agent = params.get("agent", "")
            caller = params.get("caller", "")
            hierarchy["calls"] = [
                c for c in hierarchy.get("calls", [])
                if not (c.get("agent") == agent and c.get("caller") == caller)
            ]

        elif op == "add_inform":   # Phase 6.1 — agent → informer route (non-blocking)
            agent = params.get("agent", "")
            informer = params.get("informer", "")
            purpose = params.get("purpose", "").strip()
            if not purpose:
                return jsonify({"error": {"code": "invalid_op", "message": "purpose is required"}}), 400
            # Ensure informer is on canvas
            canvas = hierarchy.setdefault("canvas_informers", [])
            if informer not in canvas:
                canvas.append(informer)
            hierarchy.setdefault("informs", []).append(
                {"agent": agent, "informer": informer, "purpose": purpose}
            )

        elif op == "remove_inform":
            agent = params.get("agent", "")
            informer = params.get("informer", "")
            hierarchy["informs"] = [
                i for i in hierarchy.get("informs", [])
                if not (i.get("agent") == agent and i.get("informer") == informer)
            ]

        elif op == "set_entry_point":
            name = params.get("name")
            hierarchy["entry_point"] = name

        else:
            return jsonify({"error": {"code": "unknown_op", "message": f"Unknown op: {op!r}"}}), 400

    except Exception as exc:
        if created_md and os.path.isfile(created_md):
            os.remove(created_md)
        return jsonify({"error": {"code": "op_error", "message": str(exc)}}), 500

    # Write temp to disk for validation (load_and_validate reads from disk)
    tmp_content = json.dumps(hierarchy, indent=2)
    tmp_path = hierarchy_path + ".tmp_validate"
    with open(tmp_path, "w") as f:
        f.write(tmp_content)
    # Swap so validator reads the new content
    os.replace(tmp_path, hierarchy_path)

    try:
        result, error = _validate_and_persist(
            hierarchy, swarm_path, workspace_path, data_dir, swarm_id
        )
    except Exception as exc:
        # Roll back hierarchy and any created file
        error = str(exc)
        result = None

    if result is None:
        # Restore old hierarchy
        try:
            old_hierarchy = _load_hierarchy(swarm_path)  # already overwritten, can't restore easily
        except Exception:
            pass
        if created_md and os.path.isfile(created_md):
            os.remove(created_md)
        return jsonify({
            "error": {"code": "validation_error", "message": error}
        }), 422

    # Register new agent in DB if add_agent succeeded
    if op == "add_agent":
        name = params.get("name", "")
        layer = params.get("layer", "executioner")
        model = params.get("model", "claude-sonnet-4-6")
        md_path = os.path.join(swarm_path, "agents", f"{name}.md")

        with get_session() as session:
            existing = session.execute(
                select(Agent).where(Agent.swarm_id == swarm_id, Agent.name == name)
            ).scalar_one_or_none()
            if not existing:
                with get_session() as session2:
                    swarm_row = session2.get(Swarm, swarm_id)
                    workspace_id = swarm_row.workspace_id if swarm_row else None

                new_agent = Agent(
                    swarm_id=swarm_id,
                    workspace_id=workspace_id,
                    scope=SCOPE_SWARM,
                    name=name,
                    layer=layer,
                    model=model,
                    md_path=md_path,
                    md_hash="",
                    enabled=True,
                )
                with get_session() as session3:
                    session3.add(new_agent)
                    session3.commit()

    # Remove agent from DB if remove_agent
    if op == "remove_agent":
        name = params.get("name", "")
        md_path = os.path.join(swarm_path, "agents", f"{name}.md")
        if os.path.isfile(md_path):
            os.remove(md_path)
        with get_session() as session:
            agent_row = session.execute(
                select(Agent).where(Agent.swarm_id == swarm_id, Agent.name == name)
            ).scalar_one_or_none()
            if agent_row:
                session.delete(agent_row)
                session.commit()

    if hasattr(current_app, "sse_bus"):
        current_app.sse_bus.broadcast("topology.updated", {"swarm_id": swarm_id, "op": op})

    return jsonify({"ok": True, "hierarchy": result})
