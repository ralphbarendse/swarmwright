from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
from typing import TYPE_CHECKING

import frontmatter
import yaml
from sqlalchemy import select
from watchdog.events import FileSystemEventHandler, FileSystemEvent
from watchdog.observers import Observer

from app.core.hierarchy import load_and_validate, HierarchyValidationError
from app.core.resolver import resolve, ResolverError
from app.core.file_store import ensure_files_dir, reconcile
from app.db import get_session
from app.models.agent import Agent, SCOPE_COMPANY, SCOPE_WORKSPACE, SCOPE_SWARM
from app.models.caller import Caller, VALID_TIMEOUT_ACTIONS
from app.models.informer import Informer
from app.models.knowledge import KnowledgeDocument
from app.models.swarm import Swarm
from app.models.trigger import Trigger
from app.models.workspace import Workspace

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)

# In-memory cache: swarm_id → ParsedHierarchy
_hierarchy_cache: dict[str, object] = {}
_cache_lock = threading.Lock()


# ── Public API ────────────────────────────────────────────────────────────────

def get_hierarchy(swarm_id: str):
    """Return the cached ParsedHierarchy for a swarm, or None if not loaded."""
    with _cache_lock:
        return _hierarchy_cache.get(swarm_id)


def boot_scan(data_dir: str) -> None:
    """Walk the full data/ tree and register everything into the database.

    Called once at application startup.
    """
    logger.info("Registry boot scan starting (data_dir=%s)", data_dir)
    _scan_company_scope(data_dir)
    _scan_all_workspaces(data_dir)
    logger.info("Registry boot scan complete")


def start_file_watcher(data_dir: str) -> Observer:
    """Start a watchdog observer that re-scans on file changes.

    Returns the Observer so the caller can stop it on shutdown.
    """
    handler = _RegistryEventHandler(data_dir)
    observer = Observer()
    observer.schedule(handler, data_dir, recursive=True)
    observer.start()
    logger.info("File watcher started on %s", data_dir)
    return observer


# ── Scanning ──────────────────────────────────────────────────────────────────

def _scan_company_scope(data_dir: str) -> None:
    company_dir = os.path.join(data_dir, "company")
    _sync_knowledge_docs(
        folder=os.path.join(company_dir, "knowledge"),
        scope=SCOPE_COMPANY,
        workspace_id=None,
        swarm_id=None,
    )
    _sync_perceptionists(
        folder=os.path.join(company_dir, "perceptionists"),
        scope=SCOPE_COMPANY,
        workspace_id=None,
        swarm_id=None,
    )
    _sync_callers(
        folder=os.path.join(company_dir, "callers"),
        scope=SCOPE_COMPANY,
        workspace_id=None,
        swarm_id=None,
    )
    _sync_informers(
        folder=os.path.join(company_dir, "informers"),
        scope=SCOPE_COMPANY,
        workspace_id=None,
        swarm_id=None,
    )


def _scan_all_workspaces(data_dir: str) -> None:
    workspaces_dir = os.path.join(data_dir, "workspaces")
    if not os.path.isdir(workspaces_dir):
        return

    for ws_name in os.listdir(workspaces_dir):
        ws_path = os.path.join(workspaces_dir, ws_name)
        if not os.path.isdir(ws_path):
            continue
        _scan_workspace(data_dir, ws_path, ws_name)


