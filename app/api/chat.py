"""Phase 8 — Chat API.

Endpoints for managing chat sessions, messages, and unmet needs.
Run invocation happens via the existing runtime; the chat layer threads
runs together and provides history context.
"""
from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timezone, timedelta

from flask import Blueprint, g, jsonify, request, current_app
from pydantic import BaseModel
from sqlalchemy import select, delete

from app.core.auth import require_permission, current_user
from app.db import get_session
from app.models.chat_session import ChatSession, SCOPE_ORG, SCOPE_WORKSPACE
from app.models.chat_message import ChatMessage, ROLE_USER, ROLE_ASSISTANT, ROLE_SYSTEM
from app.models.unmet_need import UnmetNeed, STATUS_OPEN, STATUS_DISMISSED, STATUS_ADDRESSED
from app.models.workspace import Workspace
from app.models.swarm import Swarm

logger = logging.getLogger(__name__)
bp = Blueprint("chat", __name__, url_prefix="/api/v1")

_CONTEXT_TOKEN_BUDGET = 32_000
_APPROX_CHARS_PER_TOKEN = 4


# ── Input schemas ─────────────────────────────────────────────────────────────

class SessionCreate(BaseModel):
    scope: str
    workspace_id: str | None = None
    title: str | None = None
    # When true, always start a fresh conversation instead of resuming the most
    # recent one for this scope (the "New chat" button).
    new: bool = False


class MessageCreate(BaseModel):
    content: str


class NeedPatch(BaseModel):
    status: str
    addressed_by_run_id: str | None = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _check_chat_permission(scope: str, workspace_id: str | None = None) -> tuple[bool, str]:
    """Return (allowed, error_message)."""
    user = current_user()
    if user is None:
        return False, "Login required"
    if scope == SCOPE_ORG:
        if not user.has_permission("can_chat_operator"):
            return False, "Operator chat requires can_chat_operator permission"
    else:
        if not user.has_permission("can_chat_workspace"):
            return False, "Workspace chat requires can_chat_workspace permission"
    return True, ""


def _default_title(scope: str) -> str:
    return "Operator" if scope == SCOPE_ORG else "Concierge"


def _create_session(user_id: str, scope: str, workspace_id: str | None, title: str | None = None) -> ChatSession:
    with get_session() as session:
        new = ChatSession(
            user_id=user_id,
            scope=scope,
            workspace_id=workspace_id,
            title=title or _default_title(scope),
        )
        session.add(new)
        session.commit()
        session.refresh(new)
        session.expunge(new)
        return new


def _get_or_create_session(user_id: str, scope: str, workspace_id: str | None, title: str | None = None) -> ChatSession:
    """Resume the user's most recent conversation for this scope, or start one."""
    with get_session() as session:
        existing = session.execute(
            select(ChatSession)
            .where(
                ChatSession.user_id == user_id,
                ChatSession.scope == scope,
                ChatSession.workspace_id == workspace_id,
            )
            .order_by(ChatSession.updated_at.desc())
            .limit(1)
        ).scalar_one_or_none()
        if existing:
            session.expunge(existing)
            return existing
    return _create_session(user_id, scope, workspace_id, title)


def _resolve_chat_swarm(scope: str, workspace_id: str | None) -> Swarm | None:
    """Find the chat swarm for this scope."""
    swarm_name = "operator-chat" if scope == SCOPE_ORG else "concierge"
    with get_session() as session:
        if scope == SCOPE_ORG:
            ws = session.execute(
                select(Workspace).where(Workspace.name == "platform")
            ).scalar_one_or_none()
        else:
            ws = session.execute(
                select(Workspace).where(Workspace.id == workspace_id)
            ).scalar_one_or_none()
        if not ws:
            return None
        swarm = session.execute(
            select(Swarm).where(Swarm.workspace_id == ws.id, Swarm.name == swarm_name)
        ).scalar_one_or_none()
        if swarm:
            session.expunge(swarm)
        return swarm


