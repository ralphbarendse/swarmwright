"""Built-in skill: list swarms in the current swarm's workspace."""
from __future__ import annotations
import json, os, sqlite3, sys


def run(input_data: dict, context: dict) -> dict:
    data_dir = context["data_dir"]
    swarm_id = context["swarm_id"]
    db_path = os.path.join(data_dir, "swarm.db")

    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        # Find workspace_id for the current swarm
        row = con.execute("SELECT workspace_id FROM swarms WHERE id = ?", (swarm_id,)).fetchone()
        if not row:
            return {"swarms": []}
        workspace_id = row["workspace_id"]

        rows = con.execute(
            "SELECT name, display_name, description, enabled FROM swarms "
            "WHERE workspace_id = ? AND name != 'concierge' ORDER BY name",
            (workspace_id,),
        ).fetchall()
    finally:
        con.close()

    return {"swarms": [{**dict(r), "enabled": bool(r["enabled"])} for r in rows]}


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
