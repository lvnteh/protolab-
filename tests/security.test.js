// tests/security.test.js
// DB-free security-hardening tests. These cover config secret handling, helmet
// headers, targeted rate limiting, and the custom CSRF middleware. Where a real
// app path would touch Postgres we build a tiny express app instead, so this
// suite is safe to run in isolation via `npx jest tests/security.test.js`.
const express = require('express');
const session = require('express-session');
const request = require('supertest');

describe('config session secret (task 1)', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    jest.resetModules();
    // Neutralise dotenv so a local .env can't repopulate SESSION_SECRET and make
    // these assertions non-deterministic — we control env explicitly here.
    jest.doMock('dotenv', () => ({ config: () => ({ parsed: {} }) }));
    process.env = { ...OLD_ENV };
  });
  afterEach(() => { jest.dontMock('dotenv'); });
  afterAll(() => { process.env = OLD_ENV; });

  test('throws in production when SESSION_SECRET is missing', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SESSION_SECRET;
    expect(() => require('../src/config')).toThrow(/SESSION_SECRET/);
  });

  test('falls back to a dev-only secret outside production', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.SESSION_SECRET;
    const config = require('../src/config');
    expect(config.sessionSecret).toBe('dev-only-insecure-secret');
  });

  test('uses the provided SESSION_SECRET when set', () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'super-secret-value';
    const config = require('../src/config');
    expect(config.sessionSecret).toBe('super-secret-value');
  });
});

describe('helmet security headers (task 3)', () => {
  const helmet = require('helmet');
  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.get('/', (_req, res) => res.send('ok'));

  test('sets standard helmet headers on GET /', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers).toHaveProperty('x-dns-prefetch-control');
  });

  test('does NOT set a content-security-policy header (CSP disabled)', async () => {
    const res = await request(app).get('/');
    expect(res.headers['content-security-policy']).toBeUndefined();
  });
});

describe('rate limiting (task 4)', () => {
  const { postOnly, loginLimiter } = require('../src/middleware/rateLimit');

  function buildApp() {
    const app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use('/admin/login', postOnly(loginLimiter));
    app.post('/admin/login', (_req, res) => res.status(401).send('nope'));
    app.get('/admin/login', (_req, res) => res.send('form'));
    return app;
  }

  test('returns 429 after exceeding the login POST limit', async () => {
    const app = buildApp();
    // Limit is 5 per 15 min. The 6th rapid POST from the same IP should 429.
    let last;
    for (let i = 0; i < 6; i += 1) {
      last = await request(app).post('/admin/login').send({ email: 'x', password: 'y' });
    }
    expect(last.status).toBe(429);
  });

  test('does not throttle GET traffic (postOnly guard)', async () => {
    const app = buildApp();
    let last;
    for (let i = 0; i < 10; i += 1) {
      last = await request(app).get('/admin/login');
    }
    expect(last.status).toBe(200);
  });
});

describe('CSRF middleware (task 7)', () => {
  const csrf = require('../src/middleware/csrf');

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
    app.use(csrf);
    app.get('/token', (_req, res) => res.json({ token: res.locals.csrfToken }));
    app.post('/thing', (_req, res) => res.json({ ok: true }));
    return app;
  }

  const OLD_ENV = process.env;
  afterEach(() => { process.env = { ...OLD_ENV }; });

  test('exposes a csrf token on safe (GET) requests', async () => {
    const app = buildApp();
    const res = await request(app).get('/token');
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(0);
  });

  test('rejects unsafe POST without a token when enforcement is forced on', async () => {
    process.env.CSRF_ENABLED = '1';
    const app = buildApp();
    const agent = request.agent(app);
    // Prime the session so a token exists, then POST without echoing it.
    await agent.get('/token');
    const res = await agent.post('/thing').send({ any: 'data' });
    expect(res.status).toBe(403);
  });

  test('accepts unsafe POST with the matching token when enforcement is on', async () => {
    process.env.CSRF_ENABLED = '1';
    const app = buildApp();
    const agent = request.agent(app);
    const tokenRes = await agent.get('/token');
    const token = tokenRes.body.token;
    const res = await agent.post('/thing').set('x-csrf-token', token).send({});
    expect(res.status).toBe(200);
  });

  test('does not enforce when disabled (default off in test/dev)', async () => {
    delete process.env.CSRF_ENABLED;
    process.env.NODE_ENV = 'test';
    const app = buildApp();
    const res = await request(app).post('/thing').send({});
    expect(res.status).toBe(200);
  });
});
