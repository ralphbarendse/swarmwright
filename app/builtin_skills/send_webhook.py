"""Built-in skill: send a JSON payload to a webhook URL."""
from __future__ import annotations

import json
import urllib.request
import urllib.error


def run(input_data: dict, context: dict) -> dict:
    url = input_data["url"]
    payload = input_data.get("payload") or {}
    headers = input_data.get("headers") or {}

    data = json.dumps(payload).encode("utf-8")
    req_headers = {"Content-Type": "application/json", **headers}
    req = urllib.request.Request(url, data=data, headers=req_headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return {"status": resp.status, "body": body, "ok": True}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return {"status": e.code, "body": body, "ok": False}