def _resolve_chat_model_info(scope: str, workspace_id: str | None) -> dict:
    """Return {'provider': ..., 'model': ...} for the entry agent of the chat swarm."""
    import os as _os, json as _json
    import frontmatter as _fm
    from flask import current_app
    from app.core.secrets import resolve_default_provider, resolve_default_model

    try:
        swarm_name = "operator-chat" if scope == SCOPE_ORG else "concierge"
        with get_session() as session:
            if scope == SCOPE_ORG:
                ws = session.execute(
                    select(Workspace).where(Workspace.name == "platform")
                ).scalar_one_or_none()
            else:
                ws = session.execute(
                    select(Workspace).where(Workspace.id == workspace_id)
                ).scalar_one_or_none()
            ws_name = ws.name if ws else None

        provider = None
        model = None
        if ws_name:
            data_dir = current_app.config.get("DATA_DIR", "/data")
            swarm_path = _os.path.join(data_dir, "workspaces", ws_name, "swarms", swarm_name)
            hierarchy_path = _os.path.join(swarm_path, "hierarchy.json")
            entry_point = None
            if _os.path.exists(hierarchy_path):
                with open(hierarchy_path) as f:
                    entry_point = _json.load(f).get("entry_point")
            if entry_point:
                agent_path = _os.path.join(swarm_path, "agents", f"{entry_point}.md")
                if _os.path.exists(agent_path):
                    post = _fm.load(agent_path)
                    provider = post.get("provider") or None
                    model = post.get("model") or None

        return {
            "provider": provider or resolve_default_provider(),
            "model": model or resolve_default_model() or "default",
        }
    except Exception:
        logger.debug("Could not resolve chat model info", exc_info=True)
        return {"provider": "unknown", "model": "unknown"}


def _build_context_messages(session_id: int) -> list[dict]:
    """Return recent messages trimmed to the token budget."""
    with get_session() as session:
        rows = session.execute(
            select(ChatMessage)
            .where(ChatMessage.session_id == session_id)
            .order_by(ChatMessage.created_at.desc())
            .limit(200)
        ).scalars().all()

    rows = list(reversed(rows))
    budget = _CONTEXT_TOKEN_BUDGET * _APPROX_CHARS_PER_TOKEN
    kept: list[dict] = []
    total = 0
    for msg in reversed(rows):
        chars = len(msg.content)
        if total + chars > budget and kept:
            break
        kept.insert(0, {"role": msg.role, "content": msg.content})
        total += chars
    return kept


def _persist_message(
    session_id: int,
    role: str,
    content: str,
    run_id: str | None = None,
    attachments: list[dict] | None = None,
) -> ChatMessage:
    with get_session() as session:
        msg = ChatMessage(
            session_id=session_id,
            role=role,
            content=content,
            run_id=run_id,
            attachments=json.dumps(attachments) if attachments else None,
        )
        session.add(msg)
        session.commit()
        session.refresh(msg)
        session.expunge(msg)
    return msg


def _derive_title(text: str, limit: int = 48) -> str:
    """Turn a user's first message into a short conversation title."""
    title = " ".join((text or "").split())  # collapse whitespace/newlines
    if len(title) > limit:
        title = title[:limit].rstrip() + "…"
    return title or "New conversation"


def _touch_session(session_id: int, current_title: str, first_message: str) -> None:
    """Bump updated_at, and name the session from its first message if still default."""
    from app.models.chat_session import DEFAULT_TITLES

    with get_session() as session:
        chat_session = session.get(ChatSession, session_id)
        if not chat_session:
            return
        if current_title in DEFAULT_TITLES:
            chat_session.title = _derive_title(first_message)
        chat_session.updated_at = datetime.now(timezone.utc)
        session.commit()


# Skills whose successful calls mean "the agent surfaced this file to the user".
_ATTACHMENT_SKILLS = ("attach_file", "read_swarm_artifact")
_MAX_ATTACHMENTS = 10


