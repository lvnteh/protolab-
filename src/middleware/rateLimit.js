// src/middleware/rateLimit.js
// Targeted rate limiters for abuse-prone endpoints. We only want to throttle
// specific POST endpoints (login/signup brute force, public comment spam) and
// never GET traffic or the /p prototype view flow. Because we mount these in
// server.js on shared paths, `postOnly` wraps a limiter so it is a no-op for
// non-POST methods (e.g. GET /admin/login renders the form freely).
const rateLimit = require('express-rate-limit');

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
  message: { error: 'Too many login attempts. Please try again later.' },
});

// POST /admin/signup — ~3 / hour per IP.
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many signup attempts. Please try again later.' },
});

// POST /api/comments — ~100 / hour per IP (public reviewer feedback stays open).
const commentsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many comments submitted. Please slow down.' },
});

module.exports = {
  postOnly,
  loginLimiter,
  signupLimiter,
  commentsLimiter,
};
