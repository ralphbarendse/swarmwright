/**
 * Markdown rendering helpers.
 *
 * marked.parse() output is NOT safe to inject directly — uploaded files,
 * agent output and user-authored constitutions can all contain raw HTML or
 * <script>/onerror payloads. Everything that ends up in innerHTML must go
 * through DOMPurify first. These helpers centralise that so we can't forget.
 *
 * Both `marked` and `DOMPurify` are loaded as globals from index.html.
 */

/**
 * Render untrusted markdown text to a sanitized HTML string.
 * Falls back to escaped plain text if the libraries aren't loaded.
 */
export function renderMarkdown(text) {
  const src = String(text ?? "");
  if (typeof marked === "undefined") return _escapeHtml(src);
  const raw = marked.parse(src);
  return typeof DOMPurify !== "undefined" ? DOMPurify.sanitize(raw) : raw;
}

/**
 * Syntax-highlight any <pre><code> blocks inside an already-rendered element.
 * No-op if highlight.js isn't loaded. Safe to call after renderMarkdown().
 */
export function highlightCodeBlocks(rootEl) {
  if (!rootEl || typeof hljs === "undefined") return;
  rootEl.querySelectorAll("pre code").forEach((el) => {
    try { hljs.highlightElement(el); } catch { /* leave block un-highlighted */ }
  });
}

function _escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
