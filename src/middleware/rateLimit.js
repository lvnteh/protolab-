// src/middleware/rateLimit.js
// Targeted rate limiters for abuse-prone endpoints. We only want to throttle
// specific POST endpoints (login/signup brute force, public comment spam) and
// never GET traffic or the /p prototype view flow. Because we mount these in
// server.js on shared paths, `postOnly` wraps a limiter so it is a no-op for
// non-POST methods (e.g. GET /admin/login renders the form freely).
//
// MULTI-INSTANCE: by default express-rate-limit keeps counters in process
// memory — per instance, so N instances give an attacker N× the attempts. In
// PRODUCTION we back each limiter with a SHARED Postgres store
// (@acpr/rate-limit-postgresql) so limits are enforced globally across every
// instance. In dev/test we deliberately use the built-in memory store: it is
// synchronous (deterministic in tests), opens no extra pools/handles, and a
// single process needs no sharing. Set RATE_LIMIT_STORE=pg to force the shared
// store outside production (e.g. to test it).
const rateLimit = require('express-rate-limit');
const config = require('../config');

const useSharedStore = config.isProduction || process.env.RATE_LIMIT_STORE === 'pg';

// Build a shared Postgres-backed store for one limiter, or return undefined to
// let express-rate-limit use its default in-memory store. Each limiter needs a
// distinct `prefix` so their counters don't collide in the shared table. The
// store manages its own table + pool and applies its migrations on construction.
function sharedStore(prefix) {
  if (!useSharedStore || !config.databaseUrl) return undefined;
  // Lazy-require so the pg store (and its pool) is never even loaded in the
  // common dev/test path — keeps the memory-store path free of open handles.
  const { PostgresStore } = require('@acpr/rate-limit-postgresql');
  return new PostgresStore(config.pgConnectionConfig(), prefix);
}

function postOnly(limiter) {
  return (req, res, next) => {
    if (req.method !== 'POST') return next();
    return limiter(req, res, next);
  };
}

// POST /admin/login — ~5 attempts / 15 min per IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: sharedStore('rl_login'),
  message: { error: 'Too many login attempts. Please try again later.' },
});

// POST /admin/signup — ~3 / hour per IP.
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  store: sharedStore('rl_signup'),
  message: { error: 'Too many signup attempts. Please try again later.' },
});

// POST /api/comments — ~100 / hour per IP (public reviewer feedback stays open).
const commentsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  store: sharedStore('rl_comments'),
  message: { error: 'Too many comments submitted. Please slow down.' },
});

module.exports = {
  postOnly,
  loginLimiter,
  signupLimiter,
  commentsLimiter,
};
