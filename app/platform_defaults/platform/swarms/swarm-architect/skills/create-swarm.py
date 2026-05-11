from __future__ import annotations
import json
import sys
import urllib.request


def run(input: dict, context: dict) -> dict:
    workspace_id = input["workspace_id"]
    payload = json.dumps({
        "display_name": input["display_name"],
        "description": input.get("description", ""),
    }).encode()
    req = urllib.request.Request(
        f"http://localhost:5001/api/v1/workspaces/{workspace_id}/swarms",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


if __name__ == "__main__":
    payload = json.loads(sys.argv[1])
    try:
        print(json.dumps(run(payload["input"], payload["context"])))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
