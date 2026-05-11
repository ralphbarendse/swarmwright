"""Built-in skill: return current UTC date and time."""
from __future__ import annotations

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
