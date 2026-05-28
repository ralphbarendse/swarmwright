"""Built-in skill: list files in any swarm's files/ directory (operator-level)."""
from __future__ import annotations
import json, os, sqlite3, sys


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


def run(input_data: dict, context: dict) -> dict:
    data_dir = context["data_dir"]
    swarm_ident = input_data["swarm"]
    prefix = input_data.get("prefix", "")

    files_root = _resolve_files_root(data_dir, swarm_ident)
    if not os.path.isdir(files_root):
        return {"files": []}

    results = []
    for dirpath, _, filenames in os.walk(files_root):
        for fname in sorted(filenames):
            abs_path = os.path.join(dirpath, fname)
            rel_path = os.path.relpath(abs_path, files_root)
            if prefix and not rel_path.startswith(prefix):
                continue
            stat = os.stat(abs_path)
            results.append({
                "path": rel_path,
                "filename": fname,
                "size_bytes": stat.st_size,
                "modified_at": stat.st_mtime,
            })

    results.sort(key=lambda f: f["path"])
    return {"files": results}


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
