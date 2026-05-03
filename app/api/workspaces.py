from __future__ import annotations

import hashlib
import json
import os
import re
import shutil

import yaml
from flask import Blueprint, jsonify, request, current_app
from pydantic import BaseModel, field_validator
from sqlalchemy import select

from app.db import get_session
from app.models.workspace import Workspace
from app.models.swarm import Swarm

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
        return jsonify([w.to_dict() for w in rows])


@bp.get("/workspaces/<workspace_id>")
def get_workspace(workspace_id: str):
    with get_session() as session:
        workspace = session.get(Workspace, workspace_id)
        if not workspace:
            return jsonify({"error": {"code": "not_found", "message": "Workspace not found"}}), 404
        swarms = session.execute(
            select(Swarm).where(Swarm.workspace_id == workspace_id).order_by(Swarm.display_name)
        ).scalars().all()
        result = workspace.to_dict()
        result["swarms"] = [s.to_dict() for s in swarms]
        return jsonify(result)


@bp.post("/workspaces")
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
        return jsonify(workspace.to_dict()), 201


@bp.put("/workspaces/<workspace_id>")
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
