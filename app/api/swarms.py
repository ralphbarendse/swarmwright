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
from app.models.agent import Agent
from app.models.trigger import Trigger

bp = Blueprint("swarms", __name__, url_prefix="/api/v1")

_EMPTY_HIERARCHY = {
    "swarm": "",
    "agents": [],
    "edges": [],
    "consultations": [],
    "skills": [],
    "entry_point": None,
}


class SwarmCreate(BaseModel):
    display_name: str
    description: str | None = None
    icon: str | None = None

    @field_validator("display_name")
    @classmethod
    def display_name_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("display_name must not be empty")
        return v.strip()


class SwarmUpdate(BaseModel):
    display_name: str | None = None
    description: str | None = None
    icon: str | None = None
    enabled: bool | None = None


def _slugify(text: str) -> str:
    slug = re.sub(r"[^\w\s-]", "", text.lower())
    slug = re.sub(r"[\s_]+", "-", slug).strip("-")
    return slug or "swarm"


def _write_meta(folder: str, data: dict) -> str:
    path = os.path.join(folder, "meta.yaml")
    content = yaml.dump(data, allow_unicode=True, default_flow_style=False)
    with open(path, "w") as f:
        f.write(content)
    return hashlib.sha256(content.encode()).hexdigest()


def _write_hierarchy(folder: str, name: str) -> str:
    hierarchy = dict(_EMPTY_HIERARCHY)
    hierarchy["swarm"] = name
    content = json.dumps(hierarchy, indent=2)
    path = os.path.join(folder, "hierarchy.json")
    with open(path, "w") as f:
        f.write(content)
    return hashlib.sha256(content.encode()).hexdigest()


@bp.get("/workspaces/<workspace_id>/swarms")
def list_swarms(workspace_id: str):
    with get_session() as session:
        if not session.get(Workspace, workspace_id):
            return jsonify({"error": {"code": "not_found", "message": "Workspace not found"}}), 404
        rows = session.execute(
            select(Swarm).where(Swarm.workspace_id == workspace_id).order_by(Swarm.display_name)
        ).scalars().all()
        return jsonify([s.to_dict() for s in rows])


@bp.get("/swarms/<swarm_id>")
def get_swarm(swarm_id: str):
    import json as _json
    data_dir = current_app.config["DATA_DIR"]
    with get_session() as session:
        swarm = session.get(Swarm, swarm_id)
        if not swarm:
            return jsonify({"error": {"code": "not_found", "message": "Swarm not found"}}), 404
        workspace = session.get(Workspace, swarm.workspace_id)
        agents = session.execute(
            select(Agent).where(Agent.swarm_id == swarm_id)
        ).scalars().all()
        triggers = session.execute(
            select(Trigger).where(Trigger.swarm_id == swarm_id)
        ).scalars().all()
        result = swarm.to_dict()
        result["agents"] = [a.to_dict() for a in agents]
        result["triggers"] = [t.to_dict() for t in triggers]

        # Include run count for display
        from app.models.run import Run
        from sqlalchemy import func
        run_count = session.execute(
            select(func.count()).select_from(Run).where(Run.swarm_id == swarm_id)
        ).scalar() or 0
        result["run_count"] = run_count

        if workspace:
            swarm_path = os.path.join(
                data_dir, "workspaces", workspace.name, "swarms", swarm.name
            )
            hierarchy_path = os.path.join(swarm_path, "hierarchy.json")
            if os.path.isfile(hierarchy_path):
                try:
                    with open(hierarchy_path) as f:
                        result["hierarchy"] = _json.load(f)
                except Exception:
                    result["hierarchy"] = None
            else:
                result["hierarchy"] = None

        return jsonify(result)


@bp.post("/workspaces/<workspace_id>/swarms")
def create_swarm(workspace_id: str):
    try:
        body = SwarmCreate.model_validate(request.get_json(force=True) or {})
    except Exception as exc:
        return jsonify({"error": {"code": "validation_error", "message": str(exc)}}), 400

    data_dir = current_app.config["DATA_DIR"]

    with get_session() as session:
        workspace = session.get(Workspace, workspace_id)
        if not workspace:
            return jsonify({"error": {"code": "not_found", "message": "Workspace not found"}}), 404

        slug = _slugify(body.display_name)
        base_slug = slug
        counter = 1
        while session.execute(
            select(Swarm).where(Swarm.workspace_id == workspace_id, Swarm.name == slug)
        ).scalar_one_or_none():
            slug = f"{base_slug}-{counter}"
            counter += 1

        folder = os.path.join(data_dir, "workspaces", workspace.name, "swarms", slug)
        for sub in ["agents", "knowledge", "skills", "triggers"]:
            os.makedirs(os.path.join(folder, sub), exist_ok=True)

        meta = {"display_name": body.display_name}
        if body.description:
            meta["description"] = body.description
        if body.icon:
            meta["icon"] = body.icon
        meta_hash = _write_meta(folder, meta)
        hierarchy_hash = _write_hierarchy(folder, slug)

        swarm = Swarm(
            workspace_id=workspace_id,
            name=slug,
            display_name=body.display_name,
            description=body.description,
            icon=body.icon,
            meta_hash=meta_hash,
            hierarchy_hash=hierarchy_hash,
        )
        session.add(swarm)
        session.commit()
        session.refresh(swarm)
        return jsonify(swarm.to_dict()), 201