def _scan_workspace(data_dir: str, ws_path: str, ws_name: str) -> None:
    # Ensure workspace row exists
    with get_session() as session:
        workspace = session.execute(
            select(Workspace).where(Workspace.name == ws_name)
        ).scalar_one_or_none()
        if not workspace:
            meta = _read_meta(ws_path)
            workspace = Workspace(
                name=ws_name,
                display_name=meta.get("display_name", ws_name),
                description=meta.get("description"),
                icon=meta.get("icon"),
                meta_hash=_hash_file(os.path.join(ws_path, "meta.yaml")),
            )
            session.add(workspace)
            session.commit()
            session.refresh(workspace)
        workspace_id = workspace.id

    _sync_knowledge_docs(
        folder=os.path.join(ws_path, "knowledge"),
        scope=SCOPE_WORKSPACE,
        workspace_id=workspace_id,
        swarm_id=None,
    )
    _sync_perceptionists(
        folder=os.path.join(ws_path, "perceptionists"),
        scope=SCOPE_WORKSPACE,
        workspace_id=workspace_id,
        swarm_id=None,
    )
    _sync_callers(
        folder=os.path.join(ws_path, "callers"),
        scope=SCOPE_WORKSPACE,
        workspace_id=workspace_id,
        swarm_id=None,
    )
    _sync_informers(
        folder=os.path.join(ws_path, "informers"),
        scope=SCOPE_WORKSPACE,
        workspace_id=workspace_id,
        swarm_id=None,
    )

    swarms_dir = os.path.join(ws_path, "swarms")
    if not os.path.isdir(swarms_dir):
        return
    for swarm_name in os.listdir(swarms_dir):
        swarm_path = os.path.join(swarms_dir, swarm_name)
        if os.path.isdir(swarm_path):
            _scan_swarm(data_dir, swarm_path, swarm_name, ws_path, workspace_id)


def _scan_swarm(
    data_dir: str,
    swarm_path: str,
    swarm_name: str,
    ws_path: str,
    workspace_id: str,
) -> None:
    hierarchy_path = os.path.join(swarm_path, "hierarchy.json")

    with get_session() as session:
        swarm = session.execute(
            select(Swarm).where(
                Swarm.workspace_id == workspace_id,
                Swarm.name == swarm_name,
            )
        ).scalar_one_or_none()

        if not swarm:
            meta = _read_meta(swarm_path)
            swarm = Swarm(
                workspace_id=workspace_id,
                name=swarm_name,
                display_name=meta.get("display_name", swarm_name),
                description=meta.get("description"),
                icon=meta.get("icon"),
                meta_hash=_hash_file(os.path.join(swarm_path, "meta.yaml")),
                hierarchy_hash=_hash_file(hierarchy_path),
            )
            session.add(swarm)
            session.commit()
            session.refresh(swarm)
        swarm_id = swarm.id

    # Validate hierarchy
    _validate_and_cache_hierarchy(
        hierarchy_path=hierarchy_path,
        swarm_id=swarm_id,
        swarm_path=swarm_path,
        workspace_path=ws_path,
        data_dir=data_dir,
    )

    # Ensure files/ directory exists and reconcile index
    ensure_files_dir(swarm_path)
    try:
        reconcile(swarm_id, os.path.join(swarm_path, "files"))
    except Exception:
        logger.exception("Reconciliation failed for swarm %s", swarm_id)

    # Sync resources
    _sync_agents(
        agents_folder=os.path.join(swarm_path, "agents"),
        swarm_id=swarm_id,
        workspace_id=workspace_id,
    )
    _sync_knowledge_docs(
        folder=os.path.join(swarm_path, "knowledge"),
        scope=SCOPE_SWARM,
        workspace_id=workspace_id,
        swarm_id=swarm_id,
    )
    _sync_triggers(
        triggers_folder=os.path.join(swarm_path, "triggers"),
        swarm_id=swarm_id,
    )
    _sync_callers(
        folder=os.path.join(swarm_path, "callers"),
        scope=SCOPE_SWARM,
        workspace_id=workspace_id,
        swarm_id=swarm_id,
    )
    _sync_informers(
        folder=os.path.join(swarm_path, "informers"),
        scope=SCOPE_SWARM,
        workspace_id=workspace_id,
        swarm_id=swarm_id,
    )


# ── Hierarchy validation ──────────────────────────────────────────────────────

