from __future__ import annotations

import ast
import json
import logging
import os
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import frontmatter
from sqlalchemy import select

from app.core.hierarchy import ParsedHierarchy
from app.core.secrets import get_llm_credentials
from app.core.registry import get_hierarchy
from app.core.resolver import resolve, ResolverError
from app.core.file_store import upsert_file, remove_file, ORIGIN_AGENT
from app.core.skill_runner import (
    run_skill,
    load_skill_config,
    validate_skill_input,
    validate_skill_output,
    SkillError,
    SkillValidationError,
)
from app.db import get_session
from app.models.agent import Agent
from app.models.settings import Setting
from app.models.caller import Caller
from app.models.human_action import (
    HumanAction,
    STATUS_PENDING as HA_STATUS_PENDING,
    STATUS_YES as HA_STATUS_YES,
    STATUS_NO as HA_STATUS_NO,
)
from app.models.informer import Informer
from app.models.human_inform import HumanInform, STATUS_UNREAD as HI_STATUS_UNREAD
from app.models.run import (
    Run,
    STATUS_RUNNING,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_AWAITING_HUMAN,
)
from app.models.run_step import (
    RunStep,
    STEP_AGENT_CALL,
    STEP_SKILL_CALL,
    STEP_PERCEPTIONIST_CALL,
    STEP_HUMAN_ESCALATION,
    STEP_CALLER_CALL,
    STEP_INFORMER_NOTIFY,
    STEP_SWARM_CALL,
    STEP_TOPOLOGY_VIOLATION,
)

logger = logging.getLogger(__name__)

# Guards against infinite loops within a single run
MAX_AGENT_TURNS = 20   # default; overridden by runtime.max_agent_turns setting
MAX_DEPTH = 20         # max recursive call depth (agent → agent → …)


def _get_max_agent_turns() -> int:
    try:
        with get_session() as session:
            row = session.get(Setting, "runtime.max_agent_turns")
            if row is not None:
                import json as _json
                val = _json.loads(row.value_encrypted)
                if isinstance(val, int) and val > 0:
                    return val
    except Exception:
        pass
    return MAX_AGENT_TURNS


def _get_default_skill_timeout() -> int:
    try:
        with get_session() as session:
            row = session.get(Setting, "system.default_skill_timeout_seconds")
            if row is not None:
                import json as _json
                val = _json.loads(row.value_encrypted)
                if isinstance(val, int) and val > 0:
                    return val
    except Exception:
        pass
    return 30

# Optional SSE broadcast hook — set by app/__init__.py
_notify_fn = None

# Run-IDs that have been requested to stop (checked inside _execute_agent_call)
_cancelled_runs: set[str] = set()
_cancelled_lock = threading.Lock()


def cancel_run(run_id: str) -> None:
    """Signal a running run to stop at its next agent turn."""
    with _cancelled_lock:
        _cancelled_runs.add(run_id)


def _is_cancelled(run_id: str) -> bool:
    with _cancelled_lock:
        return run_id in _cancelled_runs


def _clear_cancelled(run_id: str) -> None:
    with _cancelled_lock:
        _cancelled_runs.discard(run_id)


class RunCancelled(Exception):
    pass


def set_notify_fn(fn) -> None:
    global _notify_fn
    _notify_fn = fn


def _notify(event_type: str, data: dict) -> None:
    if _notify_fn is not None:
        try:
            _notify_fn(event_type, data)
        except Exception:
            logger.warning("SSE notify raised an exception", exc_info=True)


def _notify_chat_step(ctx: "RunContext", phase: str, label: str, purpose: str | None = None) -> None:
    """Broadcast a live progress step to the chat panel for this run's session.

    No-op when the run isn't a chat session. `phase` is one of
    skill | agent | perceptionist | swarm and drives the panel's chip label.
    """
    if not ctx.chat_session_id:
        return
    _notify("chat.step", {
        "session_id": ctx.chat_session_id,
        "phase": phase,
        "label": label,
        "purpose": purpose,
    })


def _output_snippet(output: object, max_len: int = 140) -> str | None:
    """Extract a short human-readable string from a step output dict."""
    if not isinstance(output, dict):
        return str(output)[:max_len] if output else None
    for key in ("message", "reason", "text", "content", "result", "summary"):
        val = output.get(key)
        if val and isinstance(val, str):
            return val[:max_len] + ("…" if len(val) > max_len else "")
    # Fallback: compact JSON of the whole dict
    try:
        s = json.dumps(output, ensure_ascii=False)
        return s[:max_len] + ("…" if len(s) > max_len else "")
    except Exception:
        return None

_RESPONSE_FORMAT_BASE = """
When you respond, output ONLY a JSON object — no prose before or after — with this structure:

{{
  "action": "<one of: {actions}>",
  "target": "<name of agent, perceptionist, skill, or caller being called — omit for complete/escalate_to_human>",
  "purpose_match": "<optional: echo the declared purpose from Allowed Actions — used only for the audit trail>",
  "input": {{ <data to pass to the target, or your final output for complete> }},
  "reasoning": "<free-text explanation of why you are taking this action>"
}}

Rules:
- "action" MUST be one of the listed values. Using any other string (including skill names) causes a topology violation.
- To call a skill, set "action" to "skill_call" and "target" to the skill name. NEVER use a skill name as the "action" value.
- `purpose_match` is optional — include it to label the audit trail, but the call is authorized by the target being declared in Allowed Actions, not by this field.
- Use `complete` to return your final answer to the user when you are done. Put the response in "input".
- Never invent a target name — only use names that appear in Allowed Actions below.
"""


def _build_response_format(
    has_escalations: bool,
    has_delegations: bool,
    has_reports: bool,
    has_consultations: bool,
    has_skills: bool,
    has_calls: bool,
    has_informs: bool,
    has_swarm_calls: bool,
) -> str:
    actions = []
    if has_escalations:  actions.append("escalate")
    if has_delegations:  actions.append("delegate")
    if has_reports:      actions.append("report")
    if has_consultations: actions.append("consult_perceptionist")
    if has_calls:        actions.append("consult_caller")
    if has_informs:      actions.append("inform_informer")
    if has_skills:       actions.append("skill_call")
    if has_swarm_calls:  actions.append("invoke_swarm")
    actions += ["escalate_to_human", "complete"]
    return _RESPONSE_FORMAT_BASE.format(actions=" | ".join(actions))


# ── Public exceptions ─────────────────────────────────────────────────────────

class SwarmRuntimeError(Exception):
    """Base class for swarm runtime errors."""


class TopologyViolationError(SwarmRuntimeError):
    """Raised when an agent attempts an action not declared in hierarchy.json."""


class RunDepthError(SwarmRuntimeError):
    """Raised when the maximum recursive call depth is exceeded."""


