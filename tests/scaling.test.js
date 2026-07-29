// tests/scaling.test.js — P2 multi-instance readiness: /health, storage
// fail-fast in prod, and store-gating logic. These are unit-level (no DB
// required for most) so they run in the DB-free lane too.

describe('storage prod fail-fast', () => {
  const ORIG = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIG };
    jest.resetModules();
  });

  test('throws on load in production when Supabase creds are absent', () => {
    jest.resetModules();
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'x'; // config needs this in prod
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => require('../src/services/storage')).toThrow(/Supabase Storage is required in production/);
  });

  test('does NOT throw in production when Supabase creds are present', () => {
    jest.resetModules();
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'x';
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
    expect(() => require('../src/services/storage')).not.toThrow();
  });

  test('does NOT throw outside production even without creds (offline dev)', () => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => require('../src/services/storage')).not.toThrow();
  });
});

describe('config.pgConnectionConfig', () => {
  const ORIG = { ...process.env };
  afterEach(() => { process.env = { ...ORIG }; jest.resetModules(); });

  test('disables SSL for localhost', () => {
    jest.resetModules();
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
    delete process.env.PGSSLMODE;
    const config = require('../src/config');
    expect(config.pgConnectionConfig().ssl).toBe(false);
  });

  test('enables relaxed SSL for a managed host', () => {
    jest.resetModules();
    process.env.DATABASE_URL = 'postgresql://u:p@db.example.com:5432/db';
    delete process.env.PGSSLMODE;
    const config = require('../src/config');
    expect(config.pgConnectionConfig().ssl).toEqual({ rejectUnauthorized: false });
  });

  test('PGSSLMODE=disable forces SSL off even for a remote host', () => {
    jest.resetModules();
    process.env.DATABASE_URL = 'postgresql://u:p@db.example.com:5432/db';
    process.env.PGSSLMODE = 'disable';
    const config = require('../src/config');
    expect(config.pgConnectionConfig().ssl).toBe(false);
  });
});

const hasDb = !!process.env.DATABASE_URL;

(hasDb ? describe : describe.skip)('GET /health', () => {
  let app, closeDb;
  beforeAll(async () => {
    const db = require('../src/db');
    closeDb = db.closeDb;
    await db.initDb();
    app = require('../src/server'); // exports the express app
  });
  afterAll(async () => { if (closeDb) await closeDb(); });

  test('returns 200 { status: ok } when the DB is reachable', async () => {
    const request = require('supertest');
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