@bp.put("/swarms/<swarm_id>")
def update_swarm(swarm_id: str):
    try:
        body = SwarmUpdate.model_validate(request.get_json(force=True) or {})
    except Exception as exc:
        return jsonify({"error": {"code": "validation_error", "message": str(exc)}}), 400

    data_dir = current_app.config["DATA_DIR"]

    with get_session() as session:
        swarm = session.get(Swarm, swarm_id)
        if not swarm:
            return jsonify({"error": {"code": "not_found", "message": "Swarm not found"}}), 404
        workspace = session.get(Workspace, swarm.workspace_id)

        if body.display_name is not None:
            swarm.display_name = body.display_name
        if body.description is not None:
            swarm.description = body.description
        if body.icon is not None:
            swarm.icon = body.icon
        if body.enabled is not None:
            swarm.enabled = body.enabled

        if any(v is not None for v in [body.display_name, body.description, body.icon]):
            folder = os.path.join(data_dir, "workspaces", workspace.name, "swarms", swarm.name)
            meta = {"display_name": swarm.display_name}
            if swarm.description:
                meta["description"] = swarm.description
            if swarm.icon:
                meta["icon"] = swarm.icon
            swarm.meta_hash = _write_meta(folder, meta)

        session.commit()
        session.refresh(swarm)
        return jsonify(swarm.to_dict())


def _extract_title_from_md(content: str) -> str | None:
    for line in content.splitlines():
        line = line.strip()
        if line.startswith("# "):
            return line[2:].strip()
    return None


@bp.post("/swarms/<swarm_id>/copy")
def copy_swarm(swarm_id: str):
    body = request.get_json(force=True) or {}
    target_ws_id = body.get("target_workspace_id")
    if not target_ws_id:
        return jsonify({"error": {"code": "validation_error", "message": "target_workspace_id required"}}), 400

    data_dir = current_app.config["DATA_DIR"]

    with get_session() as session:
        swarm = session.get(Swarm, swarm_id)
        if not swarm:
            return jsonify({"error": {"code": "not_found", "message": "Swarm not found"}}), 404
        src_ws = session.get(Workspace, swarm.workspace_id)
        if not src_ws:
            return jsonify({"error": {"code": "invalid_state", "message": "Source workspace not found"}}), 500
        dst_ws = session.get(Workspace, target_ws_id)
        if not dst_ws:
            return jsonify({"error": {"code": "not_found", "message": "Target workspace not found"}}), 404

        src_dir = os.path.join(data_dir, "workspaces", src_ws.name, "swarms", swarm.name)
        same_ws = target_ws_id == swarm.workspace_id

        slug = swarm.name
        counter = 1
        while session.execute(
            select(Swarm).where(Swarm.workspace_id == target_ws_id, Swarm.name == slug)
        ).scalar_one_or_none():
            slug = f"{swarm.name}-copy" if counter == 1 else f"{swarm.name}-copy-{counter}"
            counter += 1

        dst_dir = os.path.join(data_dir, "workspaces", dst_ws.name, "swarms", slug)
        swarm_display = swarm.display_name
        swarm_desc = swarm.description
        swarm_icon = swarm.icon

    if not os.path.isdir(src_dir):
        return jsonify({"error": {"code": "invalid_state", "message": "Source swarm directory not found"}}), 500

    shutil.copytree(src_dir, dst_dir)

    hierarchy_path = os.path.join(dst_dir, "hierarchy.json")
    hier_content = ""
    if os.path.isfile(hierarchy_path):
        with open(hierarchy_path) as f:
            hierarchy = json.load(f)
        hierarchy["swarm"] = slug
        hier_content = json.dumps(hierarchy, indent=2)
        with open(hierarchy_path, "w") as f:
            f.write(hier_content)

    meta_path = os.path.join(dst_dir, "meta.yaml")
    meta_content = open(meta_path).read() if os.path.isfile(meta_path) else ""
    meta_hash = hashlib.sha256(meta_content.encode()).hexdigest()
    hier_hash = hashlib.sha256(hier_content.encode()).hexdigest()

    import frontmatter as fm_lib
    from app.models.knowledge import KnowledgeDocument

    with get_session() as session:
        display_name = swarm_display + (" (copy)" if same_ws else "")
        new_swarm = Swarm(
            workspace_id=target_ws_id,
            name=slug,
            display_name=display_name,
            description=swarm_desc,
            icon=swarm_icon,
            meta_hash=meta_hash,
            hierarchy_hash=hier_hash,
        )
        session.add(new_swarm)
        session.flush()

        agents_dir = os.path.join(dst_dir, "agents")
        if os.path.isdir(agents_dir):
            for fname in sorted(os.listdir(agents_dir)):
                if not fname.endswith(".md"):
                    continue
                name = fname[:-3]
                md_path = os.path.join(agents_dir, fname)
                layer, model = "executioner", None
                try:
                    with open(md_path) as f:
                        post = fm_lib.loads(f.read())
                    layer = post.get("layer", "executioner") or "executioner"
                    model = post.get("model")
                except Exception:
                    pass
                raw = open(md_path, "rb").read()
                session.add(Agent(
                    swarm_id=new_swarm.id,
                    workspace_id=None,
                    scope="swarm",
                    name=name,
                    layer=layer,
                    model=model,
                    md_path=md_path,
                    md_hash=hashlib.sha256(raw).hexdigest(),
                ))

        knowledge_dir = os.path.join(dst_dir, "knowledge")
        if os.path.isdir(knowledge_dir):
            for fname in sorted(os.listdir(knowledge_dir)):
                if not fname.endswith(".md"):
                    continue
                name = fname[:-3]
                md_path = os.path.join(knowledge_dir, fname)
                try:
                    with open(md_path) as f:
                        content = f.read()
                except OSError:
                    content = ""
                content_bytes = content.encode()
                session.add(KnowledgeDocument(
                    scope="swarm",
                    workspace_id=None,
                    swarm_id=new_swarm.id,
                    name=name,
                    md_path=md_path,
                    md_hash=hashlib.sha256(content_bytes).hexdigest(),
                    size_bytes=len(content_bytes),
                    title=_extract_title_from_md(content) or name,
                ))

        session.commit()
        session.refresh(new_swarm)
        return jsonify(new_swarm.to_dict()), 201


