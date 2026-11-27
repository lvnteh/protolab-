// src/server.js
const express = require('express');
const path = require('path');
const session = require('express-session');
const helmet = require('helmet');
const { initDb, getDb, closeDb, seedDevUser } = require('./db');
const config = require('./config');
const deliveryRouter = require('./routes/delivery');
const apiRouter = require('./routes/api');
const adminRouter = require('./routes/admin');
const apiV1Router = require('./routes/apiV1');
const csrf = require('./middleware/csrf');
const {
  postOnly, loginLimiter, signupLimiter, commentsLimiter,
} = require('./middleware/rateLimit');

const app = express();

// Behind Railway/any reverse proxy, the real client IP arrives in
// X-Forwarded-For and the original scheme in X-Forwarded-Proto. Without this,
// req.ip is the proxy's IP — which would make the rate limiters key every
// visitor to the same bucket, and the secure-cookie/HTTPS detection wrong.
// Trust the first proxy hop (Railway terminates TLS one hop in front).
app.set('trust proxy', 1);

// Security headers. CSP is intentionally DISABLED: prototypes are arbitrary
// user-uploaded HTML served at /p/:token/view with an injected SDK that uses
// inline styles/scripts — a strict CSP would break served prototypes. Future
// work: a route-scoped CSP that relaxes only the /p delivery paths.
app.use(helmet({ contentSecurityPolicy: false }));

app.use(express.urlencoded({ extended: true }));
// Comment-screenshot dataUrls (base64 PNG) ride in the JSON body of POST
// /api/comments, so the default 100KB limit would 413 them before the route
// runs. Allow up to 12MB — base64 inflates the 8MB raw cap in handleScreenshot
// (~33%) plus JSON overhead, so the route's own MAX_SCREENSHOT_BYTES stays the
// effective boundary (oversized images are dropped there, the comment still posts).
app.use(express.json({ limit: '12mb' }));

// Session store. In-process MemoryStore does not survive redeploys and is not
// shared across instances (a user logged in on instance A is logged out when
// routed to B). In PRODUCTION we persist sessions in Postgres (connect-pg-simple),
// which survives restarts and works across N instances. In dev/test we use the
// default MemoryStore: no extra pool/handles (keeps the test runner clean) and
// a single process needs no sharing. Set SESSION_STORE=pg to force it elsewhere.
const sessionOptions = {
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  // secure:true means the cookie is only sent over HTTPS. Enabled in production
  // only, so local HTTP development/tests still work.
  cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProduction },
};
const usePgSessions = (config.isProduction || process.env.SESSION_STORE === 'pg') && config.databaseUrl;

// buildSessionMiddleware is called after initDb() so connect-pg-simple receives
// the already-warmed pool rather than opening its own connection against a
// potentially still-waking Postgres (the root cause of cold-start ETIMEDOUT).
function buildSessionMiddleware(pool) {
  if (usePgSessions && pool) {
    const pgSession = require('connect-pg-simple')(session);
    sessionOptions.store = new pgSession({ pool, createTableIfMissing: true });
  }
  return session(sessionOptions);
}

// Placeholder — replaced before the server starts accepting requests when
// running as main (see initDb().then below). In test/import mode this is
// registered immediately with MemoryStore so existing suites work unchanged.
let sessionMiddleware = session(sessionOptions);
app.use((req, res, next) => sessionMiddleware(req, res, next));

// Dev mode: auto-authenticate to bypass login (localhost only). OPT-IN only —
// set DEV_AUTH_BYPASS=1 to enable. It is OFF by default (even in dev) so the real
// signup/login/invite/zero-org journeys can be exercised locally; a blanket
// bypass would mask every one of them. Never active in production.
if (process.env.NODE_ENV !== 'production' && process.env.DEV_AUTH_BYPASS === '1') {
  app.use('/admin', (req, res, next) => {
    if (!req.session.userId) {
      req.session.userId = 'dev-user-12345';
      req.session.activeOrgId = 'dev-org-12345';
    }
    next();
  });
}

// Targeted rate limiters. Mounted on shared paths but guarded to POST so GET
// (form render, /p view flow) is never throttled.
app.use('/admin/login', postOnly(loginLimiter));
app.use('/admin/signup', postOnly(signupLimiter));
app.use('/api/comments', postOnly(commentsLimiter));

app.use('/sdk', express.static(path.join(__dirname, '../public/sdk'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache');
    // The sandboxed prototype iframe runs at an OPAQUE origin (CSP `sandbox
    // allow-scripts`), so loading /sdk/frame-bridge.js into it is a cross-origin
    // subresource fetch. Helmet's default Cross-Origin-Resource-Policy:
    // same-origin would block it (net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin),
    // leaving the bridge inert — no comment-mode clicks, no nav. These SDK files
    // are public, non-sensitive static assets, so marking them cross-origin is
    // safe and is required for the bridge to run inside the sandbox.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  },
}));
app.use('/p', deliveryRouter);
app.use('/api/v1', apiV1Router);
app.use('/api', apiRouter);
// CSRF guard is applied to the admin router only. Enforcement is prod-gated
// (see middleware/csrf.js) so existing token-less supertest suites still pass.
app.use('/admin', csrf, adminRouter);

// Docs workflow (login-gated inside the router; GitHub-API backed).
app.use('/docs', require('./routes/docs').createDocsRouter());

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'views/landing.html')));

// Readiness/health check. Unlike GET / (a static file), this verifies the app
// can actually reach Postgres — the dependency whose outage manifests as the
// "getaddrinfo ENOTFOUND / can't init DB" failures. Returns 200 only when a
// trivial query succeeds; 503 otherwise, so a load balancer can pull a broken
// instance out of rotation instead of routing traffic to it.
app.get('/health', async (_req, res) => {
  try {
    await getDb().query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'unhealthy', error: 'database unreachable' });
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

if (require.main === module) {
  if (!config.databaseUrl) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }
  initDb().then(async (pool) => {
    await seedDevUser();

    // Swap the session middleware to use the already-warmed pool so
    // connect-pg-simple never races against a slow-waking Postgres.
    sessionMiddleware = buildSessionMiddleware(pool);

    const server = app.listen(config.port, '0.0.0.0', () => {
      console.log(`Proto Share running on http://0.0.0.0:${config.port}`);
    });

    // Graceful shutdown. Railway (and most orchestrators) send SIGTERM on
    // redeploy/scale-down; without this the process is hard-killed mid-request.
    // Stop accepting new connections, let in-flight requests finish, then drain
    // the DB pool. Force-exit after a timeout so a stuck connection can't hang
    // the deploy indefinitely.
    const shutdown = (signal) => {
      console.log(`${signal} received — shutting down gracefully.`);
      const forced = setTimeout(() => {
        console.error('Forced exit after shutdown timeout.');
        process.exit(1);
      }, 10000);
      forced.unref();
      server.close(async () => {
        try { await closeDb(); } catch { /* pool already gone */ }
        process.exit(0);
      });
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }).catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
}

module.exports = app;
