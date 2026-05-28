"""Built-in skill: list files in the swarm's files/ directory."""
from __future__ import annotations

import json
import os
import sys


def run(input_data: dict, context: dict) -> dict:
    prefix = input_data.get("prefix", "")
    files_root = context["files_root"]

    if not os.path.isdir(files_root):
        return {"files": []}

    results = []
    for dirpath, _, filenames in os.walk(files_root):
        for fname in sorted(filenames):
            abs_path = os.path.join(dirpath, fname)
            rel_path = os.path.relpath(abs_path, files_root)
            if prefix and not rel_path.startswith(prefix):
                continue
            stat = os.stat(abs_path)
            results.append({
                "path": rel_path,
                "filename": fname,
                "size_bytes": stat.st_size,
                "modified_at": stat.st_mtime,
            })

    results.sort(key=lambda f: f["path"])
    return {"files": results}


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
