"""Built-in skill: invoke a swarm run via the internal API."""
from __future__ import annotations
import json, os, sqlite3, sys, time, urllib.request, urllib.error


def _poll_run_id(db_path: str, event_id: str, attempts: int = 10, interval: float = 0.5) -> str | None:
    """Poll the DB for the run created by this event. Returns run_id or None."""
    for _ in range(attempts):
        time.sleep(interval)
        con = sqlite3.connect(db_path)
        try:
            row = con.execute("SELECT id FROM runs WHERE event_id = ?", (event_id,)).fetchone()
        finally:
            con.close()
        if row:
            return row[0]
    return None


def run(input_data: dict, context: dict) -> dict:
    data_dir = context["data_dir"]
    swarm_id = input_data["swarm_id"]
    payload = input_data.get("payload") or {}

    # Resolve swarm name → UUID (accepts either)
    db_path = os.path.join(data_dir, "swarm.db")
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        row = con.execute("SELECT id, name FROM swarms WHERE id = ? OR lower(name) = lower(?)", (swarm_id, swarm_id)).fetchone()
        if not row:
            raise ValueError(f"Swarm '{swarm_id}' not found")
        resolved_id = row["id"]
        resolved_name = row["name"]
    finally:
        con.close()

    # POST to the events endpoint — queues an event that fires a run asynchronously
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"http://localhost:5001/api/v1/swarms/{resolved_id}/events",
        data=body,
        headers={"Content-Type": "application/json", "X-Internal-Token": os.environ.get("INTERNAL_TOKEN", "")},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            result = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode(errors="replace")
        try:
            err = json.loads(body_text).get("error", {})
        except Exception:
            err = {}
        return {"ok": False, "error": err.get("code", f"http_{exc.code}"), "message": err.get("message", body_text)}

    event_id = result.get("id", "")

    # Poll briefly so the operator gets a run_id it can pass to read_run
    run_id = _poll_run_id(db_path, event_id)

    return {
        "ok": True,
        "event_id": event_id,
        "run_id": run_id or "",
        "swarm_id": resolved_id,
        "swarm_name": resolved_name,
        "status": "queued" if not run_id else "started",
    }


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
