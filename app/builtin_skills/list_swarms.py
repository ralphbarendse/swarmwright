"""Built-in skill: list swarms across workspaces with their enabled status."""
from __future__ import annotations
import json, os, sqlite3, sys


def run(input_data: dict, context: dict) -> dict:
    data_dir     = context["data_dir"]
    workspace_id = input_data.get("workspace_id")   # optional filter
    db_path      = os.path.join(data_dir, "swarm.db")

    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        sql = """
            SELECT s.id, s.name, s.display_name, s.description,
                   s.enabled, s.source,
                   w.id   AS workspace_id,
                   w.name AS workspace_name,
                   w.display_name AS workspace_display_name
            FROM swarms s
            JOIN workspaces w ON w.id = s.workspace_id
            WHERE w.name != 'platform'
        """
        params: list = []
        if workspace_id:
            sql += " AND s.workspace_id = ?"
            params.append(workspace_id)
        sql += " ORDER BY w.name, s.name"
        rows = con.execute(sql, params).fetchall()
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
