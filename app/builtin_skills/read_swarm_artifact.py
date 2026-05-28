"""Built-in skill: read a file from any swarm's files/ directory (operator-level)."""
from __future__ import annotations
import base64, json, os, sqlite3, sys

_MAX_BYTES = 200_000  # guard against flooding the agent's context with a huge file


def _resolve_files_root(data_dir: str, swarm_ident: str) -> str:
    db_path = os.path.join(data_dir, "swarm.db")
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        sql = (
            "SELECT s.name AS sname, w.name AS wname "
            "FROM swarms s JOIN workspaces w ON w.id = s.workspace_id "
        )
        row = con.execute(sql + "WHERE s.id = ? OR s.name = ?", (swarm_ident, swarm_ident)).fetchone()
        if not row:
            row = con.execute(sql + "WHERE s.id LIKE ?", (swarm_ident + "%",)).fetchone()
    finally:
        con.close()
    if not row:
        raise ValueError(f"Swarm '{swarm_ident}' not found")
    return os.path.join(data_dir, "workspaces", row["wname"], "swarms", row["sname"], "files")


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
    encoding = input_data.get("encoding", "utf-8")

    files_root = _resolve_files_root(data_dir, swarm_ident)
    abs_path = _validate_path(files_root, path)
    if not os.path.isfile(abs_path):
        raise FileNotFoundError(f"File not found: '{path}'")

    size_bytes = os.path.getsize(abs_path)
    if size_bytes > _MAX_BYTES:
        return {
            "ok": False,
            "error": "file_too_large",
            "size_bytes": size_bytes,
            "message": (
                f"File '{path}' is {size_bytes} bytes, over the {_MAX_BYTES}-byte read cap. "
                "Use list_swarm_artifacts to confirm it exists and report its size/location to the user "
                "instead of reading the whole file."
            ),
        }

    if encoding == "base64":
        with open(abs_path, "rb") as f:
            content = base64.b64encode(f.read()).decode("ascii")
    else:
        with open(abs_path, encoding=encoding) as f:
            content = f.read()

    return {"content": content, "encoding": encoding, "size_bytes": size_bytes}


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
