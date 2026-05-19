from __future__ import annotations

import hashlib
import logging
import os
import shutil

from flask import Blueprint, current_app, jsonify, request
from pydantic import BaseModel
from sqlalchemy import select

from app.core.auth import require_permission
from app.db import get_session
from app.models.knowledge import KnowledgeDocument
from app.models.swarm import Swarm
from app.models.workspace import Workspace

logger = logging.getLogger(__name__)
bp = Blueprint("knowledge", __name__, url_prefix="/api/v1")

VALID_SCOPES = {"company", "workspace", "swarm"}


class KnowledgeCreate(BaseModel):
    scope: str
    workspace_id: str | None = None
    swarm_id: str | None = None
    name: str
    content: str = ""
    title: str | None = None


class KnowledgeUpdate(BaseModel):
    content: str | None = None
    title: str | None = None


def _scope_folder(scope: str, workspace_id: str | None, swarm_id: str | None, data_dir: str) -> str | None:
    if scope == "company":
        return os.path.join(data_dir, "company", "knowledge")
    if scope == "workspace" and workspace_id:
        with get_session() as session:
            ws = session.get(Workspace, workspace_id)
        if not ws:
            return None
        return os.path.join(data_dir, "workspaces", ws.name, "knowledge")
    if scope == "swarm" and swarm_id:
        with get_session() as session:
            swarm = session.get(Swarm, swarm_id)
            if not swarm:
                return None
            ws = session.get(Workspace, swarm.workspace_id)
        if not ws:
            return None
        return os.path.join(data_dir, "workspaces", ws.name, "swarms", swarm.name, "knowledge")
    return None


@bp.get("/knowledge")
def list_knowledge():
    scope = request.args.get("scope")
    workspace_id = request.args.get("workspace_id")
    swarm_id = request.args.get("swarm_id")

    with get_session() as session:
        q = select(KnowledgeDocument)
        if scope:
            q = q.where(KnowledgeDocument.scope == scope)
        if workspace_id:
            q = q.where(KnowledgeDocument.workspace_id == workspace_id)
        if swarm_id:
            q = q.where(KnowledgeDocument.swarm_id == swarm_id)
        rows = session.execute(q.order_by(KnowledgeDocument.name)).scalars().all()
        return jsonify([r.to_dict() for r in rows])


@bp.get("/knowledge/<doc_id>")
def get_knowledge(doc_id: str):
    with get_session() as session:
        doc = session.get(KnowledgeDocument, doc_id)
        if not doc:
            return jsonify({"error": {"code": "not_found", "message": "Document not found"}}), 404
        data = doc.to_dict()

    if os.path.isfile(data["md_path"]):
        try:
            with open(data["md_path"]) as f:
                data["content"] = f.read()
        except OSError:
            data["content"] = None
    else:
        data["content"] = None
    return jsonify(data)


@bp.post("/knowledge")
@require_permission("can_manage_knowledge")
def create_knowledge():
    try:
        body = KnowledgeCreate.model_validate(request.get_json(force=True) or {})
    except Exception as exc:
        return jsonify({"error": {"code": "validation_error", "message": str(exc)}}), 400

    if body.scope not in VALID_SCOPES:
        return jsonify({"error": {"code": "invalid_scope", "message": f"scope must be one of {VALID_SCOPES}"}}), 400

    data_dir = current_app.config["DATA_DIR"]
    folder = _scope_folder(body.scope, body.workspace_id, body.swarm_id, data_dir)
    if folder is None:
        return jsonify({"error": {"code": "invalid_scope", "message": "Could not resolve scope folder"}}), 400

    os.makedirs(folder, exist_ok=True)
    name = body.name.strip().removesuffix(".md")
    md_path = os.path.join(folder, f"{name}.md")
    if os.path.isfile(md_path):
        return jsonify({"error": {"code": "conflict", "message": f"Document {name!r} already exists"}}), 409

    content = body.content or f"# {name}\n\n"
    with open(md_path, "w") as f:
        f.write(content)

    title = body.title or _extract_title(content) or name
    content_bytes = content.encode()
    md_hash = hashlib.sha256(content_bytes).hexdigest()

    with get_session() as session:
        doc = KnowledgeDocument(
            scope=body.scope,
            workspace_id=body.workspace_id,
            swarm_id=body.swarm_id,
            name=name,
            md_path=md_path,
            md_hash=md_hash,
            size_bytes=len(content_bytes),
            title=title,
        )
        session.add(doc)
        session.commit()
        session.refresh(doc)
        return jsonify(doc.to_dict()), 201


@bp.put("/knowledge/<doc_id>")
@require_permission("can_manage_knowledge")
def update_knowledge(doc_id: str):
    try:
        body = KnowledgeUpdate.model_validate(request.get_json(force=True) or {})
    except Exception as exc:
        return jsonify({"error": {"code": "validation_error", "message": str(exc)}}), 400

    with get_session() as session:
        doc = session.get(KnowledgeDocument, doc_id)
        if not doc:
            return jsonify({"error": {"code": "not_found", "message": "Document not found"}}), 404

        if body.content is not None:
            content = body.content
            with open(doc.md_path, "w") as f:
                f.write(content)
            content_bytes = content.encode()
            doc.md_hash = hashlib.sha256(content_bytes).hexdigest()
            doc.size_bytes = len(content_bytes)
            if body.title is None:
                doc.title = _extract_title(content) or doc.name
        if body.title is not None:
            doc.title = body.title

        session.commit()
        session.refresh(doc)
        return jsonify(doc.to_dict())


