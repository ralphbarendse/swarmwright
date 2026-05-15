from __future__ import annotations

import json
import logging
import os

from flask import Flask
from flask_cors import CORS

from app.config import Config, TestingConfig
from app.db import init_db

logger = logging.getLogger(__name__)


def _seed_platform_workspace(data_dir: str) -> None:
    """Copy the bundled Platform workspace into data_dir on first boot."""
    dst = os.path.join(data_dir, "workspaces", "platform")
    if os.path.isdir(dst):
        return
    src = os.path.join(os.path.dirname(__file__), "platform_defaults", "platform")
    if not os.path.isdir(src):
        logger.warning("Platform defaults bundle not found at %s — skipping seed", src)
        return
    import shutil
    shutil.copytree(src, dst)
    logger.info("Seeded platform workspace from bundle into %s", dst)


def _get_event_bus_workers() -> int:
    try:
        from app.db import get_session
        from app.models.settings import Setting
        import json as _json
        with get_session() as session:
            row = session.get(Setting, "runtime.event_bus_workers")
            if row is not None:
                val = _json.loads(row.value_encrypted)
                if isinstance(val, int) and val > 0:
                    return val
    except Exception:
        pass
    return 4


def create_app(config: Config | None = None) -> Flask:
    """Flask application factory."""
    app = Flask(__name__, static_folder="static", static_url_path="/static")

    # ── Config ────────────────────────────────────────────────────────────────
    cfg = config or (TestingConfig() if os.environ.get("TESTING") else Config())
    app.config.from_object(cfg)

    # ── Logging ───────────────────────────────────────────────────────────────
    logging.basicConfig(
        level=getattr(logging, cfg.LOG_LEVEL, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    # ── Encryption key resolution ─────────────────────────────────────────────
    # Phase 5: secrets are encrypted at rest with Fernet. Resolution order is:
    #   1. SWARM_ENCRYPTION_KEY env var (operator-managed)
    #   2. <DATA_DIR>/.encryption_key file (container-managed, persisted)
    #   3. generate + persist on first boot
    # Tests set a deterministic key via env var in TestingConfig + conftest.
    if not cfg.TESTING:
        from app.core.secrets import resolve_or_generate_master_key, EncryptionKeyError

        os.makedirs(cfg.DATA_DIR, exist_ok=True)
        try:
            key, source = resolve_or_generate_master_key(cfg.DATA_DIR)
        except EncryptionKeyError as exc:
            raise RuntimeError(
                f"Cannot start: {exc} The persisted key file appears corrupt — "
                f"check {os.path.join(cfg.DATA_DIR, '.encryption_key')!r} or set "
                "SWARM_ENCRYPTION_KEY in the environment."
            ) from exc

        # Export the resolved key into the env so the rest of the app
        # (which reads SWARM_ENCRYPTION_KEY directly) keeps working unchanged.
        os.environ["SWARM_ENCRYPTION_KEY"] = key

        if source == "generated":
            logger.warning(
                "First boot: generated a new encryption key and wrote it to "
                "%s — back this file up alongside your data, or store the key "
                "separately and set SWARM_ENCRYPTION_KEY explicitly. Losing "
                "the key makes encrypted settings unrecoverable.",
                os.path.join(cfg.DATA_DIR, ".encryption_key"),
            )
        elif source == "file":
            logger.info("Loaded encryption key from %s", cfg.DATA_DIR)
        else:
            logger.info("Loaded encryption key from SWARM_ENCRYPTION_KEY env var")

    # ── Database ──────────────────────────────────────────────────────────────
    init_db(cfg.DATABASE_URL)

    # ── CORS ──────────────────────────────────────────────────────────────────
    CORS(
        app,
        resources={r"/api/*": {"origins": ["http://localhost:*", "http://127.0.0.1:*"]}},
    )

    # ── Blueprints ────────────────────────────────────────────────────────────
    from app.api.health import bp as health_bp
    from app.api.workspaces import bp as workspaces_bp
    from app.api.swarms import bp as swarms_bp
    from app.api.agents import bp as agents_bp
    from app.api.events import bp as events_bp
    from app.api.triggers import bp as triggers_bp
    from app.api.runs import bp as runs_bp
    from app.api.stream import bp as stream_bp
    from app.api.topology import bp as topology_bp
    from app.api.knowledge import bp as knowledge_bp
    from app.api.skills_api import bp as skills_bp
    from app.api.settings import bp as settings_bp
    from app.api.callers import bp as callers_bp
    from app.api.files import bp as files_bp

    app.register_blueprint(health_bp)
    app.register_blueprint(workspaces_bp)
    app.register_blueprint(swarms_bp)
    app.register_blueprint(agents_bp)
    app.register_blueprint(events_bp)
    app.register_blueprint(triggers_bp)
    app.register_blueprint(runs_bp)
    app.register_blueprint(stream_bp)
    app.register_blueprint(topology_bp)
    app.register_blueprint(knowledge_bp)
    app.register_blueprint(skills_bp)
    app.register_blueprint(settings_bp)
    app.register_blueprint(callers_bp)
    app.register_blueprint(files_bp)

    # ── SSE bus ───────────────────────────────────────────────────────────────
    from app.core.sse_bus import SseBus
    app.sse_bus = SseBus()

    # Wire runtime SSE notifications
    from app.core import runtime
    runtime.set_notify_fn(app.sse_bus.broadcast)

    # ── Event bus ─────────────────────────────────────────────────────────────
    from app.core.event_bus import EventBus
    app.event_bus = EventBus(max_workers=_get_event_bus_workers())
    app.event_bus.subscribe(_make_run_handler(app))

    # ── Scheduler ─────────────────────────────────────────────────────────────
    from app.scheduler import init_scheduler
    init_scheduler(app)

    # ── Registry (scan + file watcher) ────────────────────────────────────────
    if not cfg.TESTING:
        from app.core.registry import boot_scan, start_file_watcher
        from app.core.heartbeat import register_all_heartbeats

        data_dir = cfg.DATA_DIR
        os.makedirs(data_dir, exist_ok=True)

        _seed_platform_workspace(data_dir)
        boot_scan(data_dir)
        register_all_heartbeats(app, app.event_bus, data_dir)
        app._file_observer = start_file_watcher(data_dir)

        from app.core.file_watcher_triggers import register_all_file_watcher_triggers
        register_all_file_watcher_triggers(app, app.event_bus, data_dir)

    # ── Frontend ──────────────────────────────────────────────────────────────
    @app.route("/")
    def index():
        return app.send_static_file("index.html")

    return app


def _make_run_handler(app: Flask):
    """Return an event_bus subscriber that starts a Run for each published event."""

    def _fail_run(event, error: str, get_session, Run, STATUS_FAILED) -> None:
        """Persist an immediately-failed run so Control Room shows the error."""
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc)
        try:
            with get_session() as session:
                run = Run(
                    event_id=event.id,
                    swarm_id=event.swarm_id,
                    status=STATUS_FAILED,
                    started_at=now,
                    ended_at=now,
                    error=error,
                )
                session.add(run)
                session.commit()
                session.refresh(run)
                run_id = run.id
            if hasattr(app, "sse_bus"):
                app.sse_bus.broadcast("run.failed", {"run_id": run_id, "swarm_id": event.swarm_id})
        except Exception:
            logger.exception("Could not persist failed run for event %s", event.id)

    def handle(event) -> None:
        with app.app_context():
            from app.core import runtime
            from app.db import get_session
            from app.models.swarm import Swarm
            from app.models.workspace import Workspace
            from app.models.run import Run, STATUS_FAILED

            data_dir: str = app.config.get("DATA_DIR", "/data")

            with get_session() as session:
                swarm = session.get(Swarm, event.swarm_id)
                if not swarm:
                    logger.warning(
                        "Event %s: swarm %s not found — skipping run",
                        event.id,
                        event.swarm_id,
                    )
                    return
                if swarm.validation_error:
                    error_msg = f"Swarm failed validation: {swarm.validation_error}"
                    logger.warning("Event %s: %s", event.id, error_msg)
                    _fail_run(event, error_msg, get_session, Run, STATUS_FAILED)
                    return
                if not swarm.enabled:
                    error_msg = "Swarm is disabled"
                    logger.info("Event %s: swarm %s is disabled — skipping run", event.id, swarm.name)
                    _fail_run(event, error_msg, get_session, Run, STATUS_FAILED)
                    return
                workspace = session.get(Workspace, swarm.workspace_id)
                if not workspace:
                    error_msg = "Workspace not found for swarm"
                    logger.warning(
                        "Event %s: workspace not found for swarm %s — skipping run",
                        event.id,
                        swarm.name,
                    )
                    _fail_run(event, error_msg, get_session, Run, STATUS_FAILED)
                    return
                swarm_name = swarm.name
                workspace_name = workspace.name

            workspace_path = os.path.join(data_dir, "workspaces", workspace_name)
            swarm_path = os.path.join(workspace_path, "swarms", swarm_name)

            try:
                payload = json.loads(event.payload_json or "{}")
                # Phase 6.1: triggers can declare per-trigger target_agent;
                # the trigger fire path stamps it onto the event payload as
                # `_target_agent`. Strip it before handing off so it doesn't
                # pollute the agent's input view.
                target_override = payload.pop("_target_agent", None)
                runtime.start_run(
                    event_id=event.id,
                    swarm_id=event.swarm_id,
                    swarm_path=swarm_path,
                    workspace_path=workspace_path,
                    data_dir=data_dir,
                    payload=payload,
                    entry_point_override=target_override,
                )
            except Exception:
                logger.exception(
                    "Failed to start run for event %s (swarm %s)",
                    event.id,
                    event.swarm_id,
                )

    return handle
