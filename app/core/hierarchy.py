from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any

import frontmatter

from app.core.resolver import resolve, ResolverError

logger = logging.getLogger(__name__)

VALID_EDGE_KINDS = {"escalate", "delegate", "report"}
VALID_LAYERS = {"policy", "orchestrator", "executioner", "perceptionist"}


@dataclass
class HierarchyValidationError(Exception):
    """Raised when a hierarchy.json fails validation."""
    code: str
    message: str
    details: dict = field(default_factory=dict)

    def __str__(self) -> str:
        return f"[{self.code}] {self.message}"


@dataclass
class ParsedHierarchy:
    """The validated, in-memory representation of a hierarchy.json."""
    swarm: str
    agents: list[str]
    edges: list[dict]
    consultations: list[dict]
    skills: list[dict]
    entry_point: str | None
    # Phase 6: agent → caller routes (blocking). Default `[]` for back-compat.
    calls: list[dict] = field(default_factory=list)
    # Phase 6.1: agent → informer routes (non-blocking). Default `[]` for back-compat.
    informs: list[dict] = field(default_factory=list)

    def get_allowed_edges(self, agent_name: str) -> list[dict]:
        return [e for e in self.edges if e["from"] == agent_name]

    def get_allowed_consultations(self, agent_name: str) -> list[dict]:
        return [c for c in self.consultations if c["agent"] == agent_name]

    def get_allowed_skills(self, agent_name: str) -> list[dict]:
        return [s for s in self.skills if s["agent"] == agent_name]

    def get_allowed_calls(self, agent_name: str) -> list[dict]:
        return [c for c in self.calls if c["agent"] == agent_name]

    def get_allowed_informs(self, agent_name: str) -> list[dict]:
        return [i for i in self.informs if i["agent"] == agent_name]

    def find_edge(self, from_agent: str, to_agent: str, kind: str) -> dict | None:
        for e in self.edges:
            if e["from"] == from_agent and e["to"] == to_agent and e["kind"] == kind:
                return e
        return None

    def find_consultation(self, agent_name: str, perceptionist_ref: str) -> dict | None:
        for c in self.consultations:
            if c["agent"] == agent_name and c["perceptionist"] == perceptionist_ref:
                return c
        return None

    def find_skill(self, agent_name: str, skill_ref: str) -> dict | None:
        for s in self.skills:
            if s["agent"] == agent_name and s["skill"] == skill_ref:
                return s
        return None

    def find_call(self, agent_name: str, caller_ref: str) -> dict | None:
        for c in self.calls:
            if c["agent"] == agent_name and c["caller"] == caller_ref:
                return c
        return None

    def find_inform(self, agent_name: str, informer_ref: str) -> dict | None:
        for i in self.informs:
            if i["agent"] == agent_name and i["informer"] == informer_ref:
                return i
        return None