@bp.delete("/knowledge/<doc_id>")
@require_permission("can_manage_knowledge")
def delete_knowledge(doc_id: str):
    with get_session() as session:
        doc = session.get(KnowledgeDocument, doc_id)
        if not doc:
            return jsonify({"error": {"code": "not_found", "message": "Document not found"}}), 404
        md_path = doc.md_path
        session.delete(doc)
        session.commit()

    if os.path.isfile(md_path):
        try:
            os.remove(md_path)
        except OSError as exc:
            logger.warning("Could not delete knowledge file %s: %s", md_path, exc)

    return "", 204


class KnowledgeTransfer(BaseModel):
    op: str
    scope: str
    workspace_id: str | None = None
    swarm_id: str | None = None


@bp.post("/knowledge/<doc_id>/transfer")
@require_permission("can_manage_knowledge")
def transfer_knowledge(doc_id: str):
    try:
        body = KnowledgeTransfer.model_validate(request.get_json(force=True) or {})
    except Exception as exc:
        return jsonify({"error": {"code": "validation_error", "message": str(exc)}}), 400

    if body.op not in ("copy", "move"):
        return jsonify({"error": {"code": "validation_error", "message": "op must be 'copy' or 'move'"}}), 400
    if body.scope not in VALID_SCOPES:
        return jsonify({"error": {"code": "invalid_scope", "message": f"scope must be one of {VALID_SCOPES}"}}), 400

    data_dir = current_app.config["DATA_DIR"]

    with get_session() as session:
        doc = session.get(KnowledgeDocument, doc_id)
        if not doc:
            return jsonify({"error": {"code": "not_found", "message": "Document not found"}}), 404
        if doc.scope == body.scope and doc.workspace_id == body.workspace_id and doc.swarm_id == body.swarm_id:
            return jsonify({"error": {"code": "conflict", "message": "Document is already at this destination"}}), 409
        src_path = doc.md_path
        name = doc.name
        title = doc.title
        content = ""
        if os.path.isfile(src_path):
            with open(src_path) as f:
                content = f.read()

    dst_folder = _scope_folder(body.scope, body.workspace_id, body.swarm_id, data_dir)
    if dst_folder is None:
        return jsonify({"error": {"code": "invalid_scope", "message": "Could not resolve destination scope"}}), 400

    os.makedirs(dst_folder, exist_ok=True)
    dst_path = os.path.join(dst_folder, f"{name}.md")

    if os.path.isfile(dst_path):
        return jsonify({"error": {"code": "conflict", "message": f"Document {name!r} already exists at destination"}}), 409

    if body.op == "copy":
        with open(dst_path, "w") as f:
            f.write(content)
        content_bytes = content.encode()
        with get_session() as session:
            new_doc = KnowledgeDocument(
                scope=body.scope,
                workspace_id=body.workspace_id,
                swarm_id=body.swarm_id,
                name=name,
                md_path=dst_path,
                md_hash=hashlib.sha256(content_bytes).hexdigest(),
                size_bytes=len(content_bytes),
                title=title,
            )
            session.add(new_doc)
            session.commit()
            session.refresh(new_doc)
            return jsonify(new_doc.to_dict()), 201
    else:
        if os.path.isfile(src_path):
            shutil.move(src_path, dst_path)
        else:
            with open(dst_path, "w") as f:
                f.write(content)
        with get_session() as session:
            doc = session.get(KnowledgeDocument, doc_id)
            doc.scope = body.scope
            doc.workspace_id = body.workspace_id
            doc.swarm_id = body.swarm_id
            doc.md_path = dst_path
            session.commit()
            session.refresh(doc)
            return jsonify(doc.to_dict())


class KnowledgeDraftRequest(BaseModel):
    prompt: str = ""


@bp.post("/knowledge/<doc_id>/draft")
@require_permission("can_manage_knowledge")
def draft_knowledge(doc_id: str):
    try:
        body = KnowledgeDraftRequest.model_validate(request.get_json(force=True) or {})
    except Exception as exc:
        return jsonify({"error": {"code": "validation_error", "message": str(exc)}}), 400

    with get_session() as session:
        doc = session.get(KnowledgeDocument, doc_id)
        if not doc:
            return jsonify({"error": {"code": "not_found", "message": "Document not found"}}), 404
        doc_name = doc.name
        doc_title = doc.title

    try:
        from app.core.secrets import get_llm_credentials  # noqa: PLC0415
        llm = get_llm_credentials()
        system = (
            "You are a technical writer helping draft knowledge documents for an AI agent swarm platform. "
            "Output only well-structured Markdown. Start with a # heading. Be concise and specific."
        )
        user_msg = f"Document name: {doc_name}\nDocument title: {doc_title or doc_name}\n"
        if body.prompt:
            user_msg += f"\nInstructions: {body.prompt}"
        else:
            user_msg += "\nDraft the content of this knowledge document based on its name and title."
        content = llm.complete(system, [{"role": "user", "content": user_msg}], max_tokens=2048)
    except Exception as exc:
        logger.error("LLM draft failed: %s", exc)
        return jsonify({"error": {"code": "llm_error", "message": str(exc)}}), 502

    return jsonify({"content": content})


def _extract_title(content: str) -> str | None:
    for line in content.splitlines():
        line = line.strip()
        if line.startswith("# "):
            return line[2:].strip()
    return None
