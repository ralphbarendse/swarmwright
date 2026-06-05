"""Built-in skill: create a custom skill via the internal API."""
from __future__ import annotations
import json, os, sqlite3, sys, urllib.request, urllib.error


def _resolve_workspace(name: str, data_dir: str) -> str:
    con = sqlite3.connect(os.path.join(data_dir, "swarm.db"))
    try:
        row = con.execute(
            "SELECT id FROM workspaces WHERE lower(name)=lower(?) OR lower(display_name)=lower(?)",
            (name, name),
        ).fetchone()
    finally:
        con.close()
    if not row:
        raise ValueError(f"Workspace not found: {name!r}")
    return row[0]


def run(input_data: dict, context: dict) -> dict:
    scope = input_data["scope"]
    workspace_id = input_data.get("workspace_id")
    if not workspace_id and input_data.get("workspace_name"):
        workspace_id = _resolve_workspace(input_data["workspace_name"], context["data_dir"])

    name = input_data["name"].replace("_", "-")

    payload = json.dumps({
        "scope": scope,
        "name": name,
        "py_content": input_data["py_content"],
        "yaml_content": input_data["yaml_content"],
        "workspace_id": workspace_id,
        "swarm_id": input_data.get("swarm_id"),
    }).encode()

    req = urllib.request.Request(
        "http://localhost:5001/api/v1/skills",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Internal-Token": os.environ.get("INTERNAL_TOKEN", ""),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return {"ok": True, **json.loads(resp.read())}
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode(errors="replace")
        try:
            body = json.loads(body_text)
            error_code = body.get("error", {}).get("code", f"http_{exc.code}")
            error_msg  = body.get("error", {}).get("message", body_text)
        except Exception:
            error_code = f"http_{exc.code}"
            error_msg  = body_text

        # Every failure here is something the agent can fix and retry (bad YAML, a
        # missing __main__ block, a disallowed package) or relay to the user (a name
        # that already exists). Return a structured result instead of raising, which
        # would otherwise crash the whole run with an unhandled skill failure.
        if error_code == "conflict":
            # The create endpoint rejects existing names — editing is a different skill.
            error_msg += " Use the edit_skill skill to update an existing skill instead of create_skill."
        return {
            "ok": False,
            "error": error_code,
            "message": error_msg,
            "status": exc.code,
        }


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
