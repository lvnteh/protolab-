// tests/admin-versions.test.js
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
const session = require('express-session');
const adminRouter = require('../src/routes/admin');

let app;
const email = `ver-admin-${nanoid(8)}@sap.com`.toLowerCase();
const emailB = `ver-admin-b-${nanoid(8)}@sap.com`.toLowerCase();
const password = 'password123';

(hasDb ? describe : describe.skip)('admin versions endpoint', () => {
  let protoId;
  beforeAll(async () => {
    await initDb();
    app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    app.use('/admin', adminRouter);
    await request(app).post('/admin/signup').send(`email=${email}&password=${password}&confirm=${password}`);
    await request(app).post('/admin/signup').send(`email=${emailB}&password=${password}&confirm=${password}`);

    const agent = request.agent(app);
    await agent.post('/admin/login').send(`email=${email}&password=${password}`);
    const up = await agent.post('/admin/prototypes').set('Accept', 'application/json')
      .field('name', 'Ver').attach('file', Buffer.from('<html>v1</html>'), 'p.html');
    protoId = up.body.id;
  });
  afterAll(async () => { await closeDb(); });

  test('owner sees version history newest-first', async () => {
    const agent = request.agent(app);
    await agent.post('/admin/login').send(`email=${email}&password=${password}`);
    const res = await agent.get(`/admin/prototypes/${protoId}/versions`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject({ version: 1, status: 'published', isPublished: true, isDraft: false });
  });

  test('another user gets 404 (owner-scoped)', async () => {
    const agentB = request.agent(app);
    await agentB.post('/admin/login').send(`email=${emailB}&password=${password}`);
    const res = await agentB.get(`/admin/prototypes/${protoId}/versions`);
    expect(res.status).toBe(404);
  });

  test('requires a session', async () => {
    expect((await request(app).get(`/admin/prototypes/${protoId}/versions`)).status).toBe(302);
  });
});
