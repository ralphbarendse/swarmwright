"""Compound skill: write constitutions for multiple agents in one call."""
from __future__ import annotations
import json
import sys
import urllib.request
import urllib.error


def run(input: dict, context: dict) -> dict:
    # constitutions: list of {agent_id, text}
    constitutions = input["constitutions"]
    results = []
    for entry in constitutions:
        agent_id = entry["agent_id"]
        text = entry["text"]
        payload = json.dumps({"constitution": text}).encode()
        req = urllib.request.Request(
            f"http://localhost:5001/api/v1/agents/{agent_id}/constitution",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="PUT",
        )
        try:
            with urllib.request.urlopen(req) as r:
                resp = json.loads(r.read())
            results.append({"agent_id": agent_id, "ok": True, "name": resp.get("name", agent_id)})
        except urllib.error.HTTPError as e:
            body = e.read().decode()
            results.append({"agent_id": agent_id, "ok": False, "error": body})

    failed = [r for r in results if not r["ok"]]
    return {
        "results": results,
        "all_ok": len(failed) == 0,
        "failed": failed,
    }


if __name__ == "__main__":
    payload = json.loads(sys.argv[1])
    try:
        print(json.dumps(run(payload["input"], payload["context"])))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
