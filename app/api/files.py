from __future__ import annotations

import os

from flask import Blueprint, jsonify, request, current_app, send_file
from sqlalchemy import select

from app.core.auth import require_permission
from app.db import get_session
from app.models.swarm import Swarm
from app.models.swarm_file import SwarmFile
from app.models.workspace import Workspace
from app.core.file_store import upsert_file, remove_file, list_files, ORIGIN_HUMAN

bp = Blueprint("files", __name__, url_prefix="/api/v1")

_MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB


def _get_swarm_files_root(swarm_id: str) -> tuple[Swarm, str] | tuple[None, None]:
    """Return (swarm, files_root) or (None, None) if swarm not found."""
    data_dir = current_app.config["DATA_DIR"]
    with get_session() as session:
        swarm = session.get(Swarm, swarm_id)
        if not swarm:
            return None, None
        workspace = session.get(Workspace, swarm.workspace_id)
        if not workspace:
            return None, None
        files_root = os.path.join(
            data_dir, "workspaces", workspace.name, "swarms", swarm.name, "files"
        )
        return swarm, files_root


def _safe_path(files_root: str, path: str) -> str | None:
    """Resolve path and return abs path if it stays inside files_root, else None."""
    abs_root = os.path.realpath(files_root)
    abs_path = os.path.realpath(os.path.join(files_root, path))
    if abs_path.startswith(abs_root + os.sep) or abs_path == abs_root:
        return abs_path
    return None


@bp.get("/swarms/<swarm_id>/files")
def list_swarm_files(swarm_id: str):
    swarm, files_root = _get_swarm_files_root(swarm_id)
    if swarm is None:
        return jsonify({"error": {"code": "not_found", "message": "Swarm not found"}}), 404

    prefix = request.args.get("prefix")
    rows = list_files(swarm_id, prefix=prefix)
    return jsonify([r.to_dict() for r in rows])


@bp.post("/swarms/<swarm_id>/files")
@require_permission("can_edit_swarm")
def upload_swarm_file(swarm_id: str):
    swarm, files_root = _get_swarm_files_root(swarm_id)
    if swarm is None:
        return jsonify({"error": {"code": "not_found", "message": "Swarm not found"}}), 404

    if "file" not in request.files:
        return jsonify({"error": {"code": "validation_error", "message": "No file field in request"}}), 400

    uploaded = request.files["file"]
    path_override = request.form.get("path") or uploaded.filename or "upload"
    overwrite = request.args.get("overwrite", "false").lower() == "true"

    if not path_override or path_override in ("", "."):
        return jsonify({"error": {"code": "validation_error", "message": "Invalid file path"}}), 400

    # Path safety
    abs_path = _safe_path(files_root, path_override)
    if abs_path is None:
        return jsonify({"error": {"code": "validation_error", "message": "Path escapes file store"}}), 400

    # Conflict check
    if not overwrite and os.path.isfile(abs_path):
        return jsonify({"error": {"code": "conflict", "message": "File already exists. Pass overwrite=true to replace."}}), 409

    # Size check (read into memory for hashing; reject oversized files)
    data = uploaded.read(_MAX_UPLOAD_BYTES + 1)
    if len(data) > _MAX_UPLOAD_BYTES:
        return jsonify({"error": {"code": "payload_too_large", "message": f"File exceeds {_MAX_UPLOAD_BYTES // (1024*1024)} MB limit"}}), 413

    os.makedirs(os.path.dirname(abs_path), exist_ok=True)
    with open(abs_path, "wb") as f:
        f.write(data)

    import hashlib
    checksum = hashlib.sha256(data).hexdigest()

    row = upsert_file(
        swarm_id=swarm_id,
        path=path_override,
        size_bytes=len(data),
        checksum=checksum,
        origin=ORIGIN_HUMAN,
    )
    return jsonify(row.to_dict()), 201


@bp.get("/swarms/<swarm_id>/files/download")
def download_swarm_file(swarm_id: str):
    swarm, files_root = _get_swarm_files_root(swarm_id)
    if swarm is None:
        return jsonify({"error": {"code": "not_found", "message": "Swarm not found"}}), 404

    path = request.args.get("path", "")
    if not path:
        return jsonify({"error": {"code": "validation_error", "message": "path query param required"}}), 400

    abs_path = _safe_path(files_root, path)
    if abs_path is None:
        return jsonify({"error": {"code": "validation_error", "message": "Path escapes file store"}}), 400

    if not os.path.isfile(abs_path):
        return jsonify({"error": {"code": "not_found", "message": "File not found"}}), 404

    return send_file(abs_path, as_attachment=True, download_name=os.path.basename(path))


@bp.delete("/swarms/<swarm_id>/files")
@require_permission("can_edit_swarm")
def delete_swarm_file(swarm_id: str):
    swarm, files_root = _get_swarm_files_root(swarm_id)
    if swarm is None:
        return jsonify({"error": {"code": "not_found", "message": "Swarm not found"}}), 404

    path = request.args.get("path", "")
    if not path:
        return jsonify({"error": {"code": "validation_error", "message": "path query param required"}}), 400

    abs_path = _safe_path(files_root, path)
    if abs_path is None:
        return jsonify({"error": {"code": "validation_error", "message": "Path escapes file store"}}), 400

    if not os.path.isfile(abs_path):
        return jsonify({"error": {"code": "not_found", "message": "File not found"}}), 404

    os.remove(abs_path)
    remove_file(swarm_id, path)

    return "", 204
