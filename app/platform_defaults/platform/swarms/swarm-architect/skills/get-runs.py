from __future__ import annotations
import json
import sys
import urllib.request


def run(input: dict, context: dict) -> dict:
    swarm_id = input.get("swarm_id", "")
    limit = input.get("limit", 10)
    url = f"http://localhost:5001/api/v1/runs?limit={limit}"
    if swarm_id:
        url += f"&swarm_id={swarm_id}"
    with urllib.request.urlopen(url) as r:
        runs = json.loads(r.read())
    return {
        "runs": [
            {
                "id": r["id"],
                "status": r["status"],
                "started_at": r.get("started_at"),
                "completed_at": r.get("completed_at"),
                "error": r.get("error"),
            }
            for r in runs
        ]
    }


if __name__ == "__main__":
    payload = json.loads(sys.argv[1])
    try:
        print(json.dumps(run(payload["input"], payload["context"])))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
