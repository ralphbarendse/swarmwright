from __future__ import annotations

import hashlib
import json
import os
import re
import shutil

import yaml
from flask import Blueprint, jsonify, request, current_app
from pydantic import BaseModel, field_validator
from sqlalchemy import select, func

from app.core.auth import require_permission
from app.db import get_session
from app.models.workspace import Workspace
from app.models.swarm import Swarm
from app.models.agent import Agent, LAYER_PERCEPTIONIST
from app.models.trigger import Trigger
from app.models.run import Run, STATUS_RUNNING
from app.models.run_step import RunStep

bp = Blueprint("workspaces", __name__, url_prefix="/api/v1")


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class WorkspaceCreate(BaseModel):
    display_name: str
    description: str | None = None
    icon: str | None = None

    @field_validator("display_name")
    @classmethod
    def display_name_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("display_name must not be empty")
        return v.strip()


class WorkspaceUpdate(BaseModel):
    display_name: str | None = None
    description: str | None = None
    icon: str | None = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _slugify(text: str) -> str:
    """Convert display name to a filesystem-safe slug."""
    slug = re.sub(r"[^\w\s-]", "", text.lower())
    slug = re.sub(r"[\s_]+", "-", slug).strip("-")
    return slug or "workspace"


def _write_meta(folder: str, data: dict) -> str:
    """Write meta.yaml and return its sha256 hash."""
    path = os.path.join(folder, "meta.yaml")
    content = yaml.dump(data, allow_unicode=True, default_flow_style=False)
    with open(path, "w") as f:
        f.write(content)
    return hashlib.sha256(content.encode()).hexdigest()


# ── Routes ────────────────────────────────────────────────────────────────────

@bp.get("/workspaces")
def list_workspaces():
    with get_session() as session:
        rows = session.execute(select(Workspace).order_by(Workspace.display_name)).scalars().all()
        counts = dict(
            session.execute(
                select(Swarm.workspace_id, func.count(Swarm.id))
                .group_by(Swarm.workspace_id)
            ).all()
        )
        result = []
        for w in rows:
            d = w.to_dict()
            d["swarm_count"] = counts.get(w.id, 0)
            result.append(d)
        return jsonify(result)


@bp.get("/workspaces/<workspace_id>")
def get_workspace(workspace_id: str):
    with get_session() as session:
        workspace = session.get(Workspace, workspace_id)
        if not workspace:
            return jsonify({"error": {"code": "not_found", "message": "Workspace not found"}}), 404
        swarms = session.execute(
            select(Swarm).where(Swarm.workspace_id == workspace_id).order_by(Swarm.display_name)
        ).scalars().all()
        swarm_ids = [s.id for s in swarms]

        # Batch counts for agents and triggers
        agent_counts = dict(session.execute(
            select(Agent.swarm_id, func.count()).where(Agent.swarm_id.in_(swarm_ids))
            .group_by(Agent.swarm_id)
        ).all()) if swarm_ids else {}

        trigger_counts = dict(session.execute(
            select(Trigger.swarm_id, func.count()).where(Trigger.swarm_id.in_(swarm_ids))
            .group_by(Trigger.swarm_id)
        ).all()) if swarm_ids else {}

        running_counts = dict(session.execute(
            select(Run.swarm_id, func.count()).where(
                Run.swarm_id.in_(swarm_ids), Run.status == STATUS_RUNNING
            ).group_by(Run.swarm_id)
        ).all()) if swarm_ids else {}

        # Last run per swarm (most recent started_at)
        last_runs = {}
        if swarm_ids:
            for row in session.execute(
                select(Run.swarm_id, func.max(Run.started_at), Run.status)
                .where(Run.swarm_id.in_(swarm_ids), Run.started_at.isnot(None))
                .group_by(Run.swarm_id)
            ).all():
                last_runs[row[0]] = {"started_at": row[1].isoformat() if row[1] else None, "status": row[2]}

        # Workspace-level perceptionist count
        percep_count = session.execute(
            select(func.count()).select_from(Agent)
            .where(Agent.workspace_id == workspace_id, Agent.layer == LAYER_PERCEPTIONIST)
        ).scalar() or 0

        # Workspace-level stats: total runs, total tokens, last active
        ws_total_runs = 0
        ws_total_tokens = 0
        ws_last_active = None
        if swarm_ids:
            ws_total_runs = session.execute(
                select(func.count()).select_from(Run).where(Run.swarm_id.in_(swarm_ids))
            ).scalar() or 0
            tok_row = session.execute(
                select(func.sum(RunStep.tokens_input), func.sum(RunStep.tokens_output))
                .join(Run, RunStep.run_id == Run.id)
                .where(Run.swarm_id.in_(swarm_ids))
            ).one()
            ws_total_tokens = (tok_row[0] or 0) + (tok_row[1] or 0)
            last_active_row = session.execute(
                select(func.max(Run.started_at)).where(Run.swarm_id.in_(swarm_ids))
            ).scalar()
            ws_last_active = last_active_row.isoformat() if last_active_row else None

        result = workspace.to_dict()
        result["perceptionist_count"] = percep_count
        result["total_runs"] = ws_total_runs
        result["total_tokens"] = ws_total_tokens
        result["last_active_at"] = ws_last_active
        swarm_dicts = []
        for s in swarms:
            d = s.to_dict()
            d["agent_count"] = agent_counts.get(s.id, 0)
            d["trigger_count"] = trigger_counts.get(s.id, 0)
            d["running_count"] = running_counts.get(s.id, 0)
            d["last_run"] = last_runs.get(s.id)
            swarm_dicts.append(d)
        result["swarms"] = swarm_dicts
        return jsonify(result)


