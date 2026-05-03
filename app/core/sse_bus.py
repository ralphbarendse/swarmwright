from __future__ import annotations

import queue
import threading


class SseBus:
    """Thread-safe broadcast bus for SSE clients.

    Each connected client gets a dedicated Queue. broadcast() puts events
    on all active queues; slow clients that fill their queue get drops
    rather than blocking the caller.
    """

    def __init__(self) -> None:
        self._queues: list[queue.Queue[dict]] = []
        self._lock = threading.Lock()

    def connect(self) -> queue.Queue[dict]:
        q: queue.Queue[dict] = queue.Queue(maxsize=200)
        with self._lock:
            self._queues.append(q)
        return q

    def disconnect(self, q: queue.Queue[dict]) -> None:
        with self._lock:
            try:
                self._queues.remove(q)
            except ValueError:
                pass

    def broadcast(self, event_type: str, data: dict) -> None:
        msg = {"type": event_type, **data}
        with self._lock:
            queues = list(self._queues)
        for q in queues:
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass  # slow client — drop rather than block
