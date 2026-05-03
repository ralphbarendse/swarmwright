/** Toast notification system. */
const container = () => document.getElementById("toast-container");

export function toast(message, type = "default", duration = 4000) {
  const el = document.createElement("div");
  el.className = `toast${type === "error" ? " toast-error" : type === "success" ? " toast-success" : ""}`;
  el.textContent = message;
  container().appendChild(el);
  setTimeout(() => el.remove(), duration);
}

export function toastError(err) {
  const msg = err?.message || err?.code || String(err);
  toast(msg, "error");
}

export function toastSuccess(msg) {
  toast(msg, "success");
}