@bp.post("/workspaces")
@require_permission("can_create_workspace")
def create_workspace():
    try:
        body = WorkspaceCreate.model_validate(request.get_json(force=True) or {})
    except Exception as exc:
        return jsonify({"error": {"code": "validation_error", "message": str(exc)}}), 400

    data_dir = current_app.config["DATA_DIR"]
    slug = _slugify(body.display_name)

    with get_session() as session:
        # Ensure unique folder name
        base_slug = slug
        counter = 1
        while session.execute(select(Workspace).where(Workspace.name == slug)).scalar_one_or_none():
            slug = f"{base_slug}-{counter}"
            counter += 1

        folder = os.path.join(data_dir, "workspaces", slug)
        os.makedirs(os.path.join(folder, "knowledge"), exist_ok=True)
        os.makedirs(os.path.join(folder, "skills"), exist_ok=True)
        os.makedirs(os.path.join(folder, "perceptionists"), exist_ok=True)
        os.makedirs(os.path.join(folder, "swarms"), exist_ok=True)

        meta = {"display_name": body.display_name}
        if body.description:
            meta["description"] = body.description
        if body.icon:
            meta["icon"] = body.icon
        meta_hash = _write_meta(folder, meta)

        workspace = Workspace(
            name=slug,
            display_name=body.display_name,
            description=body.description,
            icon=body.icon,
            meta_hash=meta_hash,
        )
        session.add(workspace)
        session.commit()
        session.refresh(workspace)

        # Materialise workspace-scope built-in swarms (e.g. concierge) immediately
        try:
            from app.core.builtin_swarms import reconcile_workspace
            reconcile_workspace(folder)
        except Exception:
            import logging
            logging.getLogger(__name__).exception("Failed to materialise built-in swarms for new workspace")

        return jsonify(workspace.to_dict()), 201


@bp.put("/workspaces/<workspace_id>")
@require_permission("can_edit_workspace")
def update_workspace(workspace_id: str):
    try:
        body = WorkspaceUpdate.model_validate(request.get_json(force=True) or {})
    except Exception as exc:
        return jsonify({"error": {"code": "validation_error", "message": str(exc)}}), 400

    data_dir = current_app.config["DATA_DIR"]

    with get_session() as session:
        workspace = session.get(Workspace, workspace_id)
        if not workspace:
            return jsonify({"error": {"code": "not_found", "message": "Workspace not found"}}), 404

        if body.display_name is not None:
            workspace.display_name = body.display_name
        if body.description is not None:
            workspace.description = body.description
        if body.icon is not None:
            workspace.icon = body.icon

        folder = os.path.join(data_dir, "workspaces", workspace.name)
        meta = {"display_name": workspace.display_name}
        if workspace.description:
            meta["description"] = workspace.description
        if workspace.icon:
            meta["icon"] = workspace.icon
        workspace.meta_hash = _write_meta(folder, meta)

        session.commit()
        session.refresh(workspace)
        return jsonify(workspace.to_dict())


@bp.delete("/workspaces/<workspace_id>")
@require_permission("can_delete_workspace")
def delete_workspace(workspace_id: str):
    with get_session() as session:
        workspace = session.get(Workspace, workspace_id)
        if not workspace:
            return jsonify({"error": {"code": "not_found", "message": "Workspace not found"}}), 404

        swarm_count = session.execute(
            select(Swarm).where(Swarm.workspace_id == workspace_id)
        ).scalars().first()
        if swarm_count:
            return jsonify({
                "error": {
                    "code": "has_swarms",
                    "message": "Cannot delete a workspace that still has swarms. Delete the swarms first.",
                }
            }), 409

        data_dir = current_app.config["DATA_DIR"]
        ws_dir = os.path.join(data_dir, "workspaces", workspace.name)
        session.delete(workspace)
        session.commit()

    if os.path.isdir(ws_dir):
        shutil.rmtree(ws_dir)

    return "", 204
