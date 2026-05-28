"""Built-in skill: list recent runs from the database."""
from __future__ import annotations
import json, os, sqlite3, sys


def run(input_data: dict, context: dict) -> dict:
    data_dir = context["data_dir"]
    limit    = int(input_data.get("limit", 20))
    swarm_id = input_data.get("swarm_id")
    status   = input_data.get("status")
    db_path  = os.path.join(data_dir, "swarm.db")

    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        sql = """
            SELECT r.id, r.status, r.started_at, r.ended_at, r.error,
                   r.trigger_kind, s.name AS swarm_name, w.name AS workspace_name
            FROM runs r
            LEFT JOIN swarms s ON s.id = r.swarm_id
            LEFT JOIN workspaces w ON w.id = s.workspace_id
            WHERE 1=1
        """
        params: list = []
        if swarm_id:
            sql += " AND r.swarm_id = ?"
            params.append(swarm_id)
        if status:
            sql += " AND r.status = ?"
            params.append(status)
        sql += " ORDER BY r.started_at DESC LIMIT ?"
        params.append(limit)
        rows = con.execute(sql, params).fetchall()
    finally:
        con.close()

    return {"runs": [dict(r) for r in rows]}


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
