"""Read a skill's Python and YAML source, resolving scope automatically."""
from __future__ import annotations
import json
import sys
import urllib.request
import urllib.error


BASE = "http://localhost:5001/api/v1"


def _get(url: str) -> dict:
    with urllib.request.urlopen(url) as r:
        return json.loads(r.read())


def _try_scope(name: str, scope: str, workspace_id: str | None, swarm_id: str | None) -> dict | None:
    params = f"scope={scope}"
    if workspace_id:
        params += f"&workspace_id={workspace_id}"
    if swarm_id:
        params += f"&swarm_id={swarm_id}"
    try:
        return _get(f"{BASE}/skills/{name}?{params}")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def run(input: dict, context: dict) -> dict:
    name = input["name"]
    swarm_id = input.get("swarm_id")
    workspace_id = input.get("workspace_id")

    # If swarm_id provided, resolve workspace from it
    if swarm_id and not workspace_id:
        swarms = _get(f"{BASE}/workspaces")
        for ws in swarms:
            try:
                swarm_list = _get(f"{BASE}/workspaces/{ws['id']}/swarms")
                for s in swarm_list:
                    if s["id"] == swarm_id:
                        workspace_id = ws["id"]
                        break
            except Exception:
                pass
            if workspace_id:
                break

    # Try scopes: swarm → workspace → company → built-in
    if swarm_id:
        result = _try_scope(name, "swarm", workspace_id, swarm_id)
        if result:
            return result
    if workspace_id:
        result = _try_scope(name, "workspace", workspace_id, None)
        if result:
            return result
    result = _try_scope(name, "company", None, None)
    if result:
        return result
    result = _try_scope(name, "built-in", None, None)
    if result:
        return result

    return {"error": f"Skill '{name}' not found in any scope"}


if __name__ == "__main__":
    payload = json.loads(sys.argv[1])
    try:
        print(json.dumps(run(payload["input"], payload["context"])))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
