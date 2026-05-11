from __future__ import annotations
import json
import sys
import urllib.request
import urllib.error


def run(input: dict, context: dict) -> dict:
    swarm_id = input["swarm_id"]
    payload = json.dumps(input.get("payload", {})).encode()
    req = urllib.request.Request(
        f"http://localhost:5001/api/v1/swarms/{swarm_id}/events",
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
