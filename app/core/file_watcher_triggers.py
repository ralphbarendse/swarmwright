from __future__ import annotations

import fnmatch
import json
import logging
import os
import threading
from typing import TYPE_CHECKING

from watchdog.events import FileSystemEventHandler, FileCreatedEvent, FileModifiedEvent
from watchdog.observers import Observer

from app.db import get_session
from app.models.event import Event
from app.models.swarm import Swarm
from app.models.trigger import Trigger
from app.models.workspace import Workspace

if TYPE_CHECKING:
    from flask import Flask
    from app.core.event_bus import EventBus

logger = logging.getLogger(__name__)

KIND_FILE_WATCHER = "file_watcher"

# Active observers keyed by trigger_id → Observer
_observers: dict[str, Observer] = {}
_observers_lock = threading.Lock()


def register_all_file_watcher_triggers(
    app: "Flask", event_bus: "EventBus", data_dir: str
) -> None:
    """Scan the DB for enabled file_watcher triggers and start watchdog observers."""
    with app.app_context():
        with get_session() as session:
            triggers = session.execute(
                __import__("sqlalchemy", fromlist=["select"]).select(Trigger).where(
                    Trigger.kind == KIND_FILE_WATCHER,
                    Trigger.enabled == True,  # noqa: E712
                )
            ).scalars().all()
            trigger_list = [(t.id, t.swarm_id, t.name, t.config_json) for t in triggers]

    for trigger_id, swarm_id, trigger_name, config_json in trigger_list:
        _register_one(
            app=app,
            event_bus=event_bus,
            data_dir=data_dir,
            trigger_id=trigger_id,
            swarm_id=swarm_id,
            trigger_name=trigger_name,
            config_json=config_json,
        )


def _register_one(
    app: "Flask",
    event_bus: "EventBus",
    data_dir: str,
    trigger_id: str,
    swarm_id: str,
    trigger_name: str,
    config_json: str,
) -> bool:
    config = json.loads(config_json or "{}")
    pattern = config.get("pattern", "*")
    watch_event = config.get("event", "created")

    if watch_event not in ("created", "modified", "created_or_modified"):
        logger.warning(
            "File-watcher trigger %r has invalid event type %r — skipping",
            trigger_name, watch_event,
        )
        return False

    with app.app_context():
        with get_session() as session:
            swarm = session.get(Swarm, swarm_id)
            if not swarm:
                return False
            workspace = session.get(Workspace, swarm.workspace_id)
            if not workspace:
                return False
            ws_name = workspace.name
            sw_name = swarm.name

    files_root = os.path.join(data_dir, "workspaces", ws_name, "swarms", sw_name, "files")
    os.makedirs(files_root, exist_ok=True)

    handler = _SwarmFileWatchHandler(
        app=app,
        event_bus=event_bus,
        trigger_id=trigger_id,
        swarm_id=swarm_id,
        files_root=files_root,
        pattern=pattern,
        watch_event=watch_event,
    )

    observer = Observer()
    observer.schedule(handler, files_root, recursive=True)
    observer.start()

    with _observers_lock:
        existing = _observers.pop(trigger_id, None)
        if existing:
            try:
                existing.stop()
                existing.join(timeout=2)
            except Exception:
                pass
        _observers[trigger_id] = observer

    logger.info(
        "File-watcher trigger %r watching %s (pattern=%r, event=%r)",
        trigger_name, files_root, pattern, watch_event,
    )
    return True


def stop_all() -> None:
    """Stop all active file-watcher observers. Called on application shutdown."""
    with _observers_lock:
        for trigger_id, observer in list(_observers.items()):
            try:
                observer.stop()
                observer.join(timeout=2)
            except Exception:
                logger.warning("Error stopping file-watcher observer for trigger %s", trigger_id)
        _observers.clear()


class _SwarmFileWatchHandler(FileSystemEventHandler):
    """Fires an invocation event when a matching file appears or changes."""

    def __init__(
        self,
        app: "Flask",
        event_bus: "EventBus",
        trigger_id: str,
        swarm_id: str,
        files_root: str,
        pattern: str,
        watch_event: str,
    ) -> None:
        self._app = app
        self._event_bus = event_bus
        self._trigger_id = trigger_id
        self._swarm_id = swarm_id
        self._files_root = files_root
        self._pattern = pattern
        self._watch_event = watch_event

    def on_created(self, event) -> None:
        if self._watch_event in ("created", "created_or_modified"):
            self._handle(event)

    def on_modified(self, event) -> None:
        if self._watch_event in ("modified", "created_or_modified"):
            self._handle(event)

    def _handle(self, event) -> None:
        if event.is_directory:
            return
        src = getattr(event, "src_path", "") or ""
        filename = os.path.basename(src)
        if not fnmatch.fnmatch(filename, self._pattern):
            rel = os.path.relpath(src, self._files_root)
            if not fnmatch.fnmatch(rel, self._pattern):
                return

        rel_path = os.path.relpath(src, self._files_root)
        try:
            size_bytes = os.path.getsize(src)
        except OSError:
            size_bytes = 0

        payload = {
            "filename": filename,
            "path": rel_path,
            "size_bytes": size_bytes,
        }

        with self._app.app_context():
            evt_obj = None
            try:
                with get_session() as session:
                    evt_obj = Event(
                        swarm_id=self._swarm_id,
                        trigger_id=self._trigger_id,
                        source="file_watcher",
                        payload_json=json.dumps(payload),
                    )
                    session.add(evt_obj)
                    session.commit()
                    session.refresh(evt_obj)
            except Exception:
                logger.exception(
                    "Could not persist file-watcher event for trigger %s", self._trigger_id
                )
                return

            try:
                self._event_bus.publish(evt_obj)
            except Exception:
                logger.exception(
                    "Could not publish file-watcher event %s", evt_obj.id
                )
