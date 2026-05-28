"""Built-in skill: list all workspaces."""
from __future__ import annotations
import json, os, sqlite3, sys


def run(input_data: dict, context: dict) -> dict:
    db_path = os.path.join(context["data_dir"], "swarm.db")
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            "SELECT id, name, display_name, description FROM workspaces"
            " WHERE name != 'platform' ORDER BY display_name"
        ).fetchall()
    finally:
        con.close()
    return {"workspaces": [dict(r) for r in rows]}


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
