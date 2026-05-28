"""Built-in skill: fetch a run and its steps from the database."""
from __future__ import annotations
import json, os, sqlite3, sys


def run(input_data: dict, context: dict) -> dict:
    data_dir = context["data_dir"]
    run_id = input_data["run_id"]
    db_path = os.path.join(data_dir, "swarm.db")

    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        run_row = con.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not run_row:
            # Accept prefix match (e.g. first 8 chars of UUID)
            run_row = con.execute("SELECT * FROM runs WHERE id LIKE ?", (run_id + "%",)).fetchone()
        if not run_row:
            raise ValueError(f"Run '{run_id}' not found")
        full_run_id = run_row["id"]
        steps = con.execute(
            "SELECT step_type, step_name, edge_purpose, output_json, error, sequence "
            "FROM run_steps WHERE run_id = ? ORDER BY sequence",
            (full_run_id,),
        ).fetchall()
    finally:
        con.close()

    return {
        "run": {
            **dict(run_row),
            "steps": [dict(s) for s in steps],
        }
    }


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
