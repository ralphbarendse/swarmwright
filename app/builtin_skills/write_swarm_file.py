"""Built-in skill: write a file to the swarm's files/ directory."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import sys


def _validate_path(files_root: str, path: str) -> str:
    """Resolve path and ensure it stays inside files_root. Returns abs path."""
    abs_root = os.path.realpath(files_root)
    abs_path = os.path.realpath(os.path.join(files_root, path))
    if not abs_path.startswith(abs_root + os.sep) and abs_path != abs_root:
        raise ValueError(f"Path '{path}' escapes the swarm file store")
    return abs_path


def run(input_data: dict, context: dict) -> dict:
    path = input_data["path"]
    content = input_data["content"]
    encoding = input_data.get("encoding", "utf-8")
    files_root = context["files_root"]

    abs_path = _validate_path(files_root, path)
    os.makedirs(os.path.dirname(abs_path), exist_ok=True)

    if encoding == "base64":
        data = base64.b64decode(content)
        with open(abs_path, "wb") as f:
            f.write(data)
    else:
        with open(abs_path, "w", encoding=encoding) as f:
            f.write(content)

    size_bytes = os.path.getsize(abs_path)
    with open(abs_path, "rb") as f:
        checksum = hashlib.sha256(f.read()).hexdigest()

    return {"path": path, "size_bytes": size_bytes, "checksum": checksum}


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
