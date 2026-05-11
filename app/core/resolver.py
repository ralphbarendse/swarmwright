from __future__ import annotations

import os
from typing import Literal

ResourceType = Literal["knowledge", "skill", "perceptionist", "caller", "informer"]
Scope = Literal["swarm", "workspace", "company", "builtin"]

# Built-in skills ship with the app in app/builtin_skills/
_BUILTIN_SKILLS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "builtin_skills")

# Folder names within each scope for each resource type
_RESOURCE_FOLDERS: dict[ResourceType, str] = {
    "knowledge": "knowledge",
    "skill": "skills",
    "perceptionist": "perceptionists",
    "caller": "callers",
    "informer": "informers",
}

# File extensions to try, in order of preference
_EXTENSIONS: dict[ResourceType, list[str]] = {
    "knowledge": [".md"],
    "skill": [".py"],
    "perceptionist": [".md"],
    "caller": [".md"],
    "informer": [".md"],
}


class ResolverError(Exception):
    """Raised when a named resource cannot be resolved."""


def resolve(
    reference: str,
    resource_type: ResourceType,
    *,
    data_dir: str,
    swarm_path: str | None = None,
    workspace_path: str | None = None,
) -> tuple[Scope, str]:
    """Resolve a named resource reference to an absolute file path.

    Resolution order (most-local wins):
        swarm → workspace → company

    Qualified references override the search:
        "workspace/finance-procedures" → workspace scope only
        "company/glossary"             → company scope only

    Args:
        reference:     The reference string from a constitution or hierarchy.json.
        resource_type: One of "knowledge", "skill", "perceptionist".
        data_dir:      Absolute path to the data/ directory.
        swarm_path:    Absolute path to the swarm folder (optional).
        workspace_path: Absolute path to the workspace folder (optional).

    Returns:
        A (scope, absolute_path) tuple.

    Raises:
        ResolverError: If the reference cannot be resolved at any scope.
    """
    folder = _RESOURCE_FOLDERS[resource_type]
    extensions = _EXTENSIONS[resource_type]

    # ── Qualified references ──────────────────────────────────────────────────
    if reference.startswith("company/"):
        name = reference[len("company/"):]
        path = _find_file(os.path.join(data_dir, "company", folder), name, extensions)
        if path:
            return "company", path
        raise ResolverError(
            f"Cannot resolve {resource_type!r} reference {reference!r}: "
            f"not found under company scope."
        )

    if reference.startswith("workspace/"):
        name = reference[len("workspace/"):]
        if workspace_path is None:
            raise ResolverError(
                f"Cannot resolve {resource_type!r} reference {reference!r}: "
                f"no workspace context provided."
            )
        path = _find_file(os.path.join(workspace_path, folder), name, extensions)
        if path:
            return "workspace", path
        raise ResolverError(
            f"Cannot resolve {resource_type!r} reference {reference!r}: "
            f"not found under workspace scope."
        )

    # ── Unqualified references: walk swarm → workspace → company ─────────────
    name = reference

    if swarm_path is not None:
        path = _find_file(os.path.join(swarm_path, folder), name, extensions)
        if path:
            return "swarm", path

    if workspace_path is not None:
        path = _find_file(os.path.join(workspace_path, folder), name, extensions)
        if path:
            return "workspace", path

    path = _find_file(os.path.join(data_dir, "company", folder), name, extensions)
    if path:
        return "company", path

    # Built-in skills are the final fallback — only applicable to skills
    if resource_type == "skill":
        path = _find_file(_BUILTIN_SKILLS_DIR, name, extensions)
        if path:
            return "builtin", path

    searched = []
    if swarm_path:
        searched.append(f"swarm ({os.path.join(swarm_path, folder)})")
    if workspace_path:
        searched.append(f"workspace ({os.path.join(workspace_path, folder)})")
    searched.append(f"company ({os.path.join(data_dir, 'company', folder)})")
    if resource_type == "skill":
        searched.append(f"builtin ({_BUILTIN_SKILLS_DIR})")

    raise ResolverError(
        f"Cannot resolve {resource_type!r} reference {reference!r}. "
        f"Searched: {', '.join(searched)}."
    )


def _find_file(directory: str, name: str, extensions: list[str]) -> str | None:
    """Look for `name` with any of the given extensions inside `directory`.

    Returns the absolute path if found, None otherwise.
    """
    for ext in extensions:
        candidate = os.path.join(directory, name + ext)
        if os.path.isfile(candidate):
            return os.path.abspath(candidate)
    return None
