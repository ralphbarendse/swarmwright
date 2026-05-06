"""Callers + Informers + Inbox API — Phase 6 / 6.1.

Three related surfaces:

- ``/callers`` — CRUD over the on-disk Caller `.md` files
- ``/informers`` — CRUD over the on-disk Informer `.md` files
- ``/inbox`` — decision queue over `human_actions` rows (blocking calls)
- ``/informs`` — notification queue over `human_informs` rows (non-blocking)
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Literal

import frontmatter
from flask import Blueprint, current_app, jsonify, request
from pydantic import BaseModel, ValidationError, field_validator
from sqlalchemy import desc, select

from app.core import runtime
from app.db import get_session
from app.models.caller import Caller, VALID_TIMEOUT_ACTIONS
from app.models.human_action import (
    HumanAction,
    STATUS_PENDING,
    STATUS_YES,
    STATUS_NO,
)
from app.models.human_inform import (
    HumanInform,
    STATUS_UNREAD,
    STATUS_READ,
    STATUS_DISMISSED,
)
from app.models.informer import Informer
from app.models.run import Run
from app.models.swarm import Swarm
from app.models.workspace import Workspace

logger = logging.getLogger(__name__)

bp = Blueprint("callers_inbox", __name__, url_prefix="/api/v1")

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


# ── Pydantic models ──────────────────────────────────────────────────────────

class CallerWrite(BaseModel):
    scope: str
    workspace_id: str | None = None
    swarm_id: str | None = None
    name: str
    display_name: str
    contacts: list[str] = []
    body: str = ""
    timeout_action: str | None = None
    escalation_after_seconds: int | None = None
    fallback: str | None = None

    @field_validator("scope")
    @classmethod
    def _check_scope(cls, v):
        if v not in ("company", "workspace", "swarm"):
            raise ValueError("scope must be company, workspace, or swarm")
        return v

    @field_validator("timeout_action")
    @classmethod
    def _check_ta(cls, v):
        if v is not None and v not in VALID_TIMEOUT_ACTIONS:
            raise ValueError(f"timeout_action must be one of {sorted(VALID_TIMEOUT_ACTIONS)}")
        return v


class InformerWrite(BaseModel):
    scope: str
    workspace_id: str | None = None
    swarm_id: str | None = None
    name: str
    display_name: str
    contacts: list[str] = []
    body: str = ""

    @field_validator("scope")
    @classmethod
    def _check_scope(cls, v):
        if v not in ("company", "workspace", "swarm"):
            raise ValueError("scope must be company, workspace, or swarm")
        return v


class DecisionRequest(BaseModel):
    decision: Literal["yes", "no"]
    amend: dict | list | str | int | float | bool | None = None
    reason: str | None = None
    actor: str | None = None


class AckRequest(BaseModel):
    actor: str | None = None


# ── Helpers ──────────────────────────────────────────────────────────────────

def _error(code: str, message: str, status: int = 400):
    return jsonify({"error": {"code": code, "message": message}}), status


def _scope_folder(scope: str, workspace_id: str | None, swarm_id: str | None, data_dir: str, subfolder: str) -> str | None:
    if scope == "company":
        return os.path.join(data_dir, "company", subfolder)
    if scope == "workspace" and workspace_id:
        with get_session() as session:
            ws = session.get(Workspace, workspace_id)
        if not ws:
            return None
        return os.path.join(data_dir, "workspaces", ws.name, subfolder)
    if scope == "swarm" and swarm_id:
        with get_session() as session:
            swarm = session.get(Swarm, swarm_id)
            if not swarm:
                return None
            ws = session.get(Workspace, swarm.workspace_id)
        if not ws:
            return None
        return os.path.join(data_dir, "workspaces", ws.name, "swarms", swarm.name, subfolder)
    return None


def _write_caller_file(folder: str, body: CallerWrite) -> str:
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, f"{body.name}.md")
    fm = {
        "name": body.name,
        "display_name": body.display_name,
        "contacts": body.contacts,
    }
    if body.timeout_action:
        fm["timeout_action"] = body.timeout_action
    if body.escalation_after_seconds:
        fm["escalation_after_seconds"] = body.escalation_after_seconds
    if body.fallback:
        fm["fallback"] = body.fallback

    post = frontmatter.Post(body.body or "", **fm)
    rendered = frontmatter.dumps(post)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(rendered)
    os.replace(tmp, path)
    return path


def _write_informer_file(folder: str, body: InformerWrite) -> str:
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, f"{body.name}.md")
    fm = {
        "name": body.name,
        "display_name": body.display_name,
        "contacts": body.contacts,
    }
    post = frontmatter.Post(body.body or "", **fm)
    rendered = frontmatter.dumps(post)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(rendered)
    os.replace(tmp, path)
    return path


# ── Caller CRUD ──────────────────────────────────────────────────────────────

@bp.get("/callers")
def list_callers():
    scope = request.args.get("scope")
    workspace_id = request.args.get("workspace_id")
    swarm_id = request.args.get("swarm_id")

    with get_session() as session:
        stmt = select(Caller).order_by(Caller.scope, Caller.name)
        if scope:
            stmt = stmt.where(Caller.scope == scope)
        if workspace_id:
            stmt = stmt.where(Caller.workspace_id == workspace_id)
        if swarm_id:
            stmt = stmt.where(Caller.swarm_id == swarm_id)
        rows = session.execute(stmt).scalars().all()
        return jsonify([r.to_dict() for r in rows])


@bp.get("/callers/<name>")
def get_caller(name: str):
    scope = request.args.get("scope", "company")
    workspace_id = request.args.get("workspace_id")
    swarm_id = request.args.get("swarm_id")

    with get_session() as session:
        row = session.execute(
            select(Caller).where(
                Caller.name == name,
                Caller.scope == scope,
                Caller.workspace_id == workspace_id,
                Caller.swarm_id == swarm_id,
            )
        ).scalar_one_or_none()

    if not row:
        return _error("not_found", f"Caller {name!r} not found at scope {scope!r}", 404)

    body = ""
    fm = {}
    if os.path.isfile(row.md_path):
        try:
            post = frontmatter.load(row.md_path)
            body = post.content
            fm = post.metadata or {}
        except Exception as exc:
            logger.warning("Could not parse caller %s: %s", row.md_path, exc)

    return jsonify({
        **row.to_dict(),
        "body": body,
        "contacts": fm.get("contacts", []),
        "timeout_action": fm.get("timeout_action"),
        "escalation_after_seconds": fm.get("escalation_after_seconds"),
        "fallback": fm.get("fallback"),
    })


@bp.post("/callers")
def create_caller():
    try:
        body = CallerWrite.model_validate(request.get_json(force=True) or {})
    except ValidationError as exc:
        return _error("validation_error", str(exc), 400)

    if not _NAME_RE.match(body.name):
        return _error(
            "validation_error",
            "Name must be lowercase letters, digits, and hyphens (start with letter/digit)",
            400,
        )

    data_dir = current_app.config["DATA_DIR"]
    folder = _scope_folder(body.scope, body.workspace_id, body.swarm_id, data_dir, "callers")
    if not folder:
        return _error("not_found", "Scope target not found", 404)

    path = os.path.join(folder, f"{body.name}.md")
    if os.path.isfile(path):
        return _error("conflict", f"Caller {body.name!r} already exists at this scope", 409)

    _write_caller_file(folder, body)
    from app.core.registry import _sync_callers
    from app.models.agent import SCOPE_COMPANY, SCOPE_WORKSPACE, SCOPE_SWARM
    scope_const = {"company": SCOPE_COMPANY, "workspace": SCOPE_WORKSPACE, "swarm": SCOPE_SWARM}[body.scope]
    _sync_callers(folder, scope_const, body.workspace_id, body.swarm_id)

    return get_caller(body.name)


@bp.put("/callers/<name>")
def update_caller(name: str):
    try:
        body = CallerWrite.model_validate(request.get_json(force=True) or {})
    except ValidationError as exc:
        return _error("validation_error", str(exc), 400)
    if body.name != name:
        return _error("validation_error", "Name in URL and body must match", 400)

    data_dir = current_app.config["DATA_DIR"]
    folder = _scope_folder(body.scope, body.workspace_id, body.swarm_id, data_dir, "callers")
    if not folder:
        return _error("not_found", "Scope target not found", 404)
    path = os.path.join(folder, f"{name}.md")
    if not os.path.isfile(path):
        return _error("not_found", f"Caller {name!r} not found", 404)

    _write_caller_file(folder, body)

    from app.core.registry import _sync_callers
    from app.models.agent import SCOPE_COMPANY, SCOPE_WORKSPACE, SCOPE_SWARM
    scope_const = {"company": SCOPE_COMPANY, "workspace": SCOPE_WORKSPACE, "swarm": SCOPE_SWARM}[body.scope]
    _sync_callers(folder, scope_const, body.workspace_id, body.swarm_id)

    return get_caller(name)


@bp.delete("/callers/<name>")
def delete_caller(name: str):
    scope = request.args.get("scope", "company")
    workspace_id = request.args.get("workspace_id")
    swarm_id = request.args.get("swarm_id")

    data_dir = current_app.config["DATA_DIR"]
    folder = _scope_folder(scope, workspace_id, swarm_id, data_dir, "callers")
    if not folder:
        return _error("not_found", "Scope target not found", 404)
    path = os.path.join(folder, f"{name}.md")
    if not os.path.isfile(path):
        return _error("not_found", f"Caller {name!r} not found", 404)

    from app.core.registry import _hierarchy_cache
    referencing = []
    with get_session() as session:
        swarms = session.execute(select(Swarm)).scalars().all()
        for s in swarms:
            h = _hierarchy_cache.get(s.id)
            if not h:
                continue
            for c in getattr(h, "calls", []) or []:
                if c.get("caller") == name or c.get("caller") == f"{scope}/{name}":
                    referencing.append(s.name)
                    break
    if referencing:
        return _error(
            "still_referenced",
            f"Caller {name!r} is still referenced in swarm(s): {', '.join(referencing)}",
            409,
        )

    os.remove(path)
    with get_session() as session:
        row = session.execute(
            select(Caller).where(
                Caller.name == name,
                Caller.scope == scope,
                Caller.workspace_id == workspace_id,
                Caller.swarm_id == swarm_id,
            )
        ).scalar_one_or_none()
        if row:
            session.delete(row)
            session.commit()

    return jsonify({"ok": True}), 200


# ── Informer CRUD ─────────────────────────────────────────────────────────────

@bp.get("/informers")
def list_informers():
    scope = request.args.get("scope")
    workspace_id = request.args.get("workspace_id")
    swarm_id = request.args.get("swarm_id")

    with get_session() as session:
        stmt = select(Informer).order_by(Informer.scope, Informer.name)
        if scope:
            stmt = stmt.where(Informer.scope == scope)
        if workspace_id:
            stmt = stmt.where(Informer.workspace_id == workspace_id)
        if swarm_id:
            stmt = stmt.where(Informer.swarm_id == swarm_id)
        rows = session.execute(stmt).scalars().all()
        return jsonify([r.to_dict() for r in rows])


@bp.get("/informers/<name>")
def get_informer(name: str):
    scope = request.args.get("scope", "company")
    workspace_id = request.args.get("workspace_id")
    swarm_id = request.args.get("swarm_id")

    with get_session() as session:
        row = session.execute(
            select(Informer).where(
                Informer.name == name,
                Informer.scope == scope,
                Informer.workspace_id == workspace_id,
                Informer.swarm_id == swarm_id,
            )
        ).scalar_one_or_none()

    if not row:
        return _error("not_found", f"Informer {name!r} not found at scope {scope!r}", 404)

    body = ""
    fm = {}
    if os.path.isfile(row.md_path):
        try:
            post = frontmatter.load(row.md_path)
            body = post.content
            fm = post.metadata or {}
        except Exception as exc:
            logger.warning("Could not parse informer %s: %s", row.md_path, exc)

    return jsonify({
        **row.to_dict(),
        "body": body,
        "contacts": fm.get("contacts", []),
    })


@bp.post("/informers")
def create_informer():
    try:
        body = InformerWrite.model_validate(request.get_json(force=True) or {})
    except ValidationError as exc:
        return _error("validation_error", str(exc), 400)

    if not _NAME_RE.match(body.name):
        return _error(
            "validation_error",
            "Name must be lowercase letters, digits, and hyphens (start with letter/digit)",
            400,
        )

    data_dir = current_app.config["DATA_DIR"]
    folder = _scope_folder(body.scope, body.workspace_id, body.swarm_id, data_dir, "informers")
    if not folder:
        return _error("not_found", "Scope target not found", 404)

    path = os.path.join(folder, f"{body.name}.md")
    if os.path.isfile(path):
        return _error("conflict", f"Informer {body.name!r} already exists at this scope", 409)

    _write_informer_file(folder, body)
    from app.core.registry import _sync_informers
    from app.models.agent import SCOPE_COMPANY, SCOPE_WORKSPACE, SCOPE_SWARM
    scope_const = {"company": SCOPE_COMPANY, "workspace": SCOPE_WORKSPACE, "swarm": SCOPE_SWARM}[body.scope]
    _sync_informers(folder, scope_const, body.workspace_id, body.swarm_id)

    return get_informer(body.name)


@bp.put("/informers/<name>")
def update_informer(name: str):
    try:
        body = InformerWrite.model_validate(request.get_json(force=True) or {})
    except ValidationError as exc:
        return _error("validation_error", str(exc), 400)
    if body.name != name:
        return _error("validation_error", "Name in URL and body must match", 400)

    data_dir = current_app.config["DATA_DIR"]
    folder = _scope_folder(body.scope, body.workspace_id, body.swarm_id, data_dir, "informers")
    if not folder:
        return _error("not_found", "Scope target not found", 404)
    path = os.path.join(folder, f"{name}.md")
    if not os.path.isfile(path):
        return _error("not_found", f"Informer {name!r} not found", 404)

    _write_informer_file(folder, body)

    from app.core.registry import _sync_informers
    from app.models.agent import SCOPE_COMPANY, SCOPE_WORKSPACE, SCOPE_SWARM
    scope_const = {"company": SCOPE_COMPANY, "workspace": SCOPE_WORKSPACE, "swarm": SCOPE_SWARM}[body.scope]
    _sync_informers(folder, scope_const, body.workspace_id, body.swarm_id)

    return get_informer(name)


@bp.delete("/informers/<name>")
def delete_informer(name: str):
    scope = request.args.get("scope", "company")
    workspace_id = request.args.get("workspace_id")
    swarm_id = request.args.get("swarm_id")

    data_dir = current_app.config["DATA_DIR"]
    folder = _scope_folder(scope, workspace_id, swarm_id, data_dir, "informers")
    if not folder:
        return _error("not_found", "Scope target not found", 404)
    path = os.path.join(folder, f"{name}.md")
    if not os.path.isfile(path):
        return _error("not_found", f"Informer {name!r} not found", 404)

    from app.core.registry import _hierarchy_cache
    referencing = []
    with get_session() as session:
        swarms = session.execute(select(Swarm)).scalars().all()
        for s in swarms:
            h = _hierarchy_cache.get(s.id)
            if not h:
                continue
            for inf in getattr(h, "informs", []) or []:
                if inf.get("informer") == name or inf.get("informer") == f"{scope}/{name}":
                    referencing.append(s.name)
                    break
    if referencing:
        return _error(
            "still_referenced",
            f"Informer {name!r} is still referenced in swarm(s): {', '.join(referencing)}",
            409,
        )

    os.remove(path)
    with get_session() as session:
        row = session.execute(
            select(Informer).where(
                Informer.name == name,
                Informer.scope == scope,
                Informer.workspace_id == workspace_id,
                Informer.swarm_id == swarm_id,
            )
        ).scalar_one_or_none()
        if row:
            session.delete(row)
            session.commit()

    return jsonify({"ok": True}), 200


# ── Inbox (blocking calls — human_actions) ───────────────────────────────────

@bp.get("/inbox")
def list_inbox():
    """List human_actions (blocking calls), newest first."""
    status = request.args.get("status")
    caller_name = request.args.get("caller_name")
    swarm_id = request.args.get("swarm_id")
    run_id = request.args.get("run_id")
    try:
        limit = max(1, min(int(request.args.get("limit", "50")), 500))
        offset = max(0, int(request.args.get("offset", "0")))
    except ValueError:
        return _error("validation_error", "limit/offset must be integers", 400)

    with get_session() as session:
        stmt = select(HumanAction, Caller, Run).join(
            Caller, HumanAction.caller_id == Caller.id
        ).join(
            Run, HumanAction.run_id == Run.id
        ).order_by(desc(HumanAction.created_at)).limit(limit).offset(offset)

        if status:
            stmt = stmt.where(HumanAction.status == status)
        else:
            stmt = stmt.where(HumanAction.status == STATUS_PENDING)

        if caller_name:
            stmt = stmt.where(Caller.name == caller_name)
        if swarm_id:
            stmt = stmt.where(Run.swarm_id == swarm_id)
        if run_id:
            stmt = stmt.where(HumanAction.run_id == run_id)

        rows = session.execute(stmt).all()
        out = []
        for ha, caller, run in rows:
            d = ha.to_dict()
            d["caller_name"] = caller.name
            d["caller_display_name"] = caller.display_name
            d["swarm_id"] = run.swarm_id
            d["run_status"] = run.status
            out.append(d)
        return jsonify(out)


@bp.get("/inbox/<id>")
def get_inbox_item(id: str):
    with get_session() as session:
        row = session.get(HumanAction, id)
        if not row:
            return _error("not_found", f"Inbox item {id!r} not found", 404)
        caller = session.get(Caller, row.caller_id)
        run = session.get(Run, row.run_id)

    body = ""
    if caller and os.path.isfile(caller.md_path):
        try:
            post = frontmatter.load(caller.md_path)
            body = post.content
        except Exception:
            pass

    return jsonify({
        **row.to_dict(),
        "caller_name": caller.name if caller else None,
        "caller_display_name": caller.display_name if caller else None,
        "caller_briefing": body,
        "swarm_id": run.swarm_id if run else None,
        "run_status": run.status if run else None,
    })


def _resume_async(human_action_id: str, app) -> None:
    import threading

    def _worker():
        with app.app_context():
            try:
                runtime.resume_run(human_action_id)
            except Exception:
                logger.exception("Background resume_run failed for %s", human_action_id)

    threading.Thread(target=_worker, daemon=True).start()


def _notify_resolved(app, ha_id: str, status: str) -> None:
    try:
        bus = getattr(app, "sse_bus", None)
        if bus is not None:
            bus.broadcast("human_action.resolved", {
                "human_action_id": ha_id,
                "status": status,
            })
    except Exception:
        logger.warning("Could not broadcast human_action.resolved", exc_info=True)


@bp.post("/inbox/<id>/decide")
def decide_inbox_item(id: str):
    try:
        body = DecisionRequest.model_validate(request.get_json(force=True) or {})
    except ValidationError as exc:
        return _error("validation_error", str(exc), 400)

    with get_session() as session:
        row = session.get(HumanAction, id)
        if not row:
            return _error("not_found", f"Inbox item {id!r} not found", 404)
        if row.status != STATUS_PENDING:
            return _error("conflict", f"Item already {row.status}", 409)

        row.status = STATUS_YES if body.decision == "yes" else STATUS_NO
        row.decided_at = datetime.now(timezone.utc)
        row.decided_by = body.actor
        row.decision_reason = (body.reason or "").strip() or None
        if body.amend is not None:
            row.amend_json = json.dumps(body.amend)
        session.commit()
        final_status = row.status

    _notify_resolved(current_app._get_current_object(), id, final_status)
    _resume_async(id, current_app._get_current_object())

    return get_inbox_item(id)


# ── Informs (non-blocking — human_informs) ───────────────────────────────────

@bp.get("/informs")
def list_informs():
    """List human_informs (non-blocking notifications), newest first."""
    status = request.args.get("status")
    informer_name = request.args.get("informer_name")
    swarm_id = request.args.get("swarm_id")
    try:
        limit = max(1, min(int(request.args.get("limit", "50")), 500))
        offset = max(0, int(request.args.get("offset", "0")))
    except ValueError:
        return _error("validation_error", "limit/offset must be integers", 400)

    with get_session() as session:
        stmt = select(HumanInform, Informer, Run).join(
            Informer, HumanInform.informer_id == Informer.id
        ).join(
            Run, HumanInform.run_id == Run.id
        ).order_by(desc(HumanInform.created_at)).limit(limit).offset(offset)

        if status:
            stmt = stmt.where(HumanInform.status == status)
        else:
            stmt = stmt.where(HumanInform.status == STATUS_UNREAD)

        if informer_name:
            stmt = stmt.where(Informer.name == informer_name)
        if swarm_id:
            stmt = stmt.where(Run.swarm_id == swarm_id)

        rows = session.execute(stmt).all()
        out = []
        for hi, informer, run in rows:
            d = hi.to_dict()
            d["informer_name"] = informer.name
            d["informer_display_name"] = informer.display_name
            d["swarm_id"] = run.swarm_id
            d["run_status"] = run.status
            out.append(d)
        return jsonify(out)


@bp.get("/informs/<id>")
def get_inform_item(id: str):
    with get_session() as session:
        row = session.get(HumanInform, id)
        if not row:
            return _error("not_found", f"Inform item {id!r} not found", 404)
        informer = session.get(Informer, row.informer_id)
        run = session.get(Run, row.run_id)

    body = ""
    if informer and os.path.isfile(informer.md_path):
        try:
            post = frontmatter.load(informer.md_path)
            body = post.content
        except Exception:
            pass

    return jsonify({
        **row.to_dict(),
        "informer_name": informer.name if informer else None,
        "informer_display_name": informer.display_name if informer else None,
        "informer_briefing": body,
        "swarm_id": run.swarm_id if run else None,
        "run_status": run.status if run else None,
    })


def _notify_inform_ack(app, hi_id: str, status: str) -> None:
    try:
        bus = getattr(app, "sse_bus", None)
        if bus is not None:
            bus.broadcast("human_inform.acked", {
                "human_inform_id": hi_id,
                "status": status,
            })
    except Exception:
        logger.warning("Could not broadcast human_inform.acked", exc_info=True)


@bp.post("/informs/<id>/read")
def read_inform_item(id: str):
    try:
        body = AckRequest.model_validate(request.get_json(force=True) or {})
    except ValidationError as exc:
        return _error("validation_error", str(exc), 400)

    with get_session() as session:
        row = session.get(HumanInform, id)
        if not row:
            return _error("not_found", f"Inform item {id!r} not found", 404)
        if row.status != STATUS_UNREAD:
            return _error("conflict", f"Item already {row.status}", 409)
        row.status = STATUS_READ
        row.read_at = datetime.now(timezone.utc)
        row.read_by = body.actor
        session.commit()

    _notify_inform_ack(current_app._get_current_object(), id, STATUS_READ)
    return get_inform_item(id)


@bp.post("/informs/<id>/dismiss")
def dismiss_inform_item(id: str):
    try:
        body = AckRequest.model_validate(request.get_json(force=True) or {})
    except ValidationError as exc:
        return _error("validation_error", str(exc), 400)

    with get_session() as session:
        row = session.get(HumanInform, id)
        if not row:
            return _error("not_found", f"Inform item {id!r} not found", 404)
        if row.status == STATUS_DISMISSED:
            return _error("conflict", "Item already dismissed", 409)
        row.status = STATUS_DISMISSED
        row.read_at = datetime.now(timezone.utc)
        row.read_by = body.actor
        session.commit()

    _notify_inform_ack(current_app._get_current_object(), id, STATUS_DISMISSED)
    return get_inform_item(id)