def _extract_run_attachments(run_id: str) -> list[dict]:
    """Collect file refs the agent surfaced during a run.

    Scans skill_call steps for `attach_file` (explicit) and `read_swarm_artifact`
    (implicit — the agent read a file to answer). Each becomes an attachment
    descriptor the chat panel can preview/download. Deduped by (swarm_id, path),
    capped, and silently best-effort — attachment extraction must never break a
    chat reply.
    """
    import mimetypes
    from app.models.run_step import RunStep, STEP_SKILL_CALL

    attachments: list[dict] = []
    seen: set[tuple[str, str]] = set()
    try:
        with get_session() as db:
            steps = db.execute(
                select(RunStep)
                .where(
                    RunStep.run_id == run_id,
                    RunStep.step_type == STEP_SKILL_CALL,
                    RunStep.step_name.in_(_ATTACHMENT_SKILLS),
                    RunStep.error.is_(None),
                )
                .order_by(RunStep.sequence.asc())
            ).scalars().all()

        for step in steps:
            try:
                inp = json.loads(step.input_json or "{}")
                out = json.loads(step.output_json or "{}") if step.output_json else {}
            except Exception:
                continue
            if not isinstance(out, dict) or out.get("ok") is False:
                continue  # skill errored / returned a structured failure

            path = inp.get("path")
            swarm_ident = inp.get("swarm")
            if not path or not swarm_ident:
                continue

            # attach_file echoes the canonical swarm_id; read_swarm_artifact does
            # not, so resolve the identifier the agent passed to a swarm row.
            swarm_id = out.get("swarm_id") or _resolve_swarm_id(swarm_ident)
            if not swarm_id:
                continue

            key = (swarm_id, path)
            if key in seen:
                continue
            seen.add(key)

            filename = out.get("filename") or path.rsplit("/", 1)[-1]
            mime = out.get("mime") or mimetypes.guess_type(filename)[0] or "application/octet-stream"
            attachments.append({
                "swarm_id": swarm_id,
                "path": path,
                "filename": filename,
                "size_bytes": out.get("size_bytes"),
                "mime": mime,
            })
            if len(attachments) >= _MAX_ATTACHMENTS:
                break
    except Exception:
        logger.debug("Could not extract attachments for run %s", run_id, exc_info=True)
    return attachments


def _resolve_swarm_id(ident: str) -> str | None:
    """Resolve a swarm name / id / id-prefix to its canonical id."""
    with get_session() as db:
        row = db.execute(
            select(Swarm.id).where((Swarm.id == ident) | (Swarm.name == ident))
        ).scalar_one_or_none()
        if row:
            return row
        row = db.execute(
            select(Swarm.id).where(Swarm.id.like(f"{ident}%"))
        ).scalar_one_or_none()
        return row


def _fire_run_async(swarm: Swarm, input_payload: dict, session_id: int, user_message_id: int, app) -> None:
    """Start a swarm run in a background thread and save the result as an assistant message."""
    def _worker():
        with app.app_context():
            try:
                from app.core.runtime import start_run
                from app.models.event import Event
                from app.models.workspace import Workspace as _Workspace
                import os as _os

                data_dir: str = app.config.get("DATA_DIR", "/data")

                # Resolve workspace and swarm paths
                with get_session() as db:
                    ws = db.get(_Workspace, swarm.workspace_id)
                    workspace_name = ws.name if ws else None

                if not workspace_name:
                    raise RuntimeError(f"Workspace not found for swarm {swarm.id}")

                workspace_path = _os.path.join(data_dir, "workspaces", workspace_name)
                swarm_path     = _os.path.join(workspace_path, "swarms", swarm.name)

                # Create a synthetic event for the chat trigger
                with get_session() as db:
                    event = Event(
                        swarm_id=swarm.id,
                        source="chat",
                        payload_json=json.dumps(input_payload),
                    )
                    db.add(event)
                    db.commit()
                    db.refresh(event)
                    event_id = event.id

                run = start_run(
                    event_id=event_id,
                    swarm_id=swarm.id,
                    swarm_path=swarm_path,
                    workspace_path=workspace_path,
                    data_dir=data_dir,
                    payload=input_payload,
                    trigger_kind="chat",
                )

                run_id = run.id if run else None

                # Extract assistant reply + any files the agent surfaced
                content = _extract_run_output(run_id) if run_id else "Run completed."
                attachments = _extract_run_attachments(run_id) if run_id else []
                _persist_message(session_id, ROLE_ASSISTANT, content, run_id=run_id, attachments=attachments)

                # Notify via SSE
                from app.core.runtime import _notify
                _notify("chat.complete", {
                    "session_id": session_id,
                    "run_id": run_id,
                    "summary": content[:200],
                })

            except Exception:
                logger.exception("Chat run failed for session %s", session_id)
                _persist_message(session_id, ROLE_SYSTEM, "The assistant encountered an error processing your request.")
                # Still send SSE so the panel unfreezes
                try:
                    from app.core.runtime import _notify
                    _notify("chat.complete", {"session_id": session_id, "run_id": None, "summary": ""})
                except Exception:
                    pass

    thread = threading.Thread(target=_worker, daemon=True)
    thread.start()


