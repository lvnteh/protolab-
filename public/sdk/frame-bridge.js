// public/sdk/frame-bridge.js
// Injected into an HTML prototype that is rendered inside the ProtoLab shell
// iframe. The ProtoLab chrome (toolbar, sidebar, comment UI, screenshot capture)
// all live in the PARENT shell document — clicks inside an iframe do not bubble
// to the parent, so this bridge forwards the signals the SDK needs:
//   - comment-mode clicks (as viewport-local coordinates)
//   - the current page URL (for page-scoped comments + nav tracking)
//   - SPA navigation (pushState/replaceState/popstate/hashchange)
// It deliberately reads NOTHING back into the prototype beyond toggling a class
// that sets the crosshair cursor while comment mode is active.
//
// ROBUSTNESS: the prototype runs under `sandbox allow-scripts` at an OPAQUE
// origin. Some window APIs (notably history method reassignment and, in some
// engines, storage/history access) can throw under that sandbox. The bridge
// therefore registers its two CRITICAL listeners — receive comment-mode, and
// forward clicks — FIRST, and wraps every optional/best-effort feature (geometry,
// SPA history patching) in its own try/catch, so a throw in a nice-to-have can
// never disable comment-mode forwarding (the core of the feedback flow).
(function () {
  if (window.top === window.self) return; // not framed — do nothing

  // The prototype's own window.location.origin is the useless string "null" under
  // the opaque sandbox. The real, trusted ProtoLab shell origin is stamped onto
  // our <script> tag by the server (data-shell-origin). We post to the parent with
  // THIS exact origin — never "*" — so a message can only ever be delivered to the
  // genuine shell, and we accept parent messages ONLY when they come from
  // window.parent AND carry this exact origin. With no configured origin we refuse
  // to talk to the parent at all (fail closed) rather than fall back to a wildcard.
  var SHELL_ORIGIN = '';
  try {
    // currentScript can be null depending on how the script is executed; fall back
    // to locating our own tag by src so SHELL_ORIGIN is never silently empty.
    var me = document.currentScript
      || document.querySelector('script[src*="frame-bridge.js"]');
    if (me) SHELL_ORIGIN = me.getAttribute('data-shell-origin') || '';
  } catch (_) {}

  var commentMode = false;

  function post(msg) {
    if (!SHELL_ORIGIN) return; // fail closed: no known trusted parent
    try { window.parent.postMessage(Object.assign({ __fb: true }, msg), SHELL_ORIGIN); } catch (_) {}
  }

  function pageUrl() {
    try { return window.location.href; } catch (_) { return ''; }
  }

  function announcePage() {
    post({ type: 'page', href: pageUrl() });
  }

  // ── CRITICAL PATH 1: receive comment-mode toggles from the parent ──────────
  // The ONLY command the bridge honours is the non-sensitive presentation toggle
  // `commentMode`; anything else is ignored. Origin check: the message must come
  // from our own parent window AND carry the exact trusted shell origin. (The
  // parent targets us with "*" because our opaque origin can't be named — so OUR
  // validation is what makes the channel safe: a forged message from another
  // frame/window, or one claiming any other origin, fails e.source/e.origin.)
  window.addEventListener('message', function (e) {
    if (!SHELL_ORIGIN) return;
    if (e.source !== window.parent) return;
    if (e.origin !== SHELL_ORIGIN) return;
    var d = e.data;
    if (!d || d.__fb !== true) return;
    if (d.type === 'commentMode') {
      commentMode = !!d.on;
      try {
        document.documentElement.style.cursor = commentMode ? 'crosshair' : '';
        if (document.body) document.body.style.cursor = commentMode ? 'crosshair' : '';
      } catch (_) {}
    }
  });

  // ── CRITICAL PATH 2: forward comment-mode clicks to the parent ─────────────
  // Capture-phase so we can swallow the click (so the prototype doesn't also act
  // on it) while comment mode is on. Passive otherwise — the prototype is normal.
  document.addEventListener('click', function (e) {
    if (!commentMode) return;
    e.preventDefault();
    e.stopPropagation();
    post({ type: 'click', x: e.clientX, y: e.clientY });
  }, true);

  // ── Best-effort: geometry forwarding (never blocks the critical paths) ─────
  try {
    var pending = false;
    var onGeom = function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        post({ type: 'geom', scrollX: window.scrollX, scrollY: window.scrollY,
          innerWidth: window.innerWidth, innerHeight: window.innerHeight });
      });
    };
    window.addEventListener('scroll', onGeom, { passive: true });
    window.addEventListener('resize', onGeom, { passive: true });
  } catch (_) {}

  // ── Best-effort: SPA navigation tracking. Patching history methods can throw
  //    under the opaque sandbox in some engines, so it is isolated — a failure
  //    here must not prevent comment-mode forwarding above. ─────────────────────
  try {
    ['pushState', 'replaceState'].forEach(function (method) {
      var orig = history[method];
      history[method] = function () {
        orig.apply(this, arguments);
        window.dispatchEvent(new Event('fb-bridge-nav'));
      };
    });
    window.addEventListener('popstate', announcePage);
    window.addEventListener('hashchange', announcePage);
    window.addEventListener('fb-bridge-nav', announcePage);
  } catch (_) {}

  // Tell the parent we are ready, and announce the initial page.
  post({ type: 'ready', href: pageUrl() });
  announcePage();
})();
