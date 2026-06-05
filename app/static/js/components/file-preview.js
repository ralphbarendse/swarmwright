/**
 * file-preview.js — shared file-store preview rendering.
 *
 * Renders a file's contents into a host element by type: image, PDF, markdown,
 * CSV/TSV tables, syntax-highlighted code, and plain text. Used by the desktop
 * Files page slide-over and the mobile Files tab so both render identically.
 *
 * `marked`/`DOMPurify`/`hljs` are globals from index.html; renderMarkdown wraps
 * the first two safely.
 */
import * as api from "../api.js";
import { renderMarkdown, highlightCodeBlocks } from "./markdown.js";
import { parseDelimited } from "./csv.js";

export const TEXT_PREVIEW_MAX = 512 * 1024; // bytes — above this we don't fetch inline

// Extensions we hand to highlight.js (its names double as language hints).
export const CODE_EXTS = new Set([
  "js", "ts", "jsx", "tsx", "py", "rb", "go", "rs", "java", "c", "cpp", "h",
  "cs", "php", "swift", "kt", "scala", "sh", "bash", "zsh", "sql", "html",
  "css", "scss", "json", "xml", "yaml", "yml", "toml", "ini", "dockerfile",
]);

export function isTextish(mime, filename) {
  mime = mime || "";
  if (mime.startsWith("text/")) return true;
  if (["application/json", "application/xml", "application/javascript", "application/csv"].includes(mime)) return true;
  const ext = (String(filename).split(".").pop() || "").toLowerCase();
  return ["txt", "md", "markdown", "json", "csv", "tsv", "log", "yaml", "yml", "xml",
    "html", "css", "js", "ts", "py", "sh", "ini", "toml", "env", "conf", "sql"].includes(ext);
}

export function fileIcon(mime, filename) {
  const ext = (String(filename).split(".").pop() || "").toLowerCase();
  mime = mime || "";
  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext)) return "🖼";
  if (mime === "application/pdf" || ext === "pdf") return "📄";
  if (["csv", "tsv", "xls", "xlsx"].includes(ext) || mime === "text/csv") return "📊";
  if (["json", "xml", "yaml", "yml", "toml", "ini", "env", "conf"].includes(ext)) return "⚙";
  if (["js", "ts", "py", "sh", "rb", "go", "rs", "java", "c", "cpp", "css", "html", "sql"].includes(ext)) return "⟨⟩";
  if (["zip", "tar", "gz", "tgz", "rar", "7z"].includes(ext)) return "🗜";
  if (["txt", "md", "markdown", "log", "rtf"].includes(ext)) return "📝";
  return "▱";
}

export function fmtBytes(n) {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Render `file` (needs swarm_id, path, filename, mime_type, size_bytes) into
 * `host`. Fetches text content for text/markdown/csv/code; streams image/pdf
 * via the raw URL.
 */
export function fillFilePreview(host, file) {
  const url = api.rawSwarmFileUrl(file.swarm_id, file.path);
  const mime = file.mime_type || "";
  const noPreview = (msg) => {
    host.innerHTML = `<div style="padding:40px 20px;text-align:center;font-family:var(--font-mono);
      font-size:12px;color:var(--color-ink-faint)">${msg}</div>`;
  };

  if (mime.startsWith("image/")) {
    host.innerHTML = `<div style="padding:16px;display:flex;justify-content:center">
      <img src="${url}" style="max-width:100%;height:auto;border-radius:4px" alt=""></div>`;
    return;
  }
  if (mime === "application/pdf" || /\.pdf$/i.test(file.filename)) {
    host.innerHTML = `<iframe src="${url}" style="width:100%;height:100%;border:none"></iframe>`;
    return;
  }
  if (isTextish(mime, file.filename)) {
    if (file.size_bytes > TEXT_PREVIEW_MAX) { noPreview("File too large to preview inline. Use Download."); return; }
    const ext = (String(file.filename).split(".").pop() || "").toLowerCase();
    host.innerHTML = `<div style="padding:20px;font-family:var(--font-mono);font-size:12px;
      color:var(--color-ink-faint)">Loading preview…</div>`;
    fetch(url).then(r => r.ok ? r.text() : Promise.reject(r.status)).then(text => {
      if (ext === "md" || ext === "markdown") {
        host.innerHTML = `<div class="fv-md">${renderMarkdown(text)}</div>`;
        highlightCodeBlocks(host);
      } else if (ext === "csv" || ext === "tsv" || mime === "text/csv") {
        _renderTablePreview(host, text, ext === "tsv" ? "\t" : ",");
      } else if (CODE_EXTS.has(ext) && typeof hljs !== "undefined") {
        const pre = document.createElement("pre");
        pre.className = "fv-code";
        const code = document.createElement("code");
        code.className = `language-${ext}`;
        code.textContent = text;            // textContent → no XSS, hljs reads it
        pre.appendChild(code);
        host.innerHTML = "";
        host.appendChild(pre);
        try { hljs.highlightElement(code); } catch { /* plain on failure */ }
      } else {
        host.innerHTML = `<pre style="margin:0;padding:16px 18px;font-family:var(--font-mono);font-size:12px;
          line-height:1.5;color:var(--color-ink);white-space:pre-wrap;word-break:break-word">${_esc(text)}</pre>`;
      }
    }).catch(() => noPreview("Could not load preview."));
    return;
  }
  noPreview("No inline preview for this file type. Use Download.");
}

function _renderTablePreview(host, text, delim) {
  const rows = parseDelimited(text, delim);
  if (rows.length < 2) {
    host.innerHTML = `<pre style="margin:0;padding:16px 18px;font-family:var(--font-mono);font-size:12px;
      line-height:1.5;color:var(--color-ink);white-space:pre-wrap;word-break:break-word">${_esc(text)}</pre>`;
    return;
  }
  const head = rows[0];
  const cols = head.length;
  const th = head.map(c => `<th>${_esc(c)}</th>`).join("");
  const trs = rows.slice(1).map(r =>
    `<tr>${Array.from({ length: cols }, (_, i) => `<td>${_esc(r[i] ?? "")}</td>`).join("")}</tr>`).join("");
  host.innerHTML = `<div class="fv-csv-wrap"><table class="fv-csv">
    <thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

function _esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
