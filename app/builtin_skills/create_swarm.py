"""Built-in skill: provision a new swarm inside a workspace via the internal API."""
from __future__ import annotations
import json, os, sys, urllib.request, urllib.error


def run(input_data: dict, context: dict) -> dict:
    workspace_id = input_data.get("workspace_id")
    workspace_name = input_data.get("workspace_name")
    if not workspace_id:
        if not workspace_name:
            raise ValueError("Either 'workspace_id' or 'workspace_name' must be provided")
        import sqlite3
        db_path = os.path.join(context["data_dir"], "swarm.db")
        con = sqlite3.connect(db_path)
        try:
            row = con.execute(
                "SELECT id FROM workspaces WHERE lower(name)=lower(?) OR lower(display_name)=lower(?)",
                (workspace_name, workspace_name),
            ).fetchone()
        finally:
            con.close()
        if not row:
            raise ValueError(f"Workspace not found: {workspace_name!r}")
        workspace_id = row[0]
    display_name = input_data.get("display_name") or input_data.get("name")
    if not display_name:
        raise ValueError("Either 'display_name' or 'name' must be provided")
    body = json.dumps({
        "display_name": display_name,
        "description": input_data.get("description", ""),
    }).encode()
    req = urllib.request.Request(
        f"http://localhost:5001/api/v1/workspaces/{workspace_id}/swarms",
        data=body,
        headers={"Content-Type": "application/json", "X-Internal-Token": os.environ.get("INTERNAL_TOKEN", "")},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            result = json.loads(resp.read())
        return {
            "ok": True,
            "swarm_id": result["id"],
            "name": result["name"],
            "display_name": result["display_name"],
        }
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode(errors="replace")
        try:
            err = json.loads(body_text).get("error", {})
        except Exception:
            err = {}
        return {"ok": False, "error": err.get("code", f"http_{exc.code}"), "message": err.get("message", body_text)}


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