def _extract_run_output(run_id: str) -> str:
    """Pull the agent's final reply from the run, with graceful fallbacks."""
    from app.models.run import Run, STATUS_FAILED
    from app.models.run_step import RunStep, STEP_AGENT_CALL

    def _parse_output(output_json: str) -> str | None:
        if not output_json:
            return None
        try:
            data = json.loads(output_json)
        except Exception:
            return str(output_json)
        if isinstance(data, str):
            return data
        if isinstance(data, dict):
            for key in ("message", "response", "text", "content", "result", "summary", "output"):
                val = data.get(key)
                if val and isinstance(val, str):
                    return val
            # No known text key — render the whole dict as formatted JSON
            return json.dumps(data, indent=2)
        return None

    with get_session() as db:
        run = db.get(Run, run_id)
        if not run:
            return "Run not found."

        # Strategy 1: entry-point agent step (sequence=1, type=agent_call)
        agent_step = db.execute(
            select(RunStep)
            .where(RunStep.run_id == run_id, RunStep.step_type == STEP_AGENT_CALL)
            .order_by(RunStep.sequence.asc())
            .limit(1)
        ).scalar_one_or_none()

        if agent_step:
            text = _parse_output(agent_step.output_json)
            if text:
                return text

        # Strategy 2: any step with output, latest first
        any_step = db.execute(
            select(RunStep)
            .where(RunStep.run_id == run_id, RunStep.output_json.isnot(None))
            .order_by(RunStep.sequence.desc())
            .limit(1)
        ).scalar_one_or_none()

        if any_step:
            text = _parse_output(any_step.output_json)
            if text:
                return text

        # Strategy 3: surface the run error if it failed
        if run.status == STATUS_FAILED and run.error:
            return f"The run encountered an error: {run.error}"

    return "Run completed."


# ── Routes ────────────────────────────────────────────────────────────────────

@bp.post("/chat/sessions")
def create_or_get_session():
    try:
        body = SessionCreate.model_validate(request.get_json(force=True) or {})
    except Exception as exc:
        return jsonify({"error": {"code": "validation_error", "message": str(exc)}}), 400

    allowed, msg = _check_chat_permission(body.scope, body.workspace_id)
    if not allowed:
        return jsonify({"error": {"code": "forbidden", "message": msg}}), 403

    user = current_user()
    if body.new:
        chat_session = _create_session(user.id, body.scope, body.workspace_id, body.title)
    else:
        chat_session = _get_or_create_session(user.id, body.scope, body.workspace_id, body.title)
    result = chat_session.to_dict()
    result["model_info"] = _resolve_chat_model_info(body.scope, body.workspace_id)
    swarm = _resolve_chat_swarm(body.scope, body.workspace_id)
    result["swarm_id"] = swarm.id if swarm else None
    return jsonify(result), 200


@bp.get("/chat/sessions")
def list_sessions():
    scope = request.args.get("scope")
    workspace_id = request.args.get("workspace_id")

    user = current_user()
    if not user:
        return jsonify({"error": {"code": "unauthorized", "message": "Login required"}}), 401

    with get_session() as session:
        q = select(ChatSession).where(ChatSession.user_id == user.id)
        if scope:
            q = q.where(ChatSession.scope == scope)
        if workspace_id:
            q = q.where(ChatSession.workspace_id == workspace_id)
        sessions = session.execute(q.order_by(ChatSession.updated_at.desc())).scalars().all()

        # Enrich each session with a message count + last-activity time for the
        # history drawer, in one grouped query rather than N.
        from sqlalchemy import func as _func
        counts = dict(session.execute(
            select(ChatMessage.session_id, _func.count(ChatMessage.id))
            .where(ChatMessage.session_id.in_([s.id for s in sessions] or [0]))
            .group_by(ChatMessage.session_id)
        ).all())

        out = []
        for s in sessions:
            d = s.to_dict()
            d["message_count"] = counts.get(s.id, 0)
            out.append(d)
        return jsonify(out)


@bp.get("/chat/sessions/<int:session_id>/messages")
def list_messages(session_id: int):
    user = current_user()
    with get_session() as session:
        chat_session = session.get(ChatSession, session_id)
        if not chat_session or chat_session.user_id != user.id:
            return jsonify({"error": {"code": "not_found", "message": "Session not found"}}), 404

        before_id = request.args.get("before_id", type=int)
        limit = min(int(request.args.get("limit", 50)), 200)
        q = select(ChatMessage).where(ChatMessage.session_id == session_id)
        if before_id:
            q = q.where(ChatMessage.id < before_id)
        q = q.order_by(ChatMessage.created_at.asc()).limit(limit)
        messages = session.execute(q).scalars().all()
        return jsonify([m.to_dict() for m in messages])


