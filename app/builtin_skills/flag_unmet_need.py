"""Built-in skill: record an unmet user request in the unmet_needs table."""
from __future__ import annotations
import json, os, sqlite3, sys


def run(input_data: dict, context: dict) -> dict:
    data_dir = context["data_dir"]
    db_path = os.path.join(data_dir, "swarm.db")

    con = sqlite3.connect(db_path)
    try:
        cur = con.execute(
            "INSERT INTO unmet_needs (workspace_id, session_id, user_id, verbatim_request, concierge_summary, status) "
            "VALUES (?, ?, ?, ?, ?, 'open')",
            (
                input_data["workspace_id"],
                input_data.get("session_id"),
                input_data["user_id"],
                input_data["verbatim_request"],
                input_data["concierge_summary"],
            ),
        )
        con.commit()
        need_id = cur.lastrowid
    finally:
        con.close()

    return {"need_id": need_id}


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
