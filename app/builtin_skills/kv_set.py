"""Built-in skill: set a value in the swarm's key-value store."""
from __future__ import annotations

import json
import os
import sys

_KV_FILE = "_kv_store.json"


def _load(files_root: str) -> dict:
    path = os.path.join(files_root, _KV_FILE)
    if not os.path.isfile(path):
        return {}
    with open(path) as f:
        return json.load(f)


def _save(files_root: str, store: dict) -> None:
    path = os.path.join(files_root, _KV_FILE)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(store, f, indent=2)
    os.replace(tmp, path)


def run(input_data: dict, context: dict) -> dict:
    key = input_data["key"]
    value = input_data["value"]
    files_root = context["files_root"]
    os.makedirs(files_root, exist_ok=True)
    store = _load(files_root)
    store[key] = value
    _save(files_root, store)
    return {"key": key, "value": value}


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
