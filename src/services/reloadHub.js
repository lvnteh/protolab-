// src/services/reloadHub.js
// Tiny fan-out registry for SSE live-reload. Pure and framework-free so it is
// trivially testable; the route wires fs.watch into broadcast().
function createReloadHub() {
  const subs = new Set();
  return {
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    broadcast(msg = 'reload') {
      for (const fn of subs) { try { fn(msg); } catch { subs.delete(fn); } }
    },
    size() { return subs.size; },
  };
}
module.exports = { createReloadHub };
