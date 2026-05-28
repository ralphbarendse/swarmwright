"""Built-in swarm reconciliation.

On every boot the platform ensures that built-in swarm templates in
``app/builtin_swarms/`` are materialised into the correct location inside
``data/``.  Operator modifications are respected — if the operator has changed
a built-in's files the reconciler leaves them alone and logs a notice.

Scope rules:
- ``scope: platform``  → materialised once into
  ``data/workspaces/platform/swarms/<name>/``
- ``scope: workspace`` → materialised into every workspace's
  ``swarms/<name>/`` directory; ``swarm_calls`` is regenerated to reflect
  current sibling swarms.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
from typing import Any

import yaml

logger = logging.getLogger(__name__)

_BUNDLE_DIR = os.path.join(os.path.dirname(__file__), "..", "builtin_swarms")


def _bundle_dir() -> str:
    return os.path.normpath(_BUNDLE_DIR)


def _file_hash(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


def _dir_hash(path: str) -> str:
    """Stable hash of all files in a directory tree (sorted by relative path).

    The .builtin_hash stamp file is excluded so it doesn't create a circular
    dependency: the stamp stores the bundle hash, but bundle has no stamp file,
    so including the stamp in the dest hash would always make dest != stamp.
    """
    h = hashlib.sha256()
    for root, _dirs, files in os.walk(path):
        for fname in sorted(files):
            if fname == ".builtin_hash":
                continue
            full = os.path.join(root, fname)
            rel = os.path.relpath(full, path)
            h.update(rel.encode())
            h.update(_file_hash(full).encode())
    return h.hexdigest()


def _load_meta(bundle_path: str) -> dict[str, Any]:
    meta_path = os.path.join(bundle_path, "meta.yaml")
    if not os.path.isfile(meta_path):
        return {}
    with open(meta_path) as f:
        return yaml.safe_load(f) or {}


def _disabled_bundles(data_dir: str) -> set[str]:
    """Read builtin_swarms.disabled setting from the database."""
    try:
        from app.db import get_session
        from app.models.settings import Setting
        with get_session() as session:
            row = session.get(Setting, "builtin_swarms.disabled")
        if row and row.value_encrypted:
            val = json.loads(row.value_encrypted)
            if isinstance(val, list):
                return set(val)
    except Exception:
        pass
    return set()


def _materialise(bundle_path: str, dest_path: str, name: str) -> None:
    """Copy bundle → dest, skipping if dest is operator-modified."""
    if os.path.isdir(dest_path):
        bundle_hash = _dir_hash(bundle_path)
        dest_hash = _dir_hash(dest_path)
        if bundle_hash == dest_hash:
            return
        # Check for a stored original hash to detect operator modifications
        stamp = os.path.join(dest_path, ".builtin_hash")
        if os.path.isfile(stamp):
            with open(stamp) as f:
                original_hash = f.read().strip()
            if dest_hash != original_hash:
                logger.info(
                    "Built-in swarm '%s' has operator modifications — skipping refresh", name
                )
                return
        # dest exists but matches original (or no stamp yet) — refresh
        shutil.rmtree(dest_path)

    shutil.copytree(bundle_path, dest_path)
    # Write stamp so future reconciliations can detect operator changes
    bundle_hash = _dir_hash(bundle_path)
    with open(os.path.join(dest_path, ".builtin_hash"), "w") as f:
        f.write(bundle_hash)
    logger.info("Materialised built-in swarm '%s' → %s", name, dest_path)


def _update_swarm_source(name: str, workspace_name: str) -> None:
    """Mark the swarm row source='builtin' in the database if it exists."""
    try:
        from app.db import get_session
        from app.models.swarm import Swarm
        from app.models.workspace import Workspace
        from sqlalchemy import select
        with get_session() as session:
            ws = session.execute(
                select(Workspace).where(Workspace.name == workspace_name)
            ).scalar_one_or_none()
            if ws is None:
                return
            swarm = session.execute(
                select(Swarm).where(Swarm.workspace_id == ws.id, Swarm.name == name)
            ).scalar_one_or_none()
            if swarm and swarm.source != "builtin":
                swarm.source = "builtin"
                session.commit()
    except Exception:
        logger.debug("Could not update swarm source for '%s' — registry may not have run yet", name)


def _resolve_sibling_swarm_ids(workspace_path: str, siblings: list[str]) -> dict[str, str]:
    """Return {swarm_name: swarm_uuid} for each sibling name, querying the DB.

    Falls back to the name itself if the DB lookup fails (e.g. registry hasn't
    run yet on first boot before the swarm row exists).
    """
    id_map: dict[str, str] = {s: s for s in siblings}  # fallback: name == id
    try:
        from app.db import get_session
        from app.models.swarm import Swarm
        from app.models.workspace import Workspace
        from sqlalchemy import select

        ws_name = os.path.basename(workspace_path)
        with get_session() as session:
            ws = session.execute(
                select(Workspace).where(Workspace.name == ws_name)
            ).scalar_one_or_none()
            if ws is None:
                return id_map
            rows = session.execute(
                select(Swarm.name, Swarm.id).where(
                    Swarm.workspace_id == ws.id,
                    Swarm.name.in_(siblings),
                )
            ).all()
        for row in rows:
            id_map[row.name] = row.id
    except Exception:
        pass
    return id_map


def _reconcile_concierge_swarm_calls(workspace_path: str) -> None:
    """Regenerate concierge's swarm_calls in hierarchy.json to match current siblings."""
    concierge_hier = os.path.join(workspace_path, "swarms", "concierge", "hierarchy.json")
    if not os.path.isfile(concierge_hier):
        return

    swarms_dir = os.path.join(workspace_path, "swarms")
    siblings = sorted(
        d for d in os.listdir(swarms_dir)
        if os.path.isdir(os.path.join(swarms_dir, d)) and d != "concierge"
    )

    try:
        with open(concierge_hier) as f:
            hier = json.load(f)
    except Exception:
        return

    id_map = _resolve_sibling_swarm_ids(workspace_path, siblings)

    hier["swarm_calls"] = [
        {
            "agent": "concierge",
            "alias": s,
            "swarm_id": id_map[s],
            "purpose": f"Route user request to the {s} swarm.",
        }
        for s in siblings
    ]

    with open(concierge_hier, "w") as f:
        json.dump(hier, f, indent=2)


