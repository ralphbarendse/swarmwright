"""Built-in skill: generate a starter constitution via the agent draft API."""
from __future__ import annotations
import json, os, sys, urllib.request, urllib.error


def run(input_data: dict, context: dict) -> dict:
    agent_name = input_data["agent_name"]
    layer = input_data["layer"]
    role_description = input_data["role_description"]

    # Build a minimal constitution directly — no LLM call needed for a scaffold
    constitution = (
        f"---\nname: {agent_name}\nlayer: {layer}\nknowledge: []\n---\n\n"
        f"## Role\n\n{role_description}\n\n"
        f"## Responsibilities\n\n- Describe your primary responsibilities here.\n\n"
        f"## Constraints\n\n- Describe constraints and limits here.\n"
    )
    return {"constitution": constitution}


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