class MaxTurnsError(SwarmRuntimeError):
    """Raised when an agent exceeds the maximum number of LLM turns."""


class RunSuspended(Exception):
    """Raised internally when a run hits a `call` edge and must wait for a human.

    Carries the `human_action_id` so `start_run` can move the run into
    `awaiting_human` status without treating the suspend as a failure. Not
    surfaced to API callers — runs.status is the visible signal.
    """
    def __init__(self, human_action_id: str):
        super().__init__(f"Run suspended awaiting human action {human_action_id}")
        self.human_action_id = human_action_id


# ── Run context ───────────────────────────────────────────────────────────────

@dataclass
class RunContext:
    """Shared mutable state passed through the recursive execution of a run."""

    run_id: str
    swarm_id: str
    swarm_path: str
    workspace_path: str
    data_dir: str
    hierarchy: ParsedHierarchy
    chat_session_id: str | None = field(default=None)

    _sequence: int = field(default=0, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _next_seq_fn: Any = field(default=None, repr=False)

    def next_sequence(self) -> int:
        if self._next_seq_fn is not None:
            return self._next_seq_fn()
        with self._lock:
            self._sequence += 1
            return self._sequence

    def spawn_child(
        self,
        swarm_id: str,
        swarm_path: str,
        workspace_path: str,
        hierarchy: ParsedHierarchy,
    ) -> "RunContext":
        """Create a child context sharing this run's ID and sequence counter."""
        child = RunContext(
            run_id=self.run_id,
            swarm_id=swarm_id,
            swarm_path=swarm_path,
            workspace_path=workspace_path,
            data_dir=self.data_dir,
            hierarchy=hierarchy,
            chat_session_id=self.chat_session_id,
        )
        child._next_seq_fn = self.next_sequence
        return child


# ── Public API ────────────────────────────────────────────────────────────────


def _build_initial_messages(payload: dict) -> list[dict]:
    """Convert a run payload into LLM message turns.

    Chat payloads (those with a 'conversation_history' list and a 'message'
    string) are expanded so each prior exchange becomes a real user/assistant
    turn.  This lets the LLM see the conversation naturally instead of as a
    nested JSON blob, which prevents it from anchoring on error strings in the
    history and repeating the same broken action.

    Non-chat payloads (no conversation_history) are serialised as before.
    """
    history = payload.get("conversation_history")
    current = payload.get("message")
    if not isinstance(history, list) or not isinstance(current, str):
        return [{"role": "user", "content": json.dumps(payload)}]

    meta = {k: v for k, v in payload.items() if k not in ("conversation_history", "message")}
    meta_note = (
        f"[context: session_id={meta.get('session_id')}, workspace_id={meta.get('workspace_id')}]\n\n"
        if meta else ""
    )

    messages: list[dict] = []
    for msg in history:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if not (role in ("user", "assistant") and content):
            continue
        # The chat layer stores the extracted plain-text reply as the assistant
        # message.  If we pass that raw back to the LLM it sees plain text in
        # the history and ignores the JSON-only format instruction.  Re-wrap any
        # non-JSON assistant turn so the model sees consistent JSON throughout.
        if role == "assistant":
            try:
                json.loads(content)
            except (json.JSONDecodeError, ValueError):
                content = json.dumps({"action": "complete", "input": {"message": content}})
        messages.append({"role": role, "content": content})

    messages.append({"role": "user", "content": meta_note + current})
    return messages


def start_run(
    event_id: str,
    swarm_id: str,
    swarm_path: str,
    workspace_path: str,
    data_dir: str,
    payload: dict,
    *,
    entry_point_override: str | None = None,
    trigger_kind: str | None = None,
) -> Run:
    """Create a Run for the given event and execute the swarm's entry-point agent.

    Args:
        event_id:       ID of the triggering Event.
        swarm_id:       ID of the Swarm row in the database.
        swarm_path:     Absolute path to the swarm folder on disk.
        workspace_path: Absolute path to the workspace folder on disk.
        data_dir:       Absolute path to the data/ root directory.
        payload:        The event payload (passed as the first user message).

    Returns:
        The completed or failed Run object.

    Raises:
        RuntimeError: If the swarm hierarchy is not cached or has no entry_point.
    """
    hierarchy = get_hierarchy(swarm_id)
    if hierarchy is None:
        raise SwarmRuntimeError(
            f"Swarm {swarm_id!r} hierarchy not found in cache — is the swarm enabled?"
        )

    # Phase 6.1: a trigger can override the swarm's default entry_point so
    # different triggers can fire into different agents in the same swarm.
    # The override must still resolve to a declared agent.
    effective_entry = entry_point_override or hierarchy.entry_point
    if not effective_entry:
        raise SwarmRuntimeError(
            f"Swarm {swarm_id!r} has no entry_point and no override was provided"
        )
    if effective_entry not in hierarchy.agents:
        raise SwarmRuntimeError(
            f"Entry point {effective_entry!r} is not in the agents list of swarm {swarm_id!r}"
        )

    with get_session() as session:
        run = Run(
            event_id=event_id,
            swarm_id=swarm_id,
            status=STATUS_RUNNING,
            started_at=datetime.now(timezone.utc),
            trigger_kind=trigger_kind,
        )
        session.add(run)
        session.commit()
        session.refresh(run)
        run_id = run.id

    _notify("run.started", {"run_id": run_id, "swarm_id": swarm_id, "event_id": event_id})

    chat_session_id = None
    if trigger_kind == "chat" and isinstance(payload, dict):
        sid = payload.get("session_id")
        if sid is not None:
            chat_session_id = str(sid)

    ctx = RunContext(
        run_id=run_id,
        swarm_id=swarm_id,
        swarm_path=swarm_path,
        workspace_path=workspace_path,
        data_dir=data_dir,
        hierarchy=hierarchy,
        chat_session_id=chat_session_id,
    )

    try:
        initial_messages = _build_initial_messages(payload)
        _execute_agent_call(
            agent_name=effective_entry,
            messages=initial_messages,
            ctx=ctx,
            depth=0,
            edge_purpose=None,
            step_type=STEP_AGENT_CALL,
        )
        _finish_run(run_id, STATUS_COMPLETED)
        _notify("run.completed", {"run_id": run_id, "swarm_id": swarm_id, "status": "completed"})
        logger.info("Run %s completed successfully", run_id)

    except RunCancelled:
        logger.info("Run %s stopped by user", run_id)
        _finish_run(run_id, STATUS_FAILED, error="Stopped by user")
        _notify("run.failed", {"run_id": run_id, "swarm_id": swarm_id, "status": "failed", "error": "Stopped by user"})

    except RunSuspended as exc:
        # The run hit a `call` edge. Move it into awaiting_human (do NOT
        # mark it failed — it's pending, not broken).
        _finish_run(run_id, STATUS_AWAITING_HUMAN)
        _notify("run.awaiting_human", {
            "run_id": run_id,
            "swarm_id": swarm_id,
            "human_action_id": exc.human_action_id,
        })
        logger.info("Run %s suspended awaiting human action %s", run_id, exc.human_action_id)

    except Exception as exc:
        logger.exception("Run %s failed: %s", run_id, exc)
        _finish_run(run_id, STATUS_FAILED, error=str(exc))
        _notify("run.failed", {"run_id": run_id, "swarm_id": swarm_id, "status": "failed", "error": str(exc)})

    _clear_cancelled(run_id)

    with get_session() as session:
        return session.get(Run, run_id)


# ── Resume a suspended run after a human decision (Phase 6) ──────────────────

def resume_run(human_action_id: str) -> Run | None:
    """Resume a paused run after the inbox API has written a decision.

    The HumanAction row must already have status == approved or rejected and
    a decision_payload_json populated. The runtime loads the saved snapshot,
    appends the decision payload to the conversation as the call's result,
    re-enters the agent loop, and either completes the run, suspends again
    (on a chained call), or fails.

    Returns the Run, or None if the action / run cannot be loaded.
    """
    with get_session() as session:
        ha = session.get(HumanAction, human_action_id)
        if ha is None:
            logger.warning("resume_run: human_action %s not found", human_action_id)
            return None
        if ha.status not in (HA_STATUS_YES, HA_STATUS_NO):
            logger.warning(
                "resume_run: human_action %s status=%s, not resumable",
                human_action_id, ha.status,
            )
            return None
        run = session.get(Run, ha.run_id)
        if run is None or run.status != STATUS_AWAITING_HUMAN:
            logger.warning(
                "resume_run: run %s status=%s, expected awaiting_human",
                ha.run_id, run.status if run else "(missing)",
            )
            return None

        snapshot = json.loads(ha.runtime_snapshot_json or "{}")
        run_id = run.id
        swarm_id = run.swarm_id

    hierarchy = get_hierarchy(swarm_id)
    if hierarchy is None:
        logger.warning("resume_run: hierarchy missing for swarm %s", swarm_id)
        _finish_run(run_id, STATUS_FAILED, error="Hierarchy missing on resume")
        return None

    # Reconstruct paths the same way start_run did. We assume the DATA_DIR /
    # workspace name / swarm name haven't changed between suspend and resume.
    from flask import current_app
    data_dir = current_app.config.get("DATA_DIR", "/data")
    from app.models.swarm import Swarm
    from app.models.workspace import Workspace
    with get_session() as session:
        swarm = session.get(Swarm, swarm_id)
        workspace = session.get(Workspace, swarm.workspace_id) if swarm else None
        if not swarm or not workspace:
            _finish_run(run_id, STATUS_FAILED, error="Swarm/workspace gone on resume")
            return None
        workspace_path = os.path.join(data_dir, "workspaces", workspace.name)
        swarm_path = os.path.join(workspace_path, "swarms", swarm.name)

    ctx = RunContext(
        run_id=run_id,
        swarm_id=swarm_id,
        swarm_path=swarm_path,
        workspace_path=workspace_path,
        data_dir=data_dir,
        hierarchy=hierarchy,
    )

    # Build the decision result the agent sees as the call's outcome.
    # `payload` is always the original; `amend` is the human's optional
    # amendment (present on yes OR no). The agent reads both.
    action_result: dict = {
        "decision": "yes" if ha.status == HA_STATUS_YES else "no",
        "payload": json.loads(ha.payload_json),
    }
    if ha.amend_json:
        action_result["amend"] = json.loads(ha.amend_json)
    if ha.decision_reason:
        action_result["reason"] = ha.decision_reason

    # Run is back in the running state; mark it before continuing.
    with get_session() as session:
        run = session.get(Run, run_id)
        run.status = STATUS_RUNNING
        run.error = None
        session.commit()

    _notify("run.resumed", {
        "run_id": run_id,
        "swarm_id": swarm_id,
        "human_action_id": human_action_id,
        "decision": action_result["decision"],
    })

    # Append the action_result to the snapshot's messages and re-enter the
    # agent loop. If the agent completes, finish; if it suspends again,
    # mark awaiting_human again; otherwise propagate failure.
    messages = list(snapshot.get("messages") or [])
    messages.append({"role": "user", "content": json.dumps({"action_result": action_result})})
    agent_name = snapshot.get("agent_name") or hierarchy.entry_point
    depth = snapshot.get("depth", 0)

    # We need the agent's md_path. Re-resolve it via _lookup_agent.
    _, md_path = _lookup_agent(agent_name, swarm_id, None)

    try:
        _run_agent_loop(
            agent_name=agent_name,
            md_path=md_path,
            initial_messages=messages,
            ctx=ctx,
            depth=depth,
        )  # token_totals discarded on resume — step already exists
        _finish_run(run_id, STATUS_COMPLETED)
        _notify("run.completed", {"run_id": run_id, "swarm_id": swarm_id, "status": "completed"})
    except RunSuspended as exc:
        _finish_run(run_id, STATUS_AWAITING_HUMAN)
        _notify("run.awaiting_human", {
            "run_id": run_id,
            "swarm_id": swarm_id,
            "human_action_id": exc.human_action_id,
        })
    except Exception as exc:
        logger.exception("Resumed run %s failed: %s", run_id, exc)
        _finish_run(run_id, STATUS_FAILED, error=str(exc))
        _notify("run.failed", {"run_id": run_id, "swarm_id": swarm_id, "status": "failed", "error": str(exc)})

    with get_session() as session:
        return session.get(Run, run_id)


# ── Agent execution ───────────────────────────────────────────────────────────

def _execute_agent_call(
    agent_name: str,
    messages: list[dict],
    ctx: RunContext,
    depth: int,
    *,
    edge_purpose: str | None,
    step_type: str,
    md_path_override: str | None = None,
) -> dict:
    """Record a run_step for this agent, run it, update the step, return its output.

    Args:
        agent_name:      Name of the agent to execute (as stored in the DB).
        messages:        Conversation messages to pass to the agent.
        ctx:             The shared run context.
        depth:           Current recursion depth (used for RunDepthError guard).
        edge_purpose:    The purpose string that authorized this call (None for entry point).
        step_type:       STEP_AGENT_CALL or STEP_PERCEPTIONIST_CALL.
        md_path_override: If provided, skip DB lookup and use this constitution path.

    Returns:
        The agent's final output dict (from its `complete` action's `input` field).
    """
    if _is_cancelled(ctx.run_id):
        raise RunCancelled("Run stopped by user")

    if depth > MAX_DEPTH:
        raise RunDepthError(
            f"Maximum call depth ({MAX_DEPTH}) exceeded at agent '{agent_name}'"
        )

    # Resolve agent_id and md_path from the database
    agent_id, md_path = _lookup_agent(agent_name, ctx.swarm_id, md_path_override)

    seq = ctx.next_sequence()
    started_at = datetime.now(timezone.utc)

    with get_session() as session:
        step = RunStep(
            run_id=ctx.run_id,
            agent_id=agent_id,
            step_type=step_type,
            step_name=agent_name,
            edge_purpose=edge_purpose,
            input_json=json.dumps(messages[-1].get("content", "") if messages else ""),
            sequence=seq,
            started_at=started_at,
        )
        session.add(step)
        session.commit()
        session.refresh(step)
        step_id = step.id

    try:
        output, token_totals = _run_agent_loop(
            agent_name=agent_name,
            md_path=md_path,
            initial_messages=messages,
            ctx=ctx,
            depth=depth,
        )
        _update_step(
            step_id,
            output_json=json.dumps(output),
            tokens_input=token_totals.get("input_tokens"),
            tokens_output=token_totals.get("output_tokens"),
        )
        _notify("run.step", {
            "run_id": ctx.run_id, "swarm_id": ctx.swarm_id,
            "step_name": agent_name, "step_type": step_type, "sequence": seq,
            "snippet": _output_snippet(output),
        })
        return output

    except Exception as exc:
        _update_step(step_id, error=str(exc))
        raise


def _run_agent_loop(
    agent_name: str,
    md_path: str | None,
    initial_messages: list[dict],
    ctx: RunContext,
    depth: int,
) -> tuple[dict, dict]:
    """Multi-turn loop: call LLM, dispatch actions, continue until complete.

    Returns (output, token_totals) where token_totals = {input_tokens, output_tokens}.
    Raises for topology violations, max turns, or human escalations.
    """
    if md_path is None or not os.path.isfile(md_path):
        raise SwarmRuntimeError(
            f"Constitution file not found for agent '{agent_name}'"
            + (f": {md_path}" if md_path else "")
        )

    post = frontmatter.load(md_path)
    constitution_body: str = post.content
    knowledge_refs: list[str] = post.get("knowledge", []) or []
    model: str | None = post.get("model")
    provider: str | None = post.get("provider") or None
    web_search: bool = bool(post.get("web_search", False))

    knowledge_text = _load_knowledge(knowledge_refs, ctx)
    inherited_directives = _load_inherited_directives(agent_name, ctx)
    system_prompt = _build_system_prompt(
        constitution_body=constitution_body,
        knowledge_text=knowledge_text,
        agent_name=agent_name,
        ctx=ctx,
        inherited_directives=inherited_directives,
    )

    llm = get_llm_credentials(provider=provider, model=model)
    messages = list(initial_messages)
    total_input_tokens = 0
    total_output_tokens = 0

    llm_kwargs: dict = {}
    if web_search and llm.provider == "anthropic":
        llm_kwargs["tools"] = [{"type": "web_search_20250305", "name": "web_search"}]

    _max_turns = _get_max_agent_turns()
    _json_failures = 0
    for turn in range(_max_turns):
        raw, usage = llm.complete_with_usage(system=system_prompt, messages=messages, **llm_kwargs)
        total_input_tokens += usage.get("input_tokens", 0)
        total_output_tokens += usage.get("output_tokens", 0)
        messages.append({"role": "assistant", "content": raw})

        try:
            action_dict = _parse_action(raw, agent_name)
        except SwarmRuntimeError as exc:
            _json_failures += 1
            if _json_failures >= 3:
                raise
            logger.warning("Agent '%s' returned non-JSON on turn %d — retrying: %s", agent_name, turn, exc)
            messages.append({
                "role": "user",
                "content": json.dumps({
                    "action_result": {
                        "error": (
                            f"{exc} "
                            "Respond with ONLY a single JSON object — no prose, no markdown fences. "
                            "It must include an \"action\" field. Follow the format instructions exactly."
                        ),
                        "type": "format_error",
                    }
                }),
            })
            continue
        _json_failures = 0
        action = action_dict.get("action", "")

        if action == "complete":
            return action_dict.get("input") or {}, {
                "input_tokens": total_input_tokens,
                "output_tokens": total_output_tokens,
            }

        if action == "escalate_to_human":
            reasoning = action_dict.get("reasoning", "(no reasoning given)")
            seq = ctx.next_sequence()
            now = datetime.now(timezone.utc)
            with get_session() as session:
                step = RunStep(
                    run_id=ctx.run_id,
                    agent_id=None,
                    step_type=STEP_HUMAN_ESCALATION,
                    step_name=agent_name,
                    edge_purpose=None,
                    input_json=json.dumps(action_dict.get("input") or {}),
                    sequence=seq,
                    started_at=now,
                    ended_at=now,
                    tokens_input=total_input_tokens,
                    tokens_output=total_output_tokens,
                )
                session.add(step)
                session.commit()
            raise SwarmRuntimeError(
                f"Agent '{agent_name}' escalated to human: {reasoning}"
            )

        result = _dispatch_sub_action(action_dict, agent_name, ctx, depth, messages=messages)
        messages.append({
            "role": "user",
            "content": json.dumps({"action_result": result}),
        })

    raise MaxTurnsError(
        f"Agent '{agent_name}' exceeded the maximum of {_max_turns} turns without completing"
    )


# ── Action dispatching ────────────────────────────────────────────────────────

def _dispatch_sub_action(
    action_dict: dict,
    agent_name: str,
    ctx: RunContext,
    depth: int,
    *,
    messages: list[dict] | None = None,
) -> dict:
    """Validate the action against the topology and dispatch it.

    Returns the result dict from the sub-call (agent output, skill output, etc.).
    Raises TopologyViolationError on any topology mismatch.
    """
    action = action_dict.get("action", "")
    target = action_dict.get("target", "")
    input_data = action_dict.get("input") or {}

    # ── Agent edges (escalate / delegate / report) ────────────────────────────
    if action in ("escalate", "delegate", "report"):
        edge = ctx.hierarchy.find_edge(agent_name, target, action)
        if edge is None:
            return _record_topology_violation(
                agent_name=agent_name,
                attempted=f"{action} → {target!r} — no such edge declared",
                ctx=ctx,
            )
        _notify_chat_step(ctx, "agent", target, edge["purpose"])
        return _execute_agent_call(
            agent_name=target,
            messages=[{"role": "user", "content": json.dumps(input_data)}],
            ctx=ctx,
            depth=depth + 1,
            edge_purpose=edge["purpose"],
            step_type=STEP_AGENT_CALL,
        )

    # ── Perceptionist consultation ────────────────────────────────────────────
    if action == "consult_perceptionist":
        consultation = ctx.hierarchy.find_consultation(agent_name, target)
        if consultation is None:
            return _record_topology_violation(
                agent_name=agent_name,
                attempted=f"consult_perceptionist → {target!r} — not declared in consultations",
                ctx=ctx,
            )
        try:
            _, perc_path = resolve(
                target,
                "perceptionist",
                data_dir=ctx.data_dir,
                swarm_path=ctx.swarm_path,
                workspace_path=ctx.workspace_path,
            )
        except ResolverError as exc:
            raise SwarmRuntimeError(
                f"Could not resolve perceptionist '{target}': {exc}"
            ) from exc

        # Use the unqualified name (basename without extension) for the step name
        perc_name = os.path.splitext(os.path.basename(perc_path))[0]
        _notify_chat_step(ctx, "perceptionist", perc_name, consultation["purpose"])
        return _execute_agent_call(
            agent_name=perc_name,
            messages=[{"role": "user", "content": json.dumps(input_data)}],
            ctx=ctx,
            depth=depth + 1,
            edge_purpose=consultation["purpose"],
            step_type=STEP_PERCEPTIONIST_CALL,
            md_path_override=perc_path,
        )

    # ── Skill call ────────────────────────────────────────────────────────────
    if action == "skill_call":
        skill_entry = ctx.hierarchy.find_skill(agent_name, target)
        if skill_entry is None:
            return _record_topology_violation(
                agent_name=agent_name,
                attempted=f"skill_call → {target!r} — not declared in skills",
                ctx=ctx,
            )
        _notify_chat_step(ctx, "skill", target, skill_entry["purpose"])
        return _execute_skill_call(
            skill_ref=target,
            input_data=input_data,
            agent_name=agent_name,
            ctx=ctx,
            edge_purpose=skill_entry["purpose"],
        )

    # ── Caller (human-in-the-loop, Phase 6) ───────────────────────────────────
    if action == "consult_caller":
        call_entry = ctx.hierarchy.find_call(agent_name, target)
        if call_entry is None:
            return _record_topology_violation(
                agent_name=agent_name,
                attempted=f"consult_caller → {target!r} — not declared in calls",
                ctx=ctx,
            )
        # Resolve the caller's md_path for traceability + verify file exists.
        try:
            _, caller_path = resolve(
                target,
                "caller",
                data_dir=ctx.data_dir,
                swarm_path=ctx.swarm_path,
                workspace_path=ctx.workspace_path,
            )
        except ResolverError as exc:
            raise SwarmRuntimeError(f"Could not resolve caller '{target}': {exc}") from exc

        # Find the registered Caller row by md_path (registry handles uniqueness)
        with get_session() as session:
            caller_row = session.execute(
                select(Caller).where(Caller.md_path == caller_path)
            ).scalar_one_or_none()
            if caller_row is None:
                raise SwarmRuntimeError(
                    f"Caller '{target}' is not in the registry — boot scan may have failed"
                )
            caller_id = caller_row.id

        # Persist a run_step row recording the call. The runtime snapshot the
        # agent is mid-step through goes onto the human_action row, not the
        # step row — the step is the public audit trail; the snapshot is
        # internal resume state.
        seq = ctx.next_sequence()
        now = datetime.now(timezone.utc)
        with get_session() as session:
            step = RunStep(
                run_id=ctx.run_id,
                agent_id=None,
                step_type=STEP_CALLER_CALL,
                step_name=target,
                edge_purpose=call_entry["purpose"],
                caller_id=caller_id,
                input_json=json.dumps(input_data),
                sequence=seq,
                started_at=now,
            )
            session.add(step)
            session.commit()
            session.refresh(step)
            step_id = step.id

        # Capture the runtime snapshot: which agent is asking, what messages
        # we've collected so far, current depth. Resume rebuilds an agent
        # loop from this snapshot with the human's decision payload appended
        # as the call result.
        snapshot = {
            "agent_name": agent_name,
            "messages": list(messages) if messages is not None else [],
            "depth": depth,
        }
        with get_session() as session:
            ha = HumanAction(
                run_id=ctx.run_id,
                step_id=step_id,
                caller_id=caller_id,
                purpose=call_entry["purpose"],
                payload_json=json.dumps(input_data),
                runtime_snapshot_json=json.dumps(snapshot),
                status=HA_STATUS_PENDING,
            )
            session.add(ha)
            session.commit()
            session.refresh(ha)
            ha_id = ha.id

        _notify("human_action.pending", {
            "human_action_id": ha_id,
            "run_id": ctx.run_id,
            "swarm_id": ctx.swarm_id,
            "caller_id": caller_id,
            "caller_name": target,
            "purpose": call_entry["purpose"],
        })

        # Suspend — propagates up to start_run which will mark the run as
        # awaiting_human. The exception is internal; not surfaced to the agent.
        raise RunSuspended(ha_id)

    # ── Informer (fire-and-forget notify, Phase 6.1) ──────────────────────────
    if action == "inform_informer":
        inform_entry = ctx.hierarchy.find_inform(agent_name, target)
        if inform_entry is None:
            return _record_topology_violation(
                agent_name=agent_name,
                attempted=f"inform_informer → {target!r} — not declared in informs",
                ctx=ctx,
            )
        try:
            _, informer_path = resolve(
                target,
                "informer",
                data_dir=ctx.data_dir,
                swarm_path=ctx.swarm_path,
                workspace_path=ctx.workspace_path,
            )
        except ResolverError as exc:
            raise SwarmRuntimeError(f"Could not resolve informer '{target}': {exc}") from exc

        with get_session() as session:
            informer_row = session.execute(
                select(Informer).where(Informer.md_path == informer_path)
            ).scalar_one_or_none()
            if informer_row is None:
                raise SwarmRuntimeError(
                    f"Informer '{target}' is not in the registry — boot scan may have failed"
                )
            informer_id = informer_row.id

        seq = ctx.next_sequence()
        now = datetime.now(timezone.utc)
        with get_session() as session:
            step = RunStep(
                run_id=ctx.run_id,
                agent_id=None,
                step_type=STEP_INFORMER_NOTIFY,
                step_name=target,
                edge_purpose=inform_entry["purpose"],
                informer_id=informer_id,
                input_json=json.dumps(input_data),
                sequence=seq,
                started_at=now,
                ended_at=now,
            )
            session.add(step)
            session.commit()
            session.refresh(step)
            step_id = step.id

        with get_session() as session:
            hi = HumanInform(
                run_id=ctx.run_id,
                step_id=step_id,
                informer_id=informer_id,
                purpose=inform_entry["purpose"],
                payload_json=json.dumps(input_data),
                status=HI_STATUS_UNREAD,
            )
            session.add(hi)
            session.commit()
            session.refresh(hi)
            hi_id = hi.id

        _notify("human_inform.pending", {
            "human_inform_id": hi_id,
            "run_id": ctx.run_id,
            "swarm_id": ctx.swarm_id,
            "informer_id": informer_id,
            "informer_name": target,
            "purpose": inform_entry["purpose"],
        })

        # Non-blocking: return a simple ack so the agent loop continues.
        return {"notified": target, "purpose": inform_entry["purpose"]}

    # ── Cross-swarm invocation ────────────────────────────────────────────────
    if action == "invoke_swarm":
        swarm_call_entry = ctx.hierarchy.find_swarm_call(agent_name, target)
        if swarm_call_entry is None:
            return _record_topology_violation(
                agent_name=agent_name,
                attempted=f"invoke_swarm → alias {target!r} — not declared in swarm_calls",
                ctx=ctx,
            )
        _notify_chat_step(ctx, "swarm", target, swarm_call_entry["purpose"])
        return _execute_swarm_call(
            swarm_call_entry=swarm_call_entry,
            input_data=input_data,
            calling_agent=agent_name,
            ctx=ctx,
            depth=depth,
        )

    # ── Unknown action ────────────────────────────────────────────────────────
    return _record_topology_violation(
        agent_name=agent_name,
        attempted=f"unknown action {action!r}",
        ctx=ctx,
    )


def _execute_skill_call(
    skill_ref: str,
    input_data: dict,
    agent_name: str,
    ctx: RunContext,
    edge_purpose: str,
) -> dict:
    """Resolve the skill, run it in the sandbox, record the run_step."""
    try:
        _, skill_py_path = resolve(
            skill_ref,
            "skill",
            data_dir=ctx.data_dir,
            swarm_path=ctx.swarm_path,
            workspace_path=ctx.workspace_path,
        )
    except ResolverError as exc:
        raise SwarmRuntimeError(f"Could not resolve skill '{skill_ref}': {exc}") from exc

    skill_yaml_path = os.path.splitext(skill_py_path)[0] + ".yaml"
    timeout_seconds = _get_default_skill_timeout()
    input_schema: dict | None = None
    output_schema: dict | None = None
    if os.path.isfile(skill_yaml_path):
        try:
            config = load_skill_config(skill_yaml_path)
            timeout_seconds = int(config.get("timeout_seconds", timeout_seconds))
            input_schema = config.get("input_schema")
            output_schema = config.get("output_schema")
        except Exception as exc:
            logger.warning("Could not read skill config %s: %s", skill_yaml_path, exc)

    # Validate input against declared schema before running.
    # Return an error dict so the agent can correct and retry rather than crashing the run.
    if input_schema:
        try:
            validate_skill_input(input_data, input_schema)
        except SkillValidationError as exc:
            logger.warning("Skill '%s' input validation failed: %s", skill_ref, exc)
            return {"error": str(exc), "type": "validation_error", "skill": skill_ref}

    seq = ctx.next_sequence()
    started_at = datetime.now(timezone.utc)

    with get_session() as session:
        step = RunStep(
            run_id=ctx.run_id,
            agent_id=None,
            step_type=STEP_SKILL_CALL,
            step_name=skill_ref,
            edge_purpose=edge_purpose,
            input_json=json.dumps(input_data),
            sequence=seq,
            started_at=started_at,
        )
        session.add(step)
        session.commit()
        session.refresh(step)
        step_id = step.id

    try:
        skill_context = {
            "run_id": ctx.run_id,
            "agent_name": agent_name,
            "swarm_id": ctx.swarm_id,
            "files_root": os.path.join(ctx.swarm_path, "files"),
            "data_dir": ctx.data_dir,
        }
        output = run_skill(
            skill_py_path=skill_py_path,
            input_data=input_data,
            context=skill_context,
            timeout_seconds=timeout_seconds,
        )
        # Validate output against declared schema after running.
        # A schema mismatch must NEVER crash a run that already did its work —
        # the skill's side effects have happened. Log it and pass the real
        # output back to the agent so it can still use the result.
        if output_schema:
            try:
                validate_skill_output(output, output_schema)
            except SkillValidationError as exc:
                logger.warning(
                    "Skill '%s' output failed schema validation (non-fatal): %s",
                    skill_ref, exc,
                )
        _update_step(step_id, output_json=json.dumps(output))

        # Keep swarm_files index in sync for builtin file skills
        _sync_file_index(skill_ref, input_data, output, ctx, step_id)

        _notify("run.step", {
            "run_id": ctx.run_id, "swarm_id": ctx.swarm_id,
            "step_name": skill_ref, "step_type": STEP_SKILL_CALL, "sequence": seq,
            "snippet": _output_snippet(output),
        })

        # Broadcast when an unmet need is created so the operator panel updates
        if skill_ref == "flag_unmet_need" and output.get("need_id"):
            _notify("signal.new", {"need_id": output["need_id"]})

        return output

    except SkillError as exc:
        _update_step(step_id, error=str(exc))
        raise SwarmRuntimeError(f"Skill '{skill_ref}' failed: {exc}") from exc


def _execute_swarm_call(
    swarm_call_entry: dict,
    input_data: dict,
    calling_agent: str,
    ctx: RunContext,
    depth: int,
) -> dict:
    """Invoke an external swarm synchronously within the current run."""
    from app.models.swarm import Swarm
    from app.models.workspace import Workspace

    target_swarm_id = swarm_call_entry["swarm_id"]
    alias = swarm_call_entry["alias"]

    target_hierarchy = get_hierarchy(target_swarm_id)
    if target_hierarchy is None:
        raise SwarmRuntimeError(
            f"Target swarm '{alias}' (id={target_swarm_id!r}) is not enabled "
            f"or not found in registry cache"
        )

    with get_session() as session:
        target_swarm = session.get(Swarm, target_swarm_id)
        if not target_swarm:
            raise SwarmRuntimeError(
                f"Target swarm '{alias}' (id={target_swarm_id!r}) not found in database"
            )
        target_workspace = session.get(Workspace, target_swarm.workspace_id)
        if not target_workspace:
            raise SwarmRuntimeError(
                f"Target swarm '{alias}' workspace not found in database"
            )
        target_swarm_path = os.path.join(
            ctx.data_dir, "workspaces", target_workspace.name, "swarms", target_swarm.name
        )
        target_workspace_path = os.path.join(ctx.data_dir, "workspaces", target_workspace.name)

    if not target_hierarchy.entry_point:
        raise SwarmRuntimeError(
            f"Target swarm '{alias}' has no entry_point configured"
        )

    seq = ctx.next_sequence()
    now = datetime.now(timezone.utc)
    with get_session() as session:
        step = RunStep(
            run_id=ctx.run_id,
            agent_id=None,
            step_type=STEP_SWARM_CALL,
            step_name=alias,
            edge_purpose=swarm_call_entry["purpose"],
            input_json=json.dumps(input_data),
            sequence=seq,
            started_at=now,
        )
        session.add(step)
        session.commit()
        session.refresh(step)
        step_id = step.id

    _notify("run.step", {
        "run_id": ctx.run_id, "swarm_id": ctx.swarm_id,
        "step_name": alias, "step_type": STEP_SWARM_CALL, "sequence": seq,
    })

    child_ctx = ctx.spawn_child(
        swarm_id=target_swarm_id,
        swarm_path=target_swarm_path,
        workspace_path=target_workspace_path,
        hierarchy=target_hierarchy,
    )

    result = _execute_agent_call(
        agent_name=target_hierarchy.entry_point,
        messages=[{"role": "user", "content": json.dumps(input_data)}],
        ctx=child_ctx,
        depth=depth + 1,
        edge_purpose=swarm_call_entry["purpose"],
        step_type=STEP_SWARM_CALL,
    )

    _update_step(step_id, output_json=json.dumps(result))
    return result


def _record_topology_violation(
    agent_name: str,
    attempted: str,
    ctx: RunContext,
) -> dict:
    """Record a topology_violation run_step and return an error dict.

    Returns an error result dict so the agent sees it in action_result and can
    correct itself on the next turn, instead of crashing the run immediately.
    """
    message = f"Topology violation by '{agent_name}': {attempted}"
    seq = ctx.next_sequence()
    now = datetime.now(timezone.utc)

    with get_session() as session:
        step = RunStep(
            run_id=ctx.run_id,
            agent_id=None,
            step_type=STEP_TOPOLOGY_VIOLATION,
            step_name=agent_name,
            edge_purpose=None,
            input_json="{}",
            error=message,
            sequence=seq,
            started_at=now,
            ended_at=now,
        )
        session.add(step)
        session.commit()

    logger.warning(message)
    return {"error": message, "type": "topology_violation"}


# ── Prompt building ───────────────────────────────────────────────────────────

def _load_inherited_directives(agent_name: str, ctx: RunContext) -> str:
    """Collect `inheritable` frontmatter from all ancestor agents in the delegate chain."""
    ancestors = ctx.hierarchy.get_ancestor_agents(agent_name)
    parts: list[str] = []
    for ancestor in ancestors:
        md_path = os.path.join(ctx.swarm_path, "agents", f"{ancestor}.md")
        if not os.path.isfile(md_path):
            continue
        try:
            post = frontmatter.load(md_path)
        except Exception:
            continue
        directive = (post.get("inheritable") or "").strip()
        if directive:
            parts.append(f"(from {ancestor})\n{directive}")
    return "\n\n".join(parts)


def _skill_schema_hint(skill_ref: str, ctx: "RunContext") -> str:
    """Return a compact parameter hint for a skill, e.g. ' | required: a, b; optional: c'."""
    try:
        from app.core.resolver import resolve, ResolverError
        _, skill_py_path = resolve(
            skill_ref, "skill",
            data_dir=ctx.data_dir,
            swarm_path=ctx.swarm_path,
            workspace_path=ctx.workspace_path,
        )
        yaml_path = os.path.splitext(skill_py_path)[0] + ".yaml"
        if not os.path.isfile(yaml_path):
            return ""
        config = load_skill_config(yaml_path)
        schema = config.get("input_schema") or {}
        props = schema.get("properties") or {}
        required = set(schema.get("required") or [])
        if not props:
            return ""
        req_parts, opt_parts = [], []
        for pname, pdef in props.items():
            raw_desc = (pdef.get("description") or "").strip().replace("\n", " ")
            desc = (raw_desc[:300] + "…") if len(raw_desc) > 300 else raw_desc
            entry = f"{pname} ({desc})" if desc else pname
            (req_parts if pname in required else opt_parts).append(entry)
        hint = ""
        if req_parts:
            hint += " | required: " + ", ".join(req_parts)
        if opt_parts:
            hint += " | optional: " + ", ".join(opt_parts)
        return hint
    except Exception:
        return ""


def _build_system_prompt(
    constitution_body: str,
    knowledge_text: str,
    agent_name: str,
    ctx: RunContext,
    inherited_directives: str = "",
) -> str:
    hierarchy = ctx.hierarchy
    parts: list[str] = [constitution_body.strip()]

    if inherited_directives:
        parts.append("\n\n# Inherited Directives\n\n" + inherited_directives)

    if knowledge_text:
        parts.append("\n\n# Reference Documents\n\n" + knowledge_text)

    parts.append("\n\n# Allowed Actions\n")

    edges = hierarchy.get_allowed_edges(agent_name)
    escalations = [e for e in edges if e["kind"] == "escalate"]
    delegations = [e for e in edges if e["kind"] == "delegate"]
    reports = [e for e in edges if e["kind"] == "report"]

    if escalations:
        parts.append("You may escalate to:")
        for e in escalations:
            parts.append(f"  - {e['to']} — {e['purpose']}")
        parts.append("")

    if delegations:
        parts.append("You may delegate to:")
        for e in delegations:
            parts.append(f"  - {e['to']} — {e['purpose']}")
        parts.append("")

    if reports:
        parts.append("You may report to:")
        for e in reports:
            parts.append(f"  - {e['to']} — {e['purpose']}")
        parts.append("")

    consultations = hierarchy.get_allowed_consultations(agent_name)
    if consultations:
        parts.append("You may consult perceptionists:")
        for c in consultations:
            parts.append(f"  - {c['perceptionist']} — {c['purpose']}")
        parts.append("")

    skills = hierarchy.get_allowed_skills(agent_name)
    if skills:
        first_skill = skills[0]["skill"]
        parts.append(
            "You may invoke skills. ALWAYS use action=\"skill_call\" and put the skill "
            "name in \"target\" — NEVER use a skill name as the action value. Example:\n"
            f'  {{"action": "skill_call", "target": "{first_skill}", "input": {{...}}}}\n'
            "Available skills:"
        )
        for s in skills:
            schema_hint = _skill_schema_hint(s["skill"], ctx)
            parts.append(f"  - {s['skill']} — {s['purpose']}{schema_hint}")
        parts.append("")

    calls = hierarchy.get_allowed_calls(agent_name)
    if calls:
        parts.append(
            "You may consult callers (humans-in-the-loop). Action=consult_caller. "
            "The run pauses; you receive the human's decision (yes/no, optional amend, "
            "optional reason) as the action_result on your next turn."
        )
        for c in calls:
            parts.append(f"  - {c['caller']} — {c['purpose']}")
        parts.append("")

    informs = hierarchy.get_allowed_informs(agent_name)
    if informs:
        parts.append(
            "You may notify informers (fire-and-forget). Action=inform_informer. "
            "The run continues immediately; the informer receives the notification "
            "in their inbox without blocking you."
        )
        for inf in informs:
            parts.append(f"  - {inf['informer']} — {inf['purpose']}")
        parts.append("")

    swarm_calls = hierarchy.get_allowed_swarm_calls(agent_name)
    if swarm_calls:
        parts.append(
            "You may invoke external swarms (synchronous, blocking). Action=invoke_swarm. "
            "Use target=<alias> where alias is the swarm's label below. "
            "The external swarm runs to completion and returns its output."
        )
        for sc in swarm_calls:
            parts.append(f"  - {sc['alias']} — {sc['purpose']}")
        parts.append("")

    parts.append("You may always use:")
    parts.append("  - complete — signal that your work is done (put your result in 'input')")
    parts.append("  - escalate_to_human — signal that human judgment is required")
    parts.append("")

    parts.append(_build_response_format(
        has_escalations=bool(escalations),
        has_delegations=bool(delegations),
        has_reports=bool(reports),
        has_consultations=bool(consultations),
        has_skills=bool(skills),
        has_calls=bool(calls),
        has_informs=bool(informs),
        has_swarm_calls=bool(swarm_calls),
    ))

    return "\n".join(parts)


def _load_knowledge(refs: list[str], ctx: RunContext) -> str:
    """Resolve each knowledge reference and return concatenated content."""
    if not refs:
        return ""
    sections: list[str] = []
    for ref in refs:
        try:
            _, path = resolve(
                ref,
                "knowledge",
                data_dir=ctx.data_dir,
                swarm_path=ctx.swarm_path,
                workspace_path=ctx.workspace_path,
            )
            with open(path) as f:
                sections.append(f.read().strip())
        except (ResolverError, OSError) as exc:
            logger.warning("Could not load knowledge document %r: %s", ref, exc)
    return "\n\n---\n\n".join(sections)


# ── Action parsing ────────────────────────────────────────────────────────────

def _extract_balanced_object(text: str, start: int) -> str | None:
    """Return the substring spanning the first balanced {...} object from `start`.

    Brace-counts while respecting string literals and escapes so that braces
    inside string values don't throw off the balance. Returns None if no
    balanced object is found.
    """
    depth = 0
    in_str = False
    escaped = False
    quote = ""
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == quote:
                in_str = False
            continue
        if ch in ("\"", "'"):
            in_str = True
            quote = ch
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def _parse_action(raw: str, agent_name: str) -> dict:
    """Parse the LLM's raw text response as a JSON action dict.

    Tolerant by design — the protocol is hand-rolled JSON across many providers,
    so we accept several near-misses before giving up:
      - markdown code fences around the object,
      - a reasoning preamble before the object and/or trailing prose after it,
      - Python-dict style output (single quotes, True/False/None) via literal_eval.

    Raises SwarmRuntimeError (with a specific reason) if no valid action dict is found.
    """
    text = raw.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        end = len(lines) - 1 if lines[-1].strip().startswith("```") else len(lines)
        text = "\n".join(lines[1:end]).strip()

    # Skip any preamble text before the first JSON object
    start = 0 if text.startswith("{") else text.find("{")
    if start == -1:
        raise SwarmRuntimeError(
            f"Agent '{agent_name}' returned no JSON object. "
            f"Output (first 400 chars): {raw[:400]}"
        )

    obj = None
    # 1. Standard JSON, tolerating trailing prose after the object.
    try:
        obj, _ = json.JSONDecoder().raw_decode(text, start)
    except json.JSONDecodeError:
        # 2. Fall back to a balanced-brace slice parsed as JSON, then as a
        #    Python literal (handles single quotes and True/False/None).
        snippet = _extract_balanced_object(text, start)
        if snippet is not None:
            try:
                obj = json.loads(snippet)
            except (json.JSONDecodeError, ValueError):
                try:
                    obj = ast.literal_eval(snippet)
                except (ValueError, SyntaxError):
                    obj = None

    if not isinstance(obj, dict):
        raise SwarmRuntimeError(
            f"Agent '{agent_name}' returned a response that is not a JSON object. "
            f"Output (first 400 chars): {raw[:400]}"
        )

    if "action" not in obj:
        raise SwarmRuntimeError(
            f"Agent '{agent_name}' response is missing the required 'action' field. Got: {obj}"
        )
    return obj


# ── Database helpers ──────────────────────────────────────────────────────────

def _lookup_agent(
    agent_name: str,
    swarm_id: str,
    md_path_override: str | None,
) -> tuple[str | None, str | None]:
    """Return (agent_id, md_path) for an agent.

    If md_path_override is provided, look up by path for the agent_id.
    Otherwise look up by swarm_id + name.
    """
    with get_session() as session:
        if md_path_override:
            row = session.execute(
                select(Agent).where(Agent.md_path == md_path_override)
            ).scalar_one_or_none()
        else:
            row = session.execute(
                select(Agent).where(
                    Agent.swarm_id == swarm_id,
                    Agent.name == agent_name,
                )
            ).scalar_one_or_none()

        if row is None:
            return None, md_path_override

        return row.id, row.md_path


def _finish_run(run_id: str, status: str, error: str | None = None) -> None:
    with get_session() as session:
        run = session.get(Run, run_id)
        if run:
            run.status = status
            run.ended_at = datetime.now(timezone.utc)
            run.error = error
            session.commit()


_FILE_WRITE_SKILLS = {"write_swarm_file"}
_FILE_DELETE_SKILLS = {"delete_swarm_file"}


def _sync_file_index(
    skill_ref: str,
    input_data: dict,
    output: dict,
    ctx: "RunContext",
    step_id: str,
) -> None:
    """Update swarm_files index after a successful builtin file skill call."""
    if skill_ref in _FILE_WRITE_SKILLS:
        try:
            upsert_file(
                swarm_id=ctx.swarm_id,
                path=output["path"],
                size_bytes=output["size_bytes"],
                checksum=output["checksum"],
                origin=ORIGIN_AGENT,
                run_id=ctx.run_id,
                step_id=step_id,
            )
        except Exception:
            logger.warning("Could not update swarm_files index after write_swarm_file", exc_info=True)
    elif skill_ref in _FILE_DELETE_SKILLS:
        if output.get("deleted"):
            try:
                remove_file(swarm_id=ctx.swarm_id, path=output["path"])
            except Exception:
                logger.warning("Could not remove swarm_files index entry after delete_swarm_file", exc_info=True)


def _update_step(
    step_id: str,
    *,
    output_json: str | None = None,
    error: str | None = None,
    tokens_input: int | None = None,
    tokens_output: int | None = None,
) -> None:
    with get_session() as session:
        step = session.get(RunStep, step_id)
        if step:
            step.ended_at = datetime.now(timezone.utc)
            if tokens_input is not None:
                step.tokens_input = tokens_input
            if tokens_output is not None:
                step.tokens_output = tokens_output
            if output_json is not None:
                step.output_json = output_json
            if error is not None:
                step.error = error
            session.commit()