@bp.post("/chat/sessions/<int:session_id>/messages")
def send_message(session_id: int):
    try:
        body = MessageCreate.model_validate(request.get_json(force=True) or {})
    except Exception as exc:
        return jsonify({"error": {"code": "validation_error", "message": str(exc)}}), 400

    user = current_user()
    with get_session() as session:
        chat_session = session.get(ChatSession, session_id)
        if not chat_session or chat_session.user_id != user.id:
            return jsonify({"error": {"code": "not_found", "message": "Session not found"}}), 404
        scope = chat_session.scope
        workspace_id = chat_session.workspace_id
        title = chat_session.title
        session.expunge(chat_session)

    allowed, msg = _check_chat_permission(scope, workspace_id)
    if not allowed:
        return jsonify({"error": {"code": "forbidden", "message": msg}}), 403

    swarm = _resolve_chat_swarm(scope, workspace_id)
    if not swarm:
        return jsonify({"error": {"code": "not_found", "message": "Chat swarm not available for this context"}}), 404

    # Build context BEFORE persisting so the current message isn't duplicated
    context_messages = _build_context_messages(session_id)

    # Persist user message
    user_msg = _persist_message(session_id, ROLE_USER, body.content)

    # Title a still-unnamed conversation from its first message, and mark it the
    # most recently active so the history drawer orders it first.
    _touch_session(session_id, title, body.content)
    input_payload = {
        "message": body.content,
        "conversation_history": context_messages,
        "session_id": session_id,
        "user_id": user.id,
        "workspace_id": workspace_id,
    }

    # Fire run asynchronously
    _fire_run_async(swarm, input_payload, session_id, user_msg.id, current_app._get_current_object())

    return jsonify({"message_id": user_msg.id}), 202


@bp.delete("/chat/sessions/<int:session_id>/messages")
def wipe_messages(session_id: int):
    user = current_user()
    with get_session() as session:
        chat_session = session.get(ChatSession, session_id)
        if not chat_session or chat_session.user_id != user.id:
            return jsonify({"error": {"code": "not_found", "message": "Session not found"}}), 404
        result = session.execute(
            delete(ChatMessage).where(ChatMessage.session_id == session_id)
        )
        session.commit()
    return jsonify({"deleted": result.rowcount})


@bp.delete("/chat/sessions/<int:session_id>")
def delete_session(session_id: int):
    user = current_user()
    with get_session() as session:
        chat_session = session.get(ChatSession, session_id)
        if not chat_session or chat_session.user_id != user.id:
            return jsonify({"error": {"code": "not_found", "message": "Session not found"}}), 404
        session.execute(delete(ChatMessage).where(ChatMessage.session_id == session_id))
        session.delete(chat_session)
        session.commit()
    return jsonify({"deleted": True})


# ── Unmet needs ───────────────────────────────────────────────────────────────

@bp.get("/unmet-needs")
@require_permission("can_chat_operator")
def list_unmet_needs():
    workspace_id = request.args.get("workspace_id")
    status = request.args.get("status", STATUS_OPEN)
    with get_session() as session:
        q = select(UnmetNeed).where(UnmetNeed.status == status)
        if workspace_id:
            q = q.where(UnmetNeed.workspace_id == workspace_id)
        needs = session.execute(q.order_by(UnmetNeed.created_at.desc())).scalars().all()
        return jsonify([n.to_dict() for n in needs])


@bp.patch("/unmet-needs/<int:need_id>")
@require_permission("can_chat_operator")
def patch_unmet_need(need_id: int):
    try:
        body = NeedPatch.model_validate(request.get_json(force=True) or {})
    except Exception as exc:
        return jsonify({"error": {"code": "validation_error", "message": str(exc)}}), 400

    if body.status not in (STATUS_OPEN, STATUS_DISMISSED, STATUS_ADDRESSED):
        return jsonify({"error": {"code": "validation_error", "message": "Invalid status"}}), 400

    with get_session() as session:
        need = session.get(UnmetNeed, need_id)
        if not need:
            return jsonify({"error": {"code": "not_found", "message": "Need not found"}}), 404
        need.status = body.status
        if body.addressed_by_run_id:
            need.addressed_by_run_id = body.addressed_by_run_id
        session.commit()
        session.refresh(need)
        return jsonify(need.to_dict())
