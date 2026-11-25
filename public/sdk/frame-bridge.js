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
(function () {
  if (window.top === window.self) return; // not framed — do nothing

  var FB_ORIGIN = window.location.origin;
  var commentMode = false;

  function post(msg) {
    try { window.parent.postMessage(Object.assign({ __fb: true }, msg), FB_ORIGIN); } catch (_) {}
  }

  function pageUrl() {
    return window.location.href;
  }

  // Announce the current page URL to the parent (initial + on every navigation).
  function announcePage() {
    post({ type: 'page', href: pageUrl() });
  }

  // Capture-phase click listener. When comment mode is on we forward the click
  // coordinates (viewport-local) to the parent and swallow the click so the
  // prototype does not also act on it (navigate, submit, etc.). When comment
  // mode is off we are completely passive — the prototype behaves normally.
  document.addEventListener('click', function (e) {
    if (!commentMode) return;
    e.preventDefault();
    e.stopPropagation();
    post({ type: 'click', x: e.clientX, y: e.clientY });
  }, true);

  // Forward scroll/resize so the parent can keep ripple/overlay geometry honest
  // if it ever needs to. Throttled with rAF to avoid flooding the message channel.
  var pending = false;
  function onGeom() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      post({ type: 'geom', scrollX: window.scrollX, scrollY: window.scrollY,
        innerWidth: window.innerWidth, innerHeight: window.innerHeight });
    });
  }
  window.addEventListener('scroll', onGeom, { passive: true });
  window.addEventListener('resize', onGeom, { passive: true });

  // SPA navigation tracking. Patch history methods to emit a synthetic event,
  // and listen for the native ones, then re-announce the page URL to the parent.
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

  // Receive comment-mode toggles from the parent so we know when to intercept
  // clicks and show the crosshair cursor.
  window.addEventListener('message', function (e) {
    if (e.origin !== FB_ORIGIN) return;
    var d = e.data;
    if (!d || d.__fb !== true) return;
    if (d.type === 'commentMode') {
      commentMode = !!d.on;
      document.documentElement.style.cursor = commentMode ? 'crosshair' : '';
      if (document.body) document.body.style.cursor = commentMode ? 'crosshair' : '';
    }
  });

  // Tell the parent we are ready, and announce the initial page.
  post({ type: 'ready', href: pageUrl() });
  announcePage();
})();
