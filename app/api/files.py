from __future__ import annotations

import os

from flask import Blueprint, jsonify, request, current_app, send_file
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.auth import require_permission
from app.db import get_session
from app.models.swarm import Swarm
from app.models.swarm_file import SwarmFile
from app.models.workspace import Workspace
from app.core.file_store import (
    upsert_file,
    remove_file,
    list_files,
    list_all_files,
    resolve_canonical,
    links_to,
    create_link,
    ORIGIN_HUMAN,
)

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


def _resolve_for_serve(swarm_id: str, files_root: str, path: str) -> tuple[str, str, str | None] | None:
    """Resolve (swarm_id, path) to a real file on disk, following a logical link.

    For a link row the bytes live in the canonical row's swarm, so we recompute
    that swarm's files_root. For a normal (or unindexed) file we serve from this
    swarm's own store, preserving legacy behaviour. Returns
    (abs_path, download_name, mime_type) or None if missing/unsafe.
    """
    data_dir = current_app.config["DATA_DIR"]
    with get_session() as session:
        row = session.execute(
            select(SwarmFile).where(SwarmFile.swarm_id == swarm_id, SwarmFile.path == path)
        ).scalar_one_or_none()

        if row is not None and row.links_to_file_id:
            canonical = resolve_canonical(row, session)
            if canonical is None:
                return None  # dangling link
            cswarm = session.get(Swarm, canonical.swarm_id)
            cws = session.get(Workspace, cswarm.workspace_id) if cswarm else None
            if not cswarm or not cws:
                return None
            croot = os.path.join(data_dir, "workspaces", cws.name, "swarms", cswarm.name, "files")
            abs_path = _safe_path(croot, canonical.path)
            name = os.path.basename(canonical.path)
            mime = canonical.mime_type
        else:
            abs_path = _safe_path(files_root, path)
            name = os.path.basename(path)
            mime = row.mime_type if row else None

    if abs_path is None or not os.path.isfile(abs_path):
        return None
    return abs_path, name, mime


@bp.get("/files")
@require_permission("can_read_files")
def list_all():
    """Org-wide file index across every swarm — read-only browser surface.

    Query params: `search` (filename/path substring), `workspace_id` (filter),
    `limit`/`offset` (pagination). Returns ``{"rows": [...], "total": N}``. Each row
    carries swarm + workspace ids and display names for grouping, plus link
    provenance. Bytes are fetched via the per-swarm download/raw routes.
    """
    search = request.args.get("search") or None
    workspace_id = request.args.get("workspace_id") or None
    try:
        limit = min(max(int(request.args.get("limit", 500)), 1), 1000)
        offset = max(int(request.args.get("offset", 0)), 0)
    except (TypeError, ValueError):
        limit, offset = 500, 0
    return jsonify(list_all_files(search=search, workspace_id=workspace_id, limit=limit, offset=offset))


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

    resolved = _resolve_for_serve(swarm_id, files_root, path)
    if resolved is None:
        return jsonify({"error": {"code": "not_found", "message": "File not found"}}), 404

    abs_path, name, _mime = resolved
    return send_file(abs_path, as_attachment=True, download_name=name)


@bp.get("/swarms/<swarm_id>/files/raw")
def raw_swarm_file(swarm_id: str):
    """Serve a file inline (not as an attachment) for in-browser preview.

    Same link resolution as download — a link serves its canonical bytes — but
    with ``as_attachment=False`` and the indexed mime type so images/PDFs render
    in <img>/<iframe> and text can be fetched into a preview panel.
    """
    swarm, files_root = _get_swarm_files_root(swarm_id)
    if swarm is None:
        return jsonify({"error": {"code": "not_found", "message": "Swarm not found"}}), 404

    path = request.args.get("path", "")
    if not path:
        return jsonify({"error": {"code": "validation_error", "message": "path query param required"}}), 400

    resolved = _resolve_for_serve(swarm_id, files_root, path)
    if resolved is None:
        return jsonify({"error": {"code": "not_found", "message": "File not found"}}), 404

    abs_path, name, mime = resolved
    return send_file(abs_path, as_attachment=False, download_name=name, mimetype=mime or None)


@bp.post("/swarms/<swarm_id>/files/link")
@require_permission("can_edit_swarm")
def link_swarm_file(swarm_id: str):
    """Create a logical link in this swarm pointing at a canonical file elsewhere.

    Body: ``{"source_file_id": <id>, "path": <optional dest path>}``. The bytes
    stay with the canonical file; this swarm just gets a reference row.
    """
    swarm, files_root = _get_swarm_files_root(swarm_id)
    if swarm is None:
        return jsonify({"error": {"code": "not_found", "message": "Swarm not found"}}), 404

    body = request.get_json(silent=True) or {}
    source_file_id = body.get("source_file_id")
    path = body.get("path") or None
    if not source_file_id:
        return jsonify({"error": {"code": "validation_error", "message": "source_file_id required"}}), 400

    if path is not None and _safe_path(files_root, path) is None:
        return jsonify({"error": {"code": "validation_error", "message": "Path escapes file store"}}), 400

    try:
        row = create_link(swarm_id, source_file_id, path)
    except ValueError as e:
        return jsonify({"error": {"code": "not_found", "message": str(e)}}), 404
    except IntegrityError:
        return jsonify({"error": {"code": "conflict", "message": "A file already exists at that path in this swarm"}}), 409

    return jsonify(row.to_dict()), 201


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

    # Inspect the index row to handle links and protect canonical files.
    with get_session() as session:
        row = session.execute(
            select(SwarmFile).where(SwarmFile.swarm_id == swarm_id, SwarmFile.path == path)
        ).scalar_one_or_none()

        if row is not None and row.links_to_file_id:
            # Deleting a link removes only the reference row — never the bytes.
            session.delete(row)
            session.commit()
            return "", 204

        if row is not None:
            linkers = links_to(row.id, session)
            if linkers:
                names = sorted({
                    (session.get(Swarm, lk.swarm_id).display_name
                     or session.get(Swarm, lk.swarm_id).name)
                    for lk in linkers
                    if session.get(Swarm, lk.swarm_id) is not None
                })
                joined = ", ".join(names) or "another swarm"
                return jsonify({"error": {
                    "code": "conflict",
                    "message": f"This file is linked by: {joined}. Remove those links first.",
                }}), 409

    if not os.path.isfile(abs_path):
        return jsonify({"error": {"code": "not_found", "message": "File not found"}}), 404

    os.remove(abs_path)
    remove_file(swarm_id, path)

    return "", 204
