"""Built-in skill: read the source (.py and .yaml) of an existing skill."""
from __future__ import annotations
import json, os, sys, urllib.request, urllib.error


def run(input_data: dict, context: dict) -> dict:
    name = input_data["name"].replace("_", "-")
    scope = input_data.get("scope", "company")

    params = f"scope={scope}"
    if input_data.get("workspace_id"):
        params += f"&workspace_id={input_data['workspace_id']}"
    elif input_data.get("workspace_name"):
        # Resolve workspace name → id via DB directly (same pattern as create_skill)
        import sqlite3
        data_dir = context["data_dir"]
        con = sqlite3.connect(os.path.join(data_dir, "swarm.db"))
        try:
            row = con.execute(
                "SELECT id FROM workspaces WHERE lower(name)=lower(?) OR lower(display_name)=lower(?)",
                (input_data["workspace_name"], input_data["workspace_name"]),
            ).fetchone()
        finally:
            con.close()
        if not row:
            return {"ok": False, "error": "workspace_not_found",
                    "message": f"Workspace not found: {input_data['workspace_name']!r}"}
        params += f"&workspace_id={row[0]}"

    if input_data.get("swarm_id"):
        params += f"&swarm_id={input_data['swarm_id']}"

    url = f"http://localhost:5001/api/v1/skills/{name}?{params}"
    req = urllib.request.Request(
        url,
        headers={"X-Internal-Token": os.environ.get("INTERNAL_TOKEN", "")},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read())
            return {
                "ok": True,
                "name": data.get("name", name),
                "scope": data.get("scope", scope),
                "py_content": data.get("py_content", ""),
                "yaml_content": data.get("yaml_content", ""),
                "description": data.get("description", ""),
                "allowed_packages": data.get("allowed_packages", []),
            }
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        try:
            msg = json.loads(body).get("error", {}).get("message", body)
        except Exception:
            msg = body
        return {"ok": False, "error": f"http_{exc.code}", "message": msg}


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