def reconcile(data_dir: str) -> None:
    """Reconcile all built-in swarm templates against data_dir on every boot."""
    bundle_root = _bundle_dir()
    if not os.path.isdir(bundle_root):
        logger.debug("No builtin_swarms directory found at %s — skipping", bundle_root)
        return

    disabled = _disabled_bundles(data_dir)
    workspaces_dir = os.path.join(data_dir, "workspaces")

    for name in sorted(os.listdir(bundle_root)):
        bundle_path = os.path.join(bundle_root, name)
        if not os.path.isdir(bundle_path):
            continue
        if name in disabled:
            logger.info("Built-in swarm '%s' is disabled via settings — skipping", name)
            continue

        meta = _load_meta(bundle_path)
        scope = meta.get("scope", "platform")

        if scope == "platform":
            dest = os.path.join(workspaces_dir, "platform", "swarms", name)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            _materialise(bundle_path, dest, name)
            _update_swarm_source(name, "platform")

        elif scope == "workspace":
            if not os.path.isdir(workspaces_dir):
                continue
            for ws_name in os.listdir(workspaces_dir):
                ws_path = os.path.join(workspaces_dir, ws_name)
                if not os.path.isdir(ws_path):
                    continue
                if ws_name == "platform":
                    continue
                dest = os.path.join(ws_path, "swarms", name)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                _materialise(bundle_path, dest, name)
                _update_swarm_source(name, ws_name)
                if name == "concierge":
                    _reconcile_concierge_swarm_calls(ws_path)


def reconcile_workspace(workspace_path: str) -> None:
    """Materialise workspace-scope built-ins into a single workspace.

    Called when a new workspace is created so it gets built-ins immediately
    without waiting for the next full boot reconciliation.
    """
    bundle_root = _bundle_dir()
    if not os.path.isdir(bundle_root):
        return

    for name in sorted(os.listdir(bundle_root)):
        bundle_path = os.path.join(bundle_root, name)
        if not os.path.isdir(bundle_path):
            continue
        meta = _load_meta(bundle_path)
        if meta.get("scope") != "workspace":
            continue
        dest = os.path.join(workspace_path, "swarms", name)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        _materialise(bundle_path, dest, name)
        if name == "concierge":
            _reconcile_concierge_swarm_calls(workspace_path)
