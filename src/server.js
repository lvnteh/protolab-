// src/server.js
const express = require('express');
const path = require('path');
const session = require('express-session');
const helmet = require('helmet');
const { initDb, getDb, closeDb } = require('./db');
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
app.use(express.json());

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
if (usePgSessions) {
  const pgSession = require('connect-pg-simple')(session);
  sessionOptions.store = new pgSession({
    conObject: config.pgConnectionConfig(),
    createTableIfMissing: true, // self-provisions the "session" table on first use
  });
}
app.use(session(sessionOptions));

// Targeted rate limiters. Mounted on shared paths but guarded to POST so GET
// (form render, /p view flow) is never throttled.
app.use('/admin/login', postOnly(loginLimiter));
app.use('/admin/signup', postOnly(signupLimiter));
app.use('/api/comments', postOnly(commentsLimiter));

app.use('/sdk', express.static(path.join(__dirname, '../public/sdk'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));
app.use('/p', deliveryRouter);
app.use('/api/v1', apiV1Router);
app.use('/api', apiRouter);
// CSRF guard is applied to the admin router only. Enforcement is prod-gated
// (see middleware/csrf.js) so existing token-less supertest suites still pass.
app.use('/admin', csrf, adminRouter);

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
  initDb().then(() => {
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
