"""Built-in skill: apply a topology patch to a swarm via the internal API."""
from __future__ import annotations
import json, os, sys, urllib.request, urllib.error


def run(input_data: dict, context: dict) -> dict:
    swarm_id = input_data["swarm_id"]
    body = json.dumps({
        "op": input_data["operation"],
        "params": input_data["payload"],
    }).encode()
    req = urllib.request.Request(
        f"http://localhost:5001/api/v1/swarms/{swarm_id}/topology",
        data=body,
        headers={"Content-Type": "application/json", "X-Internal-Token": os.environ.get("INTERNAL_TOKEN", "")},
        method="PATCH",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            resp.read()
        return {"ok": True}
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode(errors="replace")
        try:
            body = json.loads(body_text)
            error_code = body.get("error", {}).get("code", "")
            error_msg  = body.get("error", {}).get("message", body_text)
        except Exception:
            error_code = ""
            error_msg  = body_text
        # Return structured errors so the agent can reason about them
        # rather than crashing the run with an unhandled skill failure.
        return {"ok": False, "error": error_code or f"http_{exc.code}", "message": error_msg}


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
