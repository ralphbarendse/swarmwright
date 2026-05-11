"""Update a skill's Python and/or YAML source via the API."""
from __future__ import annotations
import json
import sys
import urllib.request
import urllib.error


BASE = "http://localhost:5001/api/v1"


def _put(url: str, body: dict) -> dict:
    payload = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json"},
        method="PUT",
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"PUT {url} failed ({e.code}): {e.read().decode()}")


def run(input: dict, context: dict) -> dict:
    name = input["name"]
    scope = input.get("scope", "workspace")
    workspace_id = input.get("workspace_id")
    swarm_id = input.get("swarm_id")
    py_content = input["py_content"]
    yaml_content = input["yaml_content"]

    result = _put(f"{BASE}/skills/{name}", {
        "name": name,
        "scope": scope,
        "workspace_id": workspace_id,
        "swarm_id": swarm_id,
        "py_content": py_content,
        "yaml_content": yaml_content,
    })
    return {"updated": True, "result": result}


if __name__ == "__main__":
    payload = json.loads(sys.argv[1])
    try:
        print(json.dumps(run(payload["input"], payload["context"])))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