def _validate_and_cache_hierarchy(
    hierarchy_path: str,
    swarm_id: str,
    swarm_path: str,
    workspace_path: str,
    data_dir: str,
) -> None:
    with get_session() as session:
        swarm = session.get(Swarm, swarm_id)
        if not swarm:
            return

        try:
            parsed = load_and_validate(
                hierarchy_path,
                swarm_path=swarm_path,
                workspace_path=workspace_path,
                data_dir=data_dir,
            )
            swarm.enabled = True
            swarm.validation_error = None
            session.commit()

            with _cache_lock:
                _hierarchy_cache[swarm_id] = parsed

            logger.info("Swarm '%s' hierarchy validated OK", swarm.name)

        except HierarchyValidationError as exc:
            swarm.enabled = False
            swarm.validation_error = str(exc)
            session.commit()

            with _cache_lock:
                _hierarchy_cache.pop(swarm_id, None)

            logger.warning("Swarm '%s' hierarchy invalid: %s", swarm.name, exc)


# ── Agent syncing ─────────────────────────────────────────────────────────────

def _sync_agents(agents_folder: str, swarm_id: str, workspace_id: str) -> None:
    if not os.path.isdir(agents_folder):
        return

    with get_session() as session:
        for filename in os.listdir(agents_folder):
            if not filename.endswith(".md"):
                continue
            name = filename[:-3]
            md_path = os.path.join(agents_folder, filename)
            md_hash = _hash_file(md_path)

            # Parse frontmatter for layer and model
            try:
                post = frontmatter.load(md_path)
                layer = post.get("layer", "orchestrator")
                model = post.get("model")
            except Exception as exc:
                logger.warning("Could not parse frontmatter in %s: %s", md_path, exc)
                layer = "orchestrator"
                model = None

            existing = session.execute(
                select(Agent).where(Agent.swarm_id == swarm_id, Agent.name == name)
            ).scalar_one_or_none()

            if existing:
                if existing.md_hash != md_hash:
                    existing.md_hash = md_hash
                    existing.layer = layer
                    existing.model = model
                    existing.md_path = md_path
                    session.commit()
            else:
                agent = Agent(
                    swarm_id=swarm_id,
                    workspace_id=workspace_id,
                    scope=SCOPE_SWARM,
                    name=name,
                    layer=layer,
                    model=model,
                    md_path=md_path,
                    md_hash=md_hash,
                )
                session.add(agent)
                session.commit()


def _sync_perceptionists(
    folder: str,
    scope: str,
    workspace_id: str | None,
    swarm_id: str | None,
) -> None:
    if not os.path.isdir(folder):
        return

    with get_session() as session:
        for filename in os.listdir(folder):
            if not filename.endswith(".md"):
                continue
            name = filename[:-3]
            md_path = os.path.join(folder, filename)
            md_hash = _hash_file(md_path)

            try:
                post = frontmatter.load(md_path)
                model = post.get("model")
            except Exception:
                model = None

            existing = session.execute(
                select(Agent).where(
                    Agent.scope == scope,
                    Agent.workspace_id == workspace_id,
                    Agent.swarm_id == swarm_id,
                    Agent.name == name,
                )
            ).scalar_one_or_none()

            if existing:
                if existing.md_hash != md_hash:
                    existing.md_hash = md_hash
                    existing.model = model
                    session.commit()
            else:
                agent = Agent(
                    swarm_id=swarm_id,
                    workspace_id=workspace_id,
                    scope=scope,
                    name=name,
                    layer="perceptionist",
                    model=model,
                    md_path=md_path,
                    md_hash=md_hash,
                )
                session.add(agent)
                session.commit()


# ── Caller syncing (Phase 6) ─────────────────────────────────────────────────

