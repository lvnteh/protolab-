// src/middleware/reviewerCsrf.js
// CSRF + same-origin guard for the COOKIE-AUTHENTICATED reviewer mutations
// (POST/PATCH/DELETE on /api/comments, /api/nav, and POST /p/:token/enter).
//
// Threat model this closes:
//   - The sandboxed prototype runs at an OPAQUE origin. If it (or any other
//     cross-origin page) tried to drive a state-changing request at ProtoLab
//     using the reviewer's ambient session cookie, the browser attaches
//     `Origin: null` (opaque) or a foreign origin. We reject BOTH before any
//     side effect. The sandbox already strips the cookie from the prototype's
//     own fetches, but this is the server-side belt to the client-side braces:
//     a forged frame message that somehow reached the shell still cannot make
//     the shell issue a request that this guard would accept, because the shell
//     only ever fires same-origin requests carrying the session CSRF token.
//   - Classic CSRF from a third-party site: no valid token, cross-origin Origin.
//
// Design mirrors middleware/csrf.js (double-submit, session-bound token) but is
// a SEPARATE guard so the reviewer API can be enforced independently of the
// admin router, and so we can also apply the hard same-origin / opaque-origin
// rejection that the admin double-submit alone does not do.
//
// COMPATIBILITY: like middleware/csrf.js, hard enforcement of the token is gated
// behind CSRF_ENABLED==='1' || NODE_ENV==='production' so existing token-less
// supertest suites keep passing. The ORIGIN checks, however, only ever REJECT a
// request that actually presents a cross/opaque Origin header — supertest sends
// none — so opaque-origin rejection is always active without breaking tests.
const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function tokenEnforcementEnabled() {
  return process.env.CSRF_ENABLED === '1' || process.env.NODE_ENV === 'production';
}

// Ensure the session carries a CSRF token and expose it for server-side view
// injection (delivery.js stamps it into the trusted shell so the SDK can echo
// it back on mutations). Returns the token or '' when there is no session.
function ensureToken(req) {
  if (!req.session) return '';
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Resolve the request's own origin (scheme://host) from forwarded headers so
// the same-origin comparison is correct behind a TLS-terminating proxy.
function selfOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return host ? `${proto}://${host}` : null;
}

function reviewerCsrf(req, res, next) {
  return guard(req, res, next, { rejectOpaqueOrigin: true });
}

// Variant for TOP-LEVEL form navigations (POST /p/:token/enter). Browsers can
// legitimately send `Origin: null` for a same-origin top-level <form> POST
// (e.g. under a no-referrer policy or certain navigations), so we must NOT treat
// `null` as hostile there — doing so would break the email-entry gate for real
// users. Instead the entry form carries a session-bound CSRF token (hidden
// _csrf field) which proves same-origin intent. Cross-origin (a named foreign
// origin) is still rejected.
function reviewerCsrfFormNav(req, res, next) {
  return guard(req, res, next, { rejectOpaqueOrigin: false });
}

function guard(req, res, next, opts) {
  const token = ensureToken(req);
  if (res.locals) res.locals.csrfToken = token;

  if (SAFE_METHODS.has(req.method)) return next();

  // --- Hard origin gate (always active) --------------------------------------
  // Reject opaque-origin (sandboxed prototype) and cross-origin state changes
  // BEFORE touching any data. A request with NO Origin header falls through to
  // the token check — browsers always send Origin on cross-origin AND opaque
  // requests (for fetch/XHR), so absence means "not a browser cross-site fetch".
  const origin = req.get('origin');
  if (origin !== undefined) {
    if (origin === 'null') {
      if (opts.rejectOpaqueOrigin) {
        return res.status(403).json({ error: 'Opaque-origin requests are not allowed.' });
      }
      // Top-level form nav: fall through to the token check.
    } else {
      const self = selfOrigin(req);
      if (self && origin !== self) {
        return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
      }
    }
  }

  // --- Double-submit token check (gated for test/dev compatibility) ----------
  if (!tokenEnforcementEnabled()) return next();

  const expected = req.session && req.session.csrfToken;
  const provided = req.get('x-csrf-token')
    || (req.body && typeof req.body === 'object' ? req.body._csrf : undefined);
  if (!expected || !provided || !safeEqual(provided, expected)) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
  }
  return next();
}

module.exports = reviewerCsrf;
module.exports.reviewerCsrfFormNav = reviewerCsrfFormNav;
module.exports.ensureToken = ensureToken;
module.exports.tokenEnforcementEnabled = tokenEnforcementEnabled;
module.exports.selfOrigin = selfOrigin;
