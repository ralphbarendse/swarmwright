"""Built-in skill: HTTP POST request with a JSON body."""
from __future__ import annotations

import json
import urllib.request
import urllib.error


def run(input_data: dict, context: dict) -> dict:
    url = input_data["url"]
    body = input_data.get("body") or {}
    headers = input_data.get("headers") or {}
    as_json = input_data.get("as_json", False)

    payload = json.dumps(body).encode("utf-8")
    req_headers = {"Content-Type": "application/json", **headers}
    req = urllib.request.Request(url, data=payload, headers=req_headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            status = resp.status
            resp_headers = dict(resp.headers)
            resp_body = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        resp_body = e.read().decode("utf-8", errors="replace")
        return {"status": e.code, "headers": dict(e.headers), "body": resp_body}

    result: dict = {"status": status, "headers": resp_headers, "body": resp_body}
    if as_json:
        try:
            result["json"] = json.loads(resp_body)
        except json.JSONDecodeError:
            pass
    return result