@bp.post("/swarms/<swarm_id>/move")
def move_swarm(swarm_id: str):
    body = request.get_json(force=True) or {}
    target_ws_id = body.get("target_workspace_id")
    if not target_ws_id:
        return jsonify({"error": {"code": "validation_error", "message": "target_workspace_id required"}}), 400

    data_dir = current_app.config["DATA_DIR"]

    with get_session() as session:
        swarm = session.get(Swarm, swarm_id)
        if not swarm:
            return jsonify({"error": {"code": "not_found", "message": "Swarm not found"}}), 404
        if swarm.workspace_id == target_ws_id:
            return jsonify({"error": {"code": "invalid_request", "message": "Swarm is already in this workspace"}}), 400
        src_ws = session.get(Workspace, swarm.workspace_id)
        if not src_ws:
            return jsonify({"error": {"code": "invalid_state", "message": "Source workspace not found"}}), 500
        dst_ws = session.get(Workspace, target_ws_id)
        if not dst_ws:
            return jsonify({"error": {"code": "not_found", "message": "Target workspace not found"}}), 404

        src_dir = os.path.join(data_dir, "workspaces", src_ws.name, "swarms", swarm.name)
        old_name = swarm.name

        slug = swarm.name
        counter = 1
        while session.execute(
            select(Swarm).where(Swarm.workspace_id == target_ws_id, Swarm.name == slug)
        ).scalar_one_or_none():
            slug = f"{old_name}-{counter}"
            counter += 1

        dst_dir = os.path.join(data_dir, "workspaces", dst_ws.name, "swarms", slug)

    shutil.move(src_dir, dst_dir)

    if slug != old_name:
        hierarchy_path = os.path.join(dst_dir, "hierarchy.json")
        if os.path.isfile(hierarchy_path):
            with open(hierarchy_path) as f:
                hierarchy = json.load(f)
            hierarchy["swarm"] = slug
            with open(hierarchy_path, "w") as f:
                json.dump(hierarchy, f, indent=2)

    from app.models.knowledge import KnowledgeDocument

    with get_session() as session:
        swarm = session.get(Swarm, swarm_id)
        swarm.workspace_id = target_ws_id
        swarm.name = slug

        agents = session.execute(select(Agent).where(Agent.swarm_id == swarm_id)).scalars().all()
        for agent in agents:
            agent.md_path = agent.md_path.replace(src_dir, dst_dir, 1)

        docs = session.execute(select(KnowledgeDocument).where(KnowledgeDocument.swarm_id == swarm_id)).scalars().all()
        for doc in docs:
            doc.md_path = doc.md_path.replace(src_dir, dst_dir, 1)

        session.commit()
        session.refresh(swarm)
        result = swarm.to_dict()

    from app.core import registry
    registry._hierarchy_cache.pop(swarm_id, None)

    return jsonify(result)


@bp.delete("/swarms/<swarm_id>")
def delete_swarm(swarm_id: str):
    with get_session() as session:
        swarm = session.get(Swarm, swarm_id)
        if not swarm:
            return jsonify({"error": {"code": "not_found", "message": "Swarm not found"}}), 404
        workspace = session.get(Workspace, swarm.workspace_id)
        swarm_dir = None
        if workspace:
            data_dir = current_app.config["DATA_DIR"]
            swarm_dir = os.path.join(data_dir, "workspaces", workspace.name, "swarms", swarm.name)
        session.delete(swarm)
        session.commit()

    from app.core import registry
    registry._hierarchy_cache.pop(swarm_id, None)

    if swarm_dir and os.path.isdir(swarm_dir):
        shutil.rmtree(swarm_dir)

    return "", 204