def load_and_validate(
    hierarchy_path: str,
    *,
    swarm_path: str,
    workspace_path: str,
    data_dir: str,
) -> ParsedHierarchy:
    """Parse and fully validate a hierarchy.json file.

    Args:
        hierarchy_path:  Absolute path to the hierarchy.json file.
        swarm_path:      Absolute path to the swarm folder.
        workspace_path:  Absolute path to the workspace folder.
        data_dir:        Absolute path to the data/ directory.

    Returns:
        A ParsedHierarchy instance.

    Raises:
        HierarchyValidationError: If any validation check fails.
    """
    # ── Load ──────────────────────────────────────────────────────────────────
    try:
        with open(hierarchy_path) as f:
            raw: dict[str, Any] = json.load(f)
    except json.JSONDecodeError as exc:
        raise HierarchyValidationError(
            code="invalid_json",
            message=f"hierarchy.json is not valid JSON: {exc}",
        ) from exc
    except OSError as exc:
        raise HierarchyValidationError(
            code="file_not_found",
            message=f"Could not read hierarchy.json: {exc}",
        ) from exc

    # ── Required top-level keys ───────────────────────────────────────────────
    for key in ("swarm", "agents", "edges", "consultations", "skills"):
        if key not in raw:
            raise HierarchyValidationError(
                code="missing_key",
                message=f"Required top-level key '{key}' is missing from hierarchy.json",
            )

    swarm_name: str = raw["swarm"]
    agents: list[str] = raw["agents"]
    edges: list[dict] = raw["edges"]
    consultations: list[dict] = raw["consultations"]
    skills: list[dict] = raw["skills"]
    # `calls` (Phase 6) and `informs` (Phase 6.1) are optional — default to []
    calls: list[dict] = raw.get("calls", [])
    informs: list[dict] = raw.get("informs", [])
    entry_point: str | None = raw.get("entry_point")

    agents_set = set(agents)

    # ── Agents resolve to constitution files ──────────────────────────────────
    agents_folder = os.path.join(swarm_path, "agents")
    for agent_name in agents:
        constitution = os.path.join(agents_folder, f"{agent_name}.md")
        if not os.path.isfile(constitution):
            raise HierarchyValidationError(
                code="agent_not_found",
                message=f"Agent '{agent_name}' listed in hierarchy.json but no constitution found at {constitution}",
                details={"agent": agent_name, "expected_path": constitution},
            )

        # ── Constitution frontmatter must be valid YAML ───────────────────────
        try:
            post = frontmatter.load(constitution)
        except Exception as exc:
            raise HierarchyValidationError(
                code="invalid_constitution",
                message=f"Agent '{agent_name}' constitution has unparseable frontmatter: {exc}",
                details={"agent": agent_name, "path": constitution},
            ) from exc

        # ── Layer must be a recognised value if declared ──────────────────────
        layer = post.get("layer")
        if layer and layer not in VALID_LAYERS:
            raise HierarchyValidationError(
                code="invalid_layer",
                message=(
                    f"Agent '{agent_name}' has invalid layer '{layer}'. "
                    f"Valid layers: {', '.join(sorted(VALID_LAYERS))}"
                ),
                details={"agent": agent_name, "layer": layer},
            )

        # ── Knowledge references must resolve (item 12) ───────────────────────
        knowledge_refs: list[str] = post.get("knowledge") or []
        for ref in knowledge_refs:
            try:
                resolve(
                    ref,
                    "knowledge",
                    data_dir=data_dir,
                    swarm_path=swarm_path,
                    workspace_path=workspace_path,
                )
            except ResolverError as exc:
                raise HierarchyValidationError(
                    code="knowledge_not_found",
                    message=(
                        f"Agent '{agent_name}' references knowledge '{ref}' "
                        f"which cannot be resolved: {exc}"
                    ),
                    details={"agent": agent_name, "knowledge_ref": ref},
                ) from exc

    # ── entry_point is a declared agent ───────────────────────────────────────
    if entry_point and entry_point not in agents_set:
        raise HierarchyValidationError(
            code="invalid_entry_point",
            message=f"entry_point '{entry_point}' is not in the agents list",
            details={"entry_point": entry_point},
        )

    # ── Edges ─────────────────────────────────────────────────────────────────
    seen_edges: set[tuple] = set()
    for i, edge in enumerate(edges):
        for key in ("from", "to", "kind", "purpose"):
            if key not in edge:
                raise HierarchyValidationError(
                    code="edge_missing_field",
                    message=f"Edge #{i} is missing required field '{key}'",
                    details={"edge_index": i, "edge": edge},
                )

        if not edge["purpose"].strip():
            raise HierarchyValidationError(
                code="empty_purpose",
                message=f"Edge from '{edge['from']}' to '{edge['to']}' has an empty purpose string",
                details={"edge": edge},
            )

        if edge["kind"] not in VALID_EDGE_KINDS:
            raise HierarchyValidationError(
                code="invalid_edge_kind",
                message=f"Edge kind '{edge['kind']}' is not valid. Must be one of: {', '.join(sorted(VALID_EDGE_KINDS))}",
                details={"edge": edge},
            )

        if edge["from"] not in agents_set:
            raise HierarchyValidationError(
                code="unknown_agent",
                message=f"Edge 'from' agent '{edge['from']}' is not in the agents list",
                details={"edge": edge},
            )

        if edge["to"] not in agents_set:
            raise HierarchyValidationError(
                code="unknown_agent",
                message=f"Edge 'to' agent '{edge['to']}' is not in the agents list",
                details={"edge": edge},
            )

        sig = (edge["from"], edge["to"], edge["kind"])
        if sig in seen_edges:
            raise HierarchyValidationError(
                code="duplicate_edge",
                message=f"Duplicate edge: {edge['from']} → {edge['to']} ({edge['kind']})",
                details={"edge": edge},
            )
        seen_edges.add(sig)

    # ── Consultations ─────────────────────────────────────────────────────────
    for i, consultation in enumerate(consultations):
        for key in ("agent", "perceptionist", "purpose"):
            if key not in consultation:
                raise HierarchyValidationError(
                    code="consultation_missing_field",
                    message=f"Consultation #{i} is missing required field '{key}'",
                    details={"consultation_index": i},
                )

        if not consultation["purpose"].strip():
            raise HierarchyValidationError(
                code="empty_purpose",
                message=f"Consultation by '{consultation['agent']}' to '{consultation['perceptionist']}' has an empty purpose",
                details={"consultation": consultation},
            )

        if consultation["agent"] not in agents_set:
            raise HierarchyValidationError(
                code="unknown_agent",
                message=f"Consultation agent '{consultation['agent']}' is not in the agents list",
                details={"consultation": consultation},
            )

        try:
            resolve(
                consultation["perceptionist"],
                "perceptionist",
                data_dir=data_dir,
                swarm_path=swarm_path,
                workspace_path=workspace_path,
            )
        except ResolverError as exc:
            raise HierarchyValidationError(
                code="perceptionist_not_found",
                message=f"Consultation perceptionist '{consultation['perceptionist']}' could not be resolved: {exc}",
                details={"consultation": consultation},
            ) from exc

    # ── Skills ────────────────────────────────────────────────────────────────
    for i, skill_entry in enumerate(skills):
        for key in ("agent", "skill", "purpose"):
            if key not in skill_entry:
                raise HierarchyValidationError(
                    code="skill_missing_field",
                    message=f"Skill entry #{i} is missing required field '{key}'",
                    details={"skill_index": i},
                )

        if not skill_entry["purpose"].strip():
            raise HierarchyValidationError(
                code="empty_purpose",
                message=f"Skill connection for '{skill_entry['agent']}' → '{skill_entry['skill']}' has an empty purpose",
                details={"skill": skill_entry},
            )

        if skill_entry["agent"] not in agents_set:
            raise HierarchyValidationError(
                code="unknown_agent",
                message=f"Skill agent '{skill_entry['agent']}' is not in the agents list",
                details={"skill": skill_entry},
            )

        try:
            resolve(
                skill_entry["skill"],
                "skill",
                data_dir=data_dir,
                swarm_path=swarm_path,
                workspace_path=workspace_path,
            )
        except ResolverError as exc:
            raise HierarchyValidationError(
                code="skill_not_found",
                message=f"Skill '{skill_entry['skill']}' could not be resolved: {exc}",
                details={"skill": skill_entry},
            ) from exc

    # ── Calls (Phase 6) ───────────────────────────────────────────────────────
    seen_calls: set[tuple] = set()
    for i, call_entry in enumerate(calls):
        for key in ("agent", "caller", "purpose"):
            if key not in call_entry:
                raise HierarchyValidationError(
                    code="call_missing_field",
                    message=f"Call entry #{i} is missing required field '{key}'",
                    details={"call_index": i},
                )

        if not call_entry["purpose"].strip():
            raise HierarchyValidationError(
                code="empty_purpose",
                message=(
                    f"Call from '{call_entry['agent']}' to caller "
                    f"'{call_entry['caller']}' has an empty purpose"
                ),
                details={"call": call_entry},
            )

        if call_entry["agent"] not in agents_set:
            raise HierarchyValidationError(
                code="unknown_agent",
                message=f"Call agent '{call_entry['agent']}' is not in the agents list",
                details={"call": call_entry},
            )

        try:
            resolve(
                call_entry["caller"],
                "caller",
                data_dir=data_dir,
                swarm_path=swarm_path,
                workspace_path=workspace_path,
            )
        except ResolverError as exc:
            raise HierarchyValidationError(
                code="caller_not_found",
                message=(
                    f"Call to caller '{call_entry['caller']}' from "
                    f"'{call_entry['agent']}' could not be resolved: {exc}"
                ),
                details={"call": call_entry},
            ) from exc

        sig = (call_entry["agent"], call_entry["caller"])
        if sig in seen_calls:
            raise HierarchyValidationError(
                code="duplicate_call",
                message=(
                    f"Duplicate call: {call_entry['agent']} → "
                    f"{call_entry['caller']}"
                ),
                details={"call": call_entry},
            )
        seen_calls.add(sig)

    # ── Informs (Phase 6.1) ───────────────────────────────────────────────────
    seen_informs: set[tuple] = set()
    for i, inform_entry in enumerate(informs):
        for key in ("agent", "informer", "purpose"):
            if key not in inform_entry:
                raise HierarchyValidationError(
                    code="inform_missing_field",
                    message=f"Inform entry #{i} is missing required field '{key}'",
                    details={"inform_index": i},
                )

        if not inform_entry["purpose"].strip():
            raise HierarchyValidationError(
                code="empty_purpose",
                message=(
                    f"Inform from '{inform_entry['agent']}' to informer "
                    f"'{inform_entry['informer']}' has an empty purpose"
                ),
                details={"inform": inform_entry},
            )

        if inform_entry["agent"] not in agents_set:
            raise HierarchyValidationError(
                code="unknown_agent",
                message=f"Inform agent '{inform_entry['agent']}' is not in the agents list",
                details={"inform": inform_entry},
            )

        try:
            resolve(
                inform_entry["informer"],
                "informer",
                data_dir=data_dir,
                swarm_path=swarm_path,
                workspace_path=workspace_path,
            )
        except ResolverError as exc:
            raise HierarchyValidationError(
                code="informer_not_found",
                message=(
                    f"Inform to informer '{inform_entry['informer']}' from "
                    f"'{inform_entry['agent']}' could not be resolved: {exc}"
                ),
                details={"inform": inform_entry},
            ) from exc

        sig = (inform_entry["agent"], inform_entry["informer"])
        if sig in seen_informs:
            raise HierarchyValidationError(
                code="duplicate_inform",
                message=(
                    f"Duplicate inform: {inform_entry['agent']} → "
                    f"{inform_entry['informer']}"
                ),
                details={"inform": inform_entry},
            )
        seen_informs.add(sig)

    return ParsedHierarchy(
        swarm=swarm_name,
        agents=agents,
        edges=edges,
        consultations=consultations,
        skills=skills,
        calls=calls,
        informs=informs,
        entry_point=entry_point,
    )
