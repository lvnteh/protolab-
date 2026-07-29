// tests/conflict.test.js
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();

const hasDb = !!process.env.DATABASE_URL;
jest.setTimeout(15000);

jest.mock('../src/services/storage', () => {
  const files = new Map();
  return {
    putPrototype: jest.fn(async (f, b) => { files.set(f, Buffer.isBuffer(b) ? b.toString('utf8') : String(b)); }),
    getPrototype: jest.fn(async (f) => (files.has(f) ? files.get(f) : null)),
    deletePrototype: jest.fn(async (f) => { files.delete(f); }),
  };
});

jest.resetModules();
const { initDb, getDb, closeDb } = require('../src/db');
const { nanoid } = require('nanoid');
const request = require('supertest');
const express = require('express');
const apiV1Router = require('../src/routes/apiV1');
const tokens = require('../src/services/tokens');

let app, userId, protoId, rawToken;

(hasDb ? describe : describe.skip)('versions endpoints', () => {
  beforeAll(async () => {
    await initDb();
    app = express();
    app.use(express.json());
    app.use('/api/v1', apiV1Router);

    userId = nanoid(12);
    await getDb().query('INSERT INTO users (id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)',
      [userId, `cf-${userId}@sap.com`, 'x', new Date().toISOString()]);
    ({ raw: rawToken } = await tokens.createToken(userId, 't'));

    protoId = nanoid(12);
    await getDb().query(
      'INSERT INTO prototypes (id,name,filename,share_token,created_at,owner_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [protoId, 'CF', `${protoId}.html`, nanoid(12), new Date().toISOString(), userId]);
    await initDb(); // backfill v1 + publish it
    const storage = require('../src/services/storage');
    await storage.putPrototype(`${protoId}.html`, '<html>v1</html>');
  });
  afterAll(async () => { await closeDb(); });

  const auth = () => ({ Authorization: `Bearer ${rawToken}` });

  test('GET /source returns the published HTML', async () => {
    const res = await request(app).get(`/api/v1/prototypes/${protoId}/source`).set(auth());
    expect(res.status).toBe(200);
    expect(res.text).toContain('v1');
  });

  test('push with correct baseVersion creates a draft (v2)', async () => {
    const res = await request(app).post(`/api/v1/prototypes/${protoId}/versions`).set(auth())
      .field('baseVersion', '1').field('note', 'fix')
      .attach('file', Buffer.from('<html>v2</html>'), 'edit.html');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ version: 2, status: 'draft' });
  });

  test('share link still serves v1 (draft is not published)', async () => {
    const res = await request(app).get(`/api/v1/prototypes/${protoId}/source`).set(auth());
    expect(res.text).toContain('v1'); // unchanged
  });

  test('stale push (baseVersion=1 again, latest is now 2) returns 409', async () => {
    const res = await request(app).post(`/api/v1/prototypes/${protoId}/versions`).set(auth())
      .field('baseVersion', '1')
      .attach('file', Buffer.from('<html>v3</html>'), 'edit.html');
    expect(res.status).toBe(409);
    expect(res.body.currentVersion).toBe(2);
  });

  test('publish v2 makes /source serve v2', async () => {
    const pub = await request(app).post(`/api/v1/prototypes/${protoId}/publish`).set(auth())
      .send({ version: 2 });
    expect(pub.status).toBe(200);
    const res = await request(app).get(`/api/v1/prototypes/${protoId}/source`).set(auth());
    expect(res.text).toContain('v2');
  });

  test('publishing an already-published version returns 409', async () => {
    const res = await request(app).post(`/api/v1/prototypes/${protoId}/publish`).set(auth())
      .send({ version: 2 });
    expect(res.status).toBe(409);
  });
});
