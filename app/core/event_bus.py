from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

logger = logging.getLogger(__name__)


class EventBus:
    """In-process pub/sub dispatcher.

    Every published event is:
    1. Dispatched synchronously to subscribers via a thread pool (non-blocking for caller)
    2. The caller returns immediately without waiting for handlers to complete

    Swap the implementation behind this interface when outgrowing it — no callers change.
    """

    def __init__(self, max_workers: int = 4) -> None:
        self._subscribers: list[Callable[[dict], None]] = []
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="event-bus")

    def subscribe(self, handler: Callable[[dict], None]) -> None:
        """Register a handler that will be called for every published event."""
        with self._lock:
            self._subscribers.append(handler)

    def publish(self, event: dict) -> None:
        """Publish an event to all subscribers asynchronously.

        Returns immediately — handlers run in the thread pool.
        """
        with self._lock:
            handlers = list(self._subscribers)

        for handler in handlers:
            self._executor.submit(self._call_handler, handler, event)

    def _call_handler(self, handler: Callable[[dict], None], event: dict) -> None:
        try:
            handler(event)
        except Exception:
            logger.exception("Event handler %s raised an exception", handler)

    def shutdown(self) -> None:
        """Graceful shutdown — wait for in-flight handlers to complete."""
        self._executor.shutdown(wait=True)
