"""Built-in skill: mark a file from any swarm so the user can preview/download it in chat.

Unlike read_swarm_artifact, this does NOT return the file's contents — it just
validates the file exists and returns its metadata. Use it to surface a file
(including large or binary files) to the user without flooding the agent's
context with the bytes. The chat layer turns these into inline attachments.
"""
from __future__ import annotations
import mimetypes, os, sqlite3


def _resolve_swarm(data_dir: str, swarm_ident: str) -> tuple[str, str]:
    """Return (swarm_id, files_root) for a swarm given its name, id, or id prefix."""
    db_path = os.path.join(data_dir, "swarm.db")
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        sql = (
            "SELECT s.id AS sid, s.name AS sname, w.name AS wname "
            "FROM swarms s JOIN workspaces w ON w.id = s.workspace_id "
        )
        row = con.execute(sql + "WHERE s.id = ? OR s.name = ?", (swarm_ident, swarm_ident)).fetchone()
        if not row:
            row = con.execute(sql + "WHERE s.id LIKE ?", (swarm_ident + "%",)).fetchone()
    finally:
        con.close()
    if not row:
        raise ValueError(f"Swarm '{swarm_ident}' not found")
    files_root = os.path.join(data_dir, "workspaces", row["wname"], "swarms", row["sname"], "files")
    return row["sid"], files_root


def _validate_path(files_root: str, path: str) -> str:
    abs_root = os.path.realpath(files_root)
    abs_path = os.path.realpath(os.path.join(files_root, path))
    if not abs_path.startswith(abs_root + os.sep) and abs_path != abs_root:
        raise ValueError(f"Path '{path}' escapes the swarm file store")
    return abs_path


def run(input_data: dict, context: dict) -> dict:
    data_dir = context["data_dir"]
    swarm_ident = input_data["swarm"]
    path = input_data["path"]

    swarm_id, files_root = _resolve_swarm(data_dir, swarm_ident)
    abs_path = _validate_path(files_root, path)
    if not os.path.isfile(abs_path):
        raise FileNotFoundError(f"File not found: '{path}'")

    mime, _ = mimetypes.guess_type(abs_path)
    return {
        "attached": True,
        "swarm_id": swarm_id,
        "swarm": swarm_ident,
        "path": path,
        "filename": os.path.basename(path),
        "size_bytes": os.path.getsize(abs_path),
        "mime": mime or "application/octet-stream",
    }


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
