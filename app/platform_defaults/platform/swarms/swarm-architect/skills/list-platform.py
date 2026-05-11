from __future__ import annotations
import json
import sys
import urllib.request


def run(input: dict, context: dict) -> dict:
    url = "http://localhost:5001/api/v1/workspaces"
    with urllib.request.urlopen(url) as r:
        workspaces = json.loads(r.read())
    result = []
    for ws in workspaces:
        ws_url = f"http://localhost:5001/api/v1/workspaces/{ws['id']}/swarms"
        with urllib.request.urlopen(ws_url) as r:
            swarms = json.loads(r.read())
        result.append({
            "workspace_id": ws["id"],
            "workspace_name": ws["display_name"],
            "swarms": [
                {"id": s["id"], "name": s["display_name"], "enabled": s.get("enabled", True)}
                for s in swarms
            ],
        })
    return {"workspaces": result}


if __name__ == "__main__":
    payload = json.loads(sys.argv[1])
    try:
        print(json.dumps(run(payload["input"], payload["context"])))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
