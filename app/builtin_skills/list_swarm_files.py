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
    payload = json.loads(sys.argv[1])
    try:
        result = run(payload["input"], payload["context"])
        print(json.dumps(result))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
