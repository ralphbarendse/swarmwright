/**
 * SwarmWright service worker — installability + resilience, not offline-first.
 *
 * Strategy is deliberately network-first for everything so the app never
 * serves stale code while online. The cache is only a fallback that lets the
 * shell open when the network is flaky, and its existence (plus a fetch
 * handler) is what makes the PWA installable / home-screen-capable.
 *
 * Bump CACHE_VERSION whenever the precached shell list changes.
 */
const CACHE_VERSION = "sw-v1";
const SHELL = [
  "/",
  "/static/css/tokens.css",
  "/static/css/main.css",
  "/static/js/app.js",
  "/static/icons/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only handle same-origin GETs; never touch API calls or the SSE stream.
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Refresh the cached copy of shell-eligible responses opportunistically.
        if (res.ok && (req.mode === "navigate" || SHELL.includes(url.pathname))) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || caches.match("/"))
      )
  );
});
