"""Built-in skill: HTTP GET request."""
from __future__ import annotations

import json
import sys
import urllib.request
import urllib.error


def run(input_data: dict, context: dict) -> dict:
    url = input_data["url"]
    headers = input_data.get("headers") or {}
    as_json = input_data.get("as_json", False)

    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            status = resp.status
            resp_headers = dict(resp.headers)
            body = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return {"status": e.code, "headers": dict(e.headers), "body": body}

    result: dict = {"status": status, "headers": resp_headers, "body": body}
    if as_json:
        try:
            result["json"] = json.loads(body)
        except json.JSONDecodeError:
            pass
    return result


if __name__ == "__main__":
    payload = json.loads(sys.argv[1])
    try:
        print(json.dumps(run(payload["input"], payload["context"])))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
