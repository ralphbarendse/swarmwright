"""Built-in skill: read a file from the swarm's files/ directory."""
from __future__ import annotations

import base64
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
    encoding = input_data.get("encoding", "utf-8")
    files_root = context["files_root"]

    abs_path = _validate_path(files_root, path)
    if not os.path.isfile(abs_path):
        raise FileNotFoundError(f"File not found: '{path}'")

    size_bytes = os.path.getsize(abs_path)

    if encoding == "base64":
        with open(abs_path, "rb") as f:
            content = base64.b64encode(f.read()).decode("ascii")
    else:
        with open(abs_path, encoding=encoding) as f:
            content = f.read()

    return {"content": content, "encoding": encoding, "size_bytes": size_bytes}


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
