from __future__ import annotations

import hashlib
import logging
import mimetypes
import os
from datetime import datetime, timezone

from sqlalchemy import select

from app.db import get_session
from app.models.swarm_file import SwarmFile, ORIGIN_AGENT, ORIGIN_HUMAN, ORIGIN_UNKNOWN

logger = logging.getLogger(__name__)


def get_files_root(swarm_path: str) -> str:
    """Return the absolute path to a swarm's files/ directory."""
    return os.path.join(swarm_path, "files")


def ensure_files_dir(swarm_path: str) -> str:
    """Create files/ inside a swarm directory if it doesn't exist. Returns the path."""
    root = get_files_root(swarm_path)
    os.makedirs(root, exist_ok=True)
    return root


def upsert_file(
    swarm_id: str,
    path: str,
    *,
    size_bytes: int,
    checksum: str,
    origin: str = ORIGIN_AGENT,
    run_id: str | None = None,
    step_id: str | None = None,
) -> SwarmFile:
    """Insert or update a swarm_files index row after a successful file write.

    Creation metadata (created_at, created_by_run_id, created_by_step_id, origin)
    is set only on insert and never changed on subsequent updates.
    """
    filename = os.path.basename(path)
    mime_type, _ = mimetypes.guess_type(filename)
    now = datetime.now(timezone.utc)

    with get_session() as session:
        existing = session.execute(
            select(SwarmFile).where(
                SwarmFile.swarm_id == swarm_id,
                SwarmFile.path == path,
            )
        ).scalar_one_or_none()

        if existing:
            existing.size_bytes = size_bytes
            existing.checksum = checksum
            existing.mime_type = mime_type
            existing.updated_at = now
            existing.updated_by_run_id = run_id
            existing.updated_by_step_id = step_id
            session.commit()
            session.refresh(existing)
            return existing
        else:
            row = SwarmFile(
                swarm_id=swarm_id,
                path=path,
                filename=filename,
                size_bytes=size_bytes,
                mime_type=mime_type,
                checksum=checksum,
                origin=origin,
                created_at=now,
                updated_at=now,
                created_by_run_id=run_id,
                created_by_step_id=step_id,
                updated_by_run_id=run_id,
                updated_by_step_id=step_id,
            )
            session.add(row)
            session.commit()
            session.refresh(row)
            return row


def remove_file(swarm_id: str, path: str) -> bool:
    """Remove a swarm_files index row. Returns True if a row was deleted."""
    with get_session() as session:
        row = session.execute(
            select(SwarmFile).where(
                SwarmFile.swarm_id == swarm_id,
                SwarmFile.path == path,
            )
        ).scalar_one_or_none()
        if row:
            session.delete(row)
            session.commit()
            return True
        return False


def list_files(swarm_id: str, prefix: str | None = None) -> list[SwarmFile]:
    """Return all indexed files for a swarm, optionally filtered by path prefix."""
    with get_session() as session:
        q = select(SwarmFile).where(SwarmFile.swarm_id == swarm_id)
        rows = session.execute(q).scalars().all()
        if prefix:
            rows = [r for r in rows if r.path.startswith(prefix)]
        return [r for r in sorted(rows, key=lambda r: r.path)]


def reconcile(swarm_id: str, files_root: str) -> None:
    """Sync the swarm_files index against what's actually on disk.

    - Files on disk missing from DB  → inserted with origin="unknown" (logged as warning)
    - DB rows with no matching file   → deleted from DB (logged as warning)
    """
    if not os.path.isdir(files_root):
        return

    disk_files: dict[str, str] = {}  # rel_path → abs_path
    for dirpath, _, filenames in os.walk(files_root):
        for fname in filenames:
            abs_path = os.path.join(dirpath, fname)
            rel_path = os.path.relpath(abs_path, files_root)
            disk_files[rel_path] = abs_path

    with get_session() as session:
        db_rows = session.execute(
            select(SwarmFile).where(SwarmFile.swarm_id == swarm_id)
        ).scalars().all()
        db_paths = {r.path: r for r in db_rows}

        # Files on disk but not in DB
        for rel_path, abs_path in disk_files.items():
            if rel_path not in db_paths:
                logger.warning(
                    "swarm %s: orphan file on disk '%s' — adding to index with origin=unknown",
                    swarm_id, rel_path,
                )
                try:
                    size = os.path.getsize(abs_path)
                    with open(abs_path, "rb") as f:
                        checksum = hashlib.sha256(f.read()).hexdigest()
                except OSError:
                    size = 0
                    checksum = ""
                filename = os.path.basename(rel_path)
                mime_type, _ = mimetypes.guess_type(filename)
                now = datetime.now(timezone.utc)
                session.add(SwarmFile(
                    swarm_id=swarm_id,
                    path=rel_path,
                    filename=filename,
                    size_bytes=size,
                    mime_type=mime_type,
                    checksum=checksum,
                    origin=ORIGIN_UNKNOWN,
                    created_at=now,
                    updated_at=now,
                ))

        # DB rows with no matching file on disk
        for rel_path, row in db_paths.items():
            if rel_path not in disk_files:
                logger.warning(
                    "swarm %s: DB row for '%s' has no file on disk — removing from index",
                    swarm_id, rel_path,
                )
                session.delete(row)

        session.commit()
