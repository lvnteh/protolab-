// src/server.js
const express = require('express');
const path = require('path');
const session = require('express-session');
const helmet = require('helmet');
const { initDb } = require('./db');
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
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  // secure:true means the cookie is only sent over HTTPS. Enabled in production
  // only, so local HTTP development/tests still work.
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' },
}));

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

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

if (require.main === module) {
  if (!config.databaseUrl) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }
  initDb().then(() => {
    app.listen(config.port, '0.0.0.0', () => {
      console.log(`Proto Share running on http://0.0.0.0:${config.port}`);
    });
  }).catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
}

module.exports = app;
