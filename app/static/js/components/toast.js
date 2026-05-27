/** Toast notification system. */
const container = () => document.getElementById("toast-container");

/**
 * Show a toast notification.
 * @param {string} message
 * @param {"default"|"success"|"error"} type
 * @param {number} duration  ms before auto-dismiss. 0 = persist until dismissed.
 */
export function toast(message, type = "default", duration = 4000) {
  const el = document.createElement("div");
  el.className = `toast${type === "error" ? " toast-error" : type === "success" ? " toast-success" : ""}`;

  if (type === "error") {
    // Error toasts persist until the user explicitly dismisses them.
    el.style.cssText += "display:flex;align-items:flex-start;gap:10px;cursor:pointer;";

    const text = document.createElement("span");
    text.style.flex = "1";
    text.textContent = message;

    const btn = document.createElement("button");
    btn.setAttribute("aria-label", "Dismiss");
    btn.textContent = "×";
    btn.style.cssText = [
      "background:none",
      "border:none",
      "color:rgba(255,255,255,.6)",
      "font-size:18px",
      "line-height:1",
      "cursor:pointer",
      "padding:0",
      "flex-shrink:0",
      "margin-top:-2px",
    ].join(";");

    el.appendChild(text);
    el.appendChild(btn);

    const dismiss = () => {
      el.style.animation = "toast-out .15s ease forwards";
      setTimeout(() => el.remove(), 140);
    };
    btn.addEventListener("click", dismiss);
    el.addEventListener("click", dismiss);
  } else {
    el.textContent = message;
    const d = duration > 0 ? duration : 4000;
    setTimeout(() => {
      el.style.animation = "toast-out .15s ease forwards";
      setTimeout(() => el.remove(), 140);
    }, d);
  }

  container().appendChild(el);
}

export function toastError(err) {
  const msg = err?.message || err?.code || String(err);
  toast(msg, "error");
}

export function toastSuccess(msg) {
  toast(msg, "success");
}
