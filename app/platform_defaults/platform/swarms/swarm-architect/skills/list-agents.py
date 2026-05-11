from __future__ import annotations
import json
import sys
import urllib.request


def run(input: dict, context: dict) -> dict:
    swarm_id = input["swarm_id"]
    url = f"http://localhost:5001/api/v1/swarms/{swarm_id}/agents"
    with urllib.request.urlopen(url) as r:
        agents = json.loads(r.read())
    return {
        "agents": [
            {"id": a["id"], "name": a["name"], "layer": a.get("layer")}
            for a in agents
        ]
    }


if __name__ == "__main__":
    payload = json.loads(sys.argv[1])
    try:
        print(json.dumps(run(payload["input"], payload["context"])))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
