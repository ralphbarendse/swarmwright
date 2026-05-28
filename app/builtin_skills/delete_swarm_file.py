"""Built-in skill: delete a file from the swarm's files/ directory."""
from __future__ import annotations

import json
import os
import sys


def _validate_path(files_root: str, path: str) -> str:
    abs_root = os.path.realpath(files_root)
    abs_path = os.path.realpath(os.path.join(files_root, path))
    if not abs_path.startswith(abs_root + os.sep) and abs_path != abs_root:
        raise ValueError(f"Path '{path}' escapes the swarm file store")
    return abs_path


def run(input_data: dict, context: dict) -> dict:
    path = input_data["path"]
    files_root = context["files_root"]

    abs_path = _validate_path(files_root, path)

    if not os.path.isfile(abs_path):
        return {"deleted": False, "path": path}

    os.remove(abs_path)

    # Remove empty parent directories up to (but not including) files_root
    parent = os.path.dirname(abs_path)
    abs_root = os.path.realpath(files_root)
    while parent != abs_root and os.path.isdir(parent) and not os.listdir(parent):
        os.rmdir(parent)
        parent = os.path.dirname(parent)

    return {"deleted": True, "path": path}


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