def _sync_callers(
    folder: str,
    scope: str,
    workspace_id: str | None,
    swarm_id: str | None,
) -> None:
    """Walk a `callers/` folder and reflect each `.md` file into the registry.

    Frontmatter must include at minimum `name` and `display_name`. Files that
    fail validation are skipped (the row, if any, is marked `enabled=False`)
    so a single broken caller can't take down a whole swarm.
    """
    if not os.path.isdir(folder):
        return

    with get_session() as session:
        for filename in os.listdir(folder):
            if not filename.endswith(".md"):
                continue
            name = filename[:-3]
            md_path = os.path.join(folder, filename)
            md_hash = _hash_file(md_path)

            display_name = name
            ok = True
            try:
                post = frontmatter.load(md_path)
                fm = post.metadata or {}
                if fm.get("name") and fm["name"] != name:
                    ok = False
                if not isinstance(fm.get("contacts", []), list):
                    ok = False
                ta = fm.get("timeout_action")
                if ta is not None and ta not in VALID_TIMEOUT_ACTIONS:
                    ok = False
                eas = fm.get("escalation_after_seconds")
                if eas is not None and (not isinstance(eas, int) or eas <= 0):
                    ok = False
                display_name = fm.get("display_name") or name
            except Exception as exc:
                logger.warning("Could not parse caller %s: %s", md_path, exc)
                ok = False

            existing = session.execute(
                select(Caller).where(
                    Caller.scope == scope,
                    Caller.workspace_id == workspace_id,
                    Caller.swarm_id == swarm_id,
                    Caller.name == name,
                )
            ).scalar_one_or_none()

            if existing:
                if existing.md_hash != md_hash or existing.enabled != ok or existing.display_name != display_name:
                    existing.md_hash = md_hash
                    existing.display_name = display_name
                    existing.enabled = ok
                    session.commit()
            else:
                caller = Caller(
                    scope=scope,
                    workspace_id=workspace_id,
                    swarm_id=swarm_id,
                    name=name,
                    display_name=display_name,
                    md_path=md_path,
                    md_hash=md_hash,
                    enabled=ok,
                )
                session.add(caller)
                session.commit()


# ── Informer syncing (Phase 6.1) ─────────────────────────────────────────────

def _sync_informers(
    folder: str,
    scope: str,
    workspace_id: str | None,
    swarm_id: str | None,
) -> None:
    """Walk an `informers/` folder and reflect each `.md` file into the registry.

    Frontmatter must include at minimum `name` and `display_name`. Files that
    fail validation are skipped (the row, if any, is marked `enabled=False`).
    """
    if not os.path.isdir(folder):
        return

    with get_session() as session:
        for filename in os.listdir(folder):
            if not filename.endswith(".md"):
                continue
            name = filename[:-3]
            md_path = os.path.join(folder, filename)
            md_hash = _hash_file(md_path)

            display_name = name
            ok = True
            try:
                post = frontmatter.load(md_path)
                fm = post.metadata or {}
                if fm.get("name") and fm["name"] != name:
                    ok = False
                if not isinstance(fm.get("contacts", []), list):
                    ok = False
                display_name = fm.get("display_name") or name
            except Exception as exc:
                logger.warning("Could not parse informer %s: %s", md_path, exc)
                ok = False

            existing = session.execute(
                select(Informer).where(
                    Informer.scope == scope,
                    Informer.workspace_id == workspace_id,
                    Informer.swarm_id == swarm_id,
                    Informer.name == name,
                )
            ).scalar_one_or_none()

            if existing:
                if existing.md_hash != md_hash or existing.enabled != ok or existing.display_name != display_name:
                    existing.md_hash = md_hash
                    existing.display_name = display_name
                    existing.enabled = ok
                    session.commit()
            else:
                informer = Informer(
                    scope=scope,
                    workspace_id=workspace_id,
                    swarm_id=swarm_id,
                    name=name,
                    display_name=display_name,
                    md_path=md_path,
                    md_hash=md_hash,
                    enabled=ok,
                )
                session.add(informer)
                session.commit()


# ── Knowledge syncing ─────────────────────────────────────────────────────────

