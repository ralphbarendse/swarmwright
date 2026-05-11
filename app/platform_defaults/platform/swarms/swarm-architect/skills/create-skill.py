from __future__ import annotations
import json
import sys
import urllib.request
import urllib.error


def run(input: dict, context: dict) -> dict:
    payload = json.dumps({
        "scope": input["scope"],
        "name": input["name"],
        "py_content": input["py_content"],
        "yaml_content": input["yaml_content"],
        "workspace_id": input.get("workspace_id"),
        "swarm_id": input.get("swarm_id"),
    }).encode()
    req = urllib.request.Request(
        "http://localhost:5001/api/v1/skills",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        return {"error": body, "status": e.code}


if __name__ == "__main__":
    payload = json.loads(sys.argv[1])
    try:
        print(json.dumps(run(payload["input"], payload["context"])))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
