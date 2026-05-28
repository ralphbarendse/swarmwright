"""Built-in skill: list unmet needs from the platform queue."""
from __future__ import annotations
import json, os, sqlite3, sys


def run(input_data: dict, context: dict) -> dict:
    data_dir = context["data_dir"]
    db_path = os.path.join(data_dir, "swarm.db")
    status = input_data.get("status", "open")
    workspace_id = input_data.get("workspace_id")
    limit = int(input_data.get("limit", 20))

    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        if workspace_id:
            rows = con.execute(
                "SELECT * FROM unmet_needs WHERE workspace_id = ? AND status = ? "
                "ORDER BY created_at DESC LIMIT ?",
                (workspace_id, status, limit),
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM unmet_needs WHERE status = ? ORDER BY created_at DESC LIMIT ?",
                (status, limit),
            ).fetchall()
    finally:
        con.close()

    return {"needs": [dict(r) for r in rows]}


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
