from __future__ import annotations

import time

from flask import Blueprint, jsonify

bp = Blueprint("health", __name__, url_prefix="/api/v1")

_start_time = time.time()


@bp.get("/health")
def health():
    return jsonify({
        "status": "ok",
        "version": "0.1.0",
        "uptime_seconds": int(time.time() - _start_time),
    })