def _sync_knowledge_docs(
    folder: str,
    scope: str,
    workspace_id: str | None,
    swarm_id: str | None,
) -> None:
    if not os.path.isdir(folder):
        return

    with get_session() as session:
        for filename in os.listdir(folder):
            if not filename.endswith(".md"):
                continue
            name = filename[:-3]
            md_path = os.path.join(folder, filename)
            md_hash = _hash_file(md_path)
            size_bytes = os.path.getsize(md_path)
            title = _extract_title(md_path)

            existing = session.execute(
                select(KnowledgeDocument).where(
                    KnowledgeDocument.scope == scope,
                    KnowledgeDocument.workspace_id == workspace_id,
                    KnowledgeDocument.swarm_id == swarm_id,
                    KnowledgeDocument.name == name,
                )
            ).scalar_one_or_none()

            if existing:
                if existing.md_hash != md_hash:
                    existing.md_hash = md_hash
                    existing.size_bytes = size_bytes
                    existing.title = title
                    existing.md_path = md_path
                    session.commit()
            else:
                doc = KnowledgeDocument(
                    scope=scope,
                    workspace_id=workspace_id,
                    swarm_id=swarm_id,
                    name=name,
                    md_path=md_path,
                    md_hash=md_hash,
                    size_bytes=size_bytes,
                    title=title,
                )
                session.add(doc)
                session.commit()


# ── Trigger syncing ───────────────────────────────────────────────────────────

def _sync_triggers(triggers_folder: str, swarm_id: str) -> None:
    if not os.path.isdir(triggers_folder):
        return

    with get_session() as session:
        for filename in os.listdir(triggers_folder):
            if not filename.endswith(".yaml"):
                continue
            name = filename[:-5]
            yaml_path = os.path.join(triggers_folder, filename)

            try:
                with open(yaml_path) as f:
                    config = yaml.safe_load(f)
            except Exception as exc:
                logger.warning("Could not parse trigger config %s: %s", yaml_path, exc)
                continue

            kind = config.get("kind", "heartbeat")
            existing = session.execute(
                select(Trigger).where(
                    Trigger.swarm_id == swarm_id,
                    Trigger.name == name,
                )
            ).scalar_one_or_none()

            if existing:
                existing.kind = kind
                existing.config_json = json.dumps(config)
                session.commit()
            else:
                trigger = Trigger(
                    swarm_id=swarm_id,
                    name=name,
                    kind=kind,
                    config_json=json.dumps(config),
                    enabled=True,
                )
                session.add(trigger)
                session.commit()


# ── Utilities ─────────────────────────────────────────────────────────────────

def _hash_file(path: str) -> str:
    if not os.path.isfile(path):
        return ""
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def _read_meta(folder: str) -> dict:
    meta_path = os.path.join(folder, "meta.yaml")
    if not os.path.isfile(meta_path):
        return {}
    try:
        with open(meta_path) as f:
            return yaml.safe_load(f) or {}
    except Exception:
        return {}


def _extract_title(md_path: str) -> str | None:
    try:
        with open(md_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("# "):
                    return line[2:].strip()
    except Exception:
        pass
    return None


# ── File watcher ──────────────────────────────────────────────────────────────

class _RegistryEventHandler(FileSystemEventHandler):
    """Re-scans the affected workspace or swarm when files change."""

    def __init__(self, data_dir: str) -> None:
        self._data_dir = data_dir
        self._debounce_timer: threading.Timer | None = None
        self._lock = threading.Lock()

    def on_any_event(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        # Ignore SQLite database files — their writes would cause infinite rescan loops
        src = getattr(event, "src_path", "") or ""
        if any(src.endswith(suffix) for suffix in (".db", ".db-wal", ".db-shm", ".db-journal")):
            return
        # Ignore swarm files/ directories — they contain runtime artifacts, not config
        if "/files/" in src or src.endswith("/files"):
            return
        # Debounce: wait 2 seconds after the last event before re-scanning
        with self._lock:
            if self._debounce_timer:
                self._debounce_timer.cancel()
            self._debounce_timer = threading.Timer(2.0, self._rescan)
            self._debounce_timer.start()

    def _rescan(self) -> None:
        logger.debug("File change detected — re-scanning data directory")
        try:
            boot_scan(self._data_dir)
        except Exception:
            logger.exception("Error during registry re-scan")
