/**
 * Single persistent SSE connection.
 * Dispatches typed events to registered handlers.
 */

const _handlers = {};
let _es = null;

export function onEvent(type, fn) {
  if (!_handlers[type]) _handlers[type] = [];
  _handlers[type].push(fn);
}

export function offEvent(type, fn) {
  if (!_handlers[type]) return;
  _handlers[type] = _handlers[type].filter(h => h !== fn);
}

export function connect() {
  if (_es) return;
  _es = new EventSource("/api/v1/stream");
  _es.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      const fns = _handlers[msg.type] || [];
      fns.forEach(fn => { try { fn(msg); } catch (err) { console.error("SSE handler error", err); } });
      // Also dispatch to wildcard handlers
      (_handlers["*"] || []).forEach(fn => { try { fn(msg); } catch (err) { console.error("SSE handler error", err); } });
    } catch (err) {
      console.error("SSE parse error", err);
    }
  };
  _es.onerror = () => {
    // Reconnect after 5 s
    _es.close();
    _es = null;
    setTimeout(connect, 5000);
  };
}

export function disconnect() {
  if (_es) { _es.close(); _es = null; }
}
