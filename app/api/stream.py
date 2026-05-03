from __future__ import annotations

import json
import queue

from flask import Blueprint, Response, current_app, stream_with_context

bp = Blueprint("stream", __name__, url_prefix="/api/v1")


@bp.get("/stream")
def sse_stream():
    """Persistent SSE connection. Emits run.*, topology.*, and agent.* events."""
    sse_bus = current_app.sse_bus
    client_q = sse_bus.connect()

    @stream_with_context
    def generate():
        try:
            yield f"data: {json.dumps({'type': 'connected'})}\n\n"
            while True:
                try:
                    msg = client_q.get(timeout=25)
                    yield f"data: {json.dumps(msg)}\n\n"
                except queue.Empty:
                    yield ": heartbeat\n\n"  # keep the connection alive
        finally:
            sse_bus.disconnect(client_q)

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
