"""Built-in skill: return current UTC date and time."""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone


def run(input_data: dict, context: dict) -> dict:
    now = datetime.now(tz=timezone.utc)
    return {
        "utc_iso": now.isoformat(),
        "unix_timestamp": int(now.timestamp()),
        "date": now.strftime("%Y-%m-%d"),
        "time": now.strftime("%H:%M:%S"),
        "year": now.year,
        "month": now.month,
        "day": now.day,
        "hour": now.hour,
        "minute": now.minute,
        "weekday": now.strftime("%A"),
        "weekday_number": now.weekday(),
    }


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
