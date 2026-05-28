"""Built-in skill: full-text search across all knowledge files (platform-wide)."""
from __future__ import annotations
import json, os, sys

_MAX_RESULTS = 20
_EXCERPT_CHARS = 400
_MIN_TOKEN_LEN = 3  # ignore tiny words like "is", "of"


def _tokenize(query: str) -> list[str]:
    tokens = [w.lower() for w in query.split() if len(w) >= _MIN_TOKEN_LEN]
    return tokens if tokens else [query.lower()]


def _score(text: str, tokens: list[str]) -> int:
    low = text.lower()
    return sum(low.count(t) for t in tokens)


def _excerpt(text: str, tokens: list[str]) -> str:
    low = text.lower()
    positions = [low.find(t) for t in tokens if low.find(t) != -1]
    if not positions:
        return text[:_EXCERPT_CHARS].strip()
    mid = sum(positions) // len(positions)
    start = max(0, mid - _EXCERPT_CHARS // 2)
    end = min(len(text), start + _EXCERPT_CHARS)
    snippet = text[start:end].strip()
    if start > 0:
        snippet = "…" + snippet
    if end < len(text):
        snippet = snippet + "…"
    return snippet


def _collect(kb_dir: str, tokens: list[str], label: str, candidates: list) -> None:
    if not os.path.isdir(kb_dir):
        return
    for fname in sorted(os.listdir(kb_dir)):
        if not fname.endswith(".md"):
            continue
        path = os.path.join(kb_dir, fname)
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            continue
        score = _score(text, tokens)
        if score > 0:
            candidates.append({
                "file": fname,
                "location": label,
                "score": score,
                "excerpt": _excerpt(text, tokens),
            })


def run(input_data: dict, context: dict) -> dict:
    query = str(input_data.get("query", "")).strip()
    if not query:
        raise ValueError("search_knowledge: 'query' is required")

    workspace_filter = input_data.get("workspace_id")
    data_dir = context["data_dir"]
    workspaces_dir = os.path.join(data_dir, "workspaces")
    tokens = _tokenize(query)

    candidates: list[dict] = []

    if not os.path.isdir(workspaces_dir):
        return {"query": query, "results": []}

    for ws_name in sorted(os.listdir(workspaces_dir)):
        ws_path = os.path.join(workspaces_dir, ws_name)
        if not os.path.isdir(ws_path):
            continue
        if workspace_filter and ws_name != workspace_filter:
            continue

        _collect(os.path.join(ws_path, "knowledge"), tokens, f"workspace:{ws_name}", candidates)

        swarms_dir = os.path.join(ws_path, "swarms")
        if os.path.isdir(swarms_dir):
            for swarm_name in sorted(os.listdir(swarms_dir)):
                _collect(
                    os.path.join(swarms_dir, swarm_name, "knowledge"),
                    tokens,
                    f"workspace:{ws_name}/swarm:{swarm_name}",
                    candidates,
                )

    candidates.sort(key=lambda x: x["score"], reverse=True)
    results = [
        {"file": c["file"], "location": c["location"], "match_count": c["score"], "excerpt": c["excerpt"]}
        for c in candidates[:_MAX_RESULTS]
    ]
    return {"query": query, "results": results}


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
