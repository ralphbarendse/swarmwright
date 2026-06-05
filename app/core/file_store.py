from __future__ import annotations

import hashlib
import logging
import mimetypes
import os
from datetime import datetime, timezone

from sqlalchemy import func, or_, select

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


# ── Logical links ─────────────────────────────────────────────────────────────
# A link is a swarm_files row whose `links_to_file_id` points at a *canonical*
# row in another swarm. The bytes live with the canonical row; the link only
# carries display metadata. Links never point at other links.


def resolve_canonical(swarm_file: SwarmFile, session) -> SwarmFile | None:
    """Return the canonical row a file resolves to (itself if not a link).

    Returns None if the row is a link whose target no longer exists (dangling).
    """
    if not swarm_file.links_to_file_id:
        return swarm_file
    return session.get(SwarmFile, swarm_file.links_to_file_id)


def links_to(file_id: str, session) -> list[SwarmFile]:
    """Return every link row pointing at the given canonical file id."""
    return list(
        session.execute(
            select(SwarmFile).where(SwarmFile.links_to_file_id == file_id)
        ).scalars().all()
    )


def create_link(target_swarm_id: str, source_file_id: str, path: str | None = None) -> SwarmFile:
    """Create a link row in `target_swarm_id` pointing at a canonical source file.

    Copies display metadata (size/mime/checksum/origin) from the canonical row so
    listings render correctly without an extra lookup; bytes are always served
    from the canonical row at download time. Raises ValueError if the source is
    missing. Path defaults to the canonical filename. A duplicate (swarm_id, path)
    raises sqlalchemy.exc.IntegrityError via the unique constraint.
    """
    with get_session() as session:
        source = session.get(SwarmFile, source_file_id)
        if source is None:
            raise ValueError("source file not found")
        # Never chain links — collapse to the true canonical row.
        canonical = resolve_canonical(source, session)
        if canonical is None:
            raise ValueError("source file is a dangling link")

        link_path = path or canonical.filename
        now = datetime.now(timezone.utc)
        row = SwarmFile(
            swarm_id=target_swarm_id,
            path=link_path,
            filename=os.path.basename(link_path),
            size_bytes=canonical.size_bytes,
            mime_type=canonical.mime_type,
            checksum=canonical.checksum,
            origin=canonical.origin,
            created_at=now,
            updated_at=now,
            links_to_file_id=canonical.id,
        )
        session.add(row)
        session.commit()
        session.refresh(row)
        return row


def list_files(swarm_id: str, prefix: str | None = None) -> list[SwarmFile]:
    """Return all indexed files for a swarm, optionally filtered by path prefix."""
    with get_session() as session:
        q = select(SwarmFile).where(SwarmFile.swarm_id == swarm_id)
        rows = session.execute(q).scalars().all()
        if prefix:
            rows = [r for r in rows if r.path.startswith(prefix)]
        return [r for r in sorted(rows, key=lambda r: r.path)]


def list_all_files(
    search: str | None = None,
    workspace_id: str | None = None,
    limit: int = 500,
    offset: int = 0,
) -> dict:
    """Return a page of indexed files across all swarms, enriched for the browser.

    Read-only aggregation that backs the org-wide Files browser. Returns
    ``{"rows": [...], "total": N}`` where each row is a SwarmFile.to_dict() plus
    the owning swarm/workspace id + display names (so the UI can group without N
    lookups) and, for link rows, a `link_source` describing the canonical file.
    Ordered most-recently-updated first. `search` matches filename or path in SQL
    (case-insensitive). `total` reflects the filtered count before pagination.
    """
    from app.models.swarm import Swarm
    from app.models.workspace import Workspace

    needle = search.strip() if search else None

    with get_session() as session:
        base = (
            select(SwarmFile, Swarm, Workspace)
            .join(Swarm, SwarmFile.swarm_id == Swarm.id)
            .join(Workspace, Swarm.workspace_id == Workspace.id)
        )
        if workspace_id:
            base = base.where(Swarm.workspace_id == workspace_id)
        if needle:
            like = f"%{needle}%"
            base = base.where(or_(SwarmFile.filename.ilike(like), SwarmFile.path.ilike(like)))

        total = session.execute(
            select(func.count()).select_from(base.order_by(None).subquery())
        ).scalar_one()

        rows = session.execute(
            base.order_by(SwarmFile.updated_at.desc()).limit(limit).offset(offset)
        ).all()

        # Resolve canonical provenance for any link rows on this page.
        link_target_ids = {sf.links_to_file_id for sf, _, _ in rows if sf.links_to_file_id}
        canon_map: dict[str, tuple[SwarmFile, Swarm, Workspace]] = {}
        if link_target_ids:
            for csf, cswarm, cws in session.execute(
                select(SwarmFile, Swarm, Workspace)
                .join(Swarm, SwarmFile.swarm_id == Swarm.id)
                .join(Workspace, Swarm.workspace_id == Workspace.id)
                .where(SwarmFile.id.in_(link_target_ids))
            ).all():
                canon_map[csf.id] = (csf, cswarm, cws)

        # Count links pointing at the canonical files shown on this page.
        page_ids = [sf.id for sf, _, _ in rows]
        link_counts: dict[str, int] = {}
        if page_ids:
            for fid, cnt in session.execute(
                select(SwarmFile.links_to_file_id, func.count())
                .where(SwarmFile.links_to_file_id.in_(page_ids))
                .group_by(SwarmFile.links_to_file_id)
            ).all():
                link_counts[fid] = cnt

        results: list[dict] = []
        for sf, swarm, ws in rows:
            d = sf.to_dict()
            d["swarm_name"] = swarm.name
            d["swarm_display_name"] = swarm.display_name
            d["workspace_id"] = ws.id
            d["workspace_name"] = ws.name
            d["workspace_display_name"] = ws.display_name
            d["link_count"] = link_counts.get(sf.id, 0)
            if sf.links_to_file_id:
                canon = canon_map.get(sf.links_to_file_id)
                if canon:
                    csf, cswarm, cws = canon
                    # Keep displayed size/mime fresh from the canonical bytes.
                    d["size_bytes"] = csf.size_bytes
                    d["mime_type"] = csf.mime_type
                    d["link_source"] = {
                        "swarm_id": cswarm.id,
                        "swarm_name": cswarm.name,
                        "swarm_display_name": cswarm.display_name,
                        "workspace_display_name": cws.display_name,
                        "path": csf.path,
                    }
                else:
                    d["link_source"] = None  # dangling link
            results.append(d)

    return {"rows": results, "total": total}


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
