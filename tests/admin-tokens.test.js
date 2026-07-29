// tests/admin-tokens.test.js
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();

const hasDb = !!process.env.DATABASE_URL;
jest.setTimeout(15000);
jest.resetModules();
const { initDb, closeDb } = require('../src/db');
const { nanoid } = require('nanoid');
const request = require('supertest');
const express = require('express');
const session = require('express-session');
const adminRouter = require('../src/routes/admin');

let app;
const email = `tok-admin-${nanoid(8)}@sap.com`.toLowerCase();
const password = 'password123';

(hasDb ? describe : describe.skip)('admin token management', () => {
  beforeAll(async () => {
    await initDb();
    app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    app.use('/admin', adminRouter);
    await request(app).post('/admin/signup').send(`email=${email}&password=${password}&confirm=${password}`);
  });
  afterAll(async () => { await closeDb(); });

  test('generate → list → revoke lifecycle', async () => {
    const agent = request.agent(app);
    await agent.post('/admin/login').send(`email=${email}&password=${password}`);

    const gen = await agent.post('/admin/tokens').send('name=laptop');
    expect(gen.status).toBe(201);
    expect(gen.body.token).toBeTruthy();      // raw shown once
    const tokenId = gen.body.id;

    const list = await agent.get('/admin/tokens');
    expect(list.status).toBe(200);
    expect(list.body.some(t => t.id === tokenId)).toBe(true);
    expect(JSON.stringify(list.body)).not.toContain(gen.body.token); // secret never re-listed

    const del = await agent.delete(`/admin/tokens/${tokenId}`);
    expect(del.status).toBe(200);
    const list2 = await agent.get('/admin/tokens');
    expect(list2.body.some(t => t.id === tokenId)).toBe(false);
  });

  test('token endpoints require admin session', async () => {
    expect((await request(app).get('/admin/tokens')).status).toBe(302);
  });

  test('a user cannot revoke another user\'s token', async () => {
    // User A (the beforeAll account) creates a token.
    const agentA = request.agent(app);
    await agentA.post('/admin/login').send(`email=${email}&password=${password}`);
    const gen = await agentA.post('/admin/tokens').send('name=A-token');
    const aTokenId = gen.body.id;

    // User B signs up and tries to revoke A's token by id.
    const emailB = `tok-admin-b-${nanoid(8)}@sap.com`.toLowerCase();
    const agentB = request.agent(app);
    await agentB.post('/admin/signup').send(`email=${emailB}&password=${password}&confirm=${password}`);
    const del = await agentB.delete(`/admin/tokens/${aTokenId}`);
    expect(del.status).toBe(200); // idempotent no-op for B (not B's token)

    // A's token is still there.
    const listA = await agentA.get('/admin/tokens');
    expect(listA.body.some(t => t.id === aTokenId)).toBe(true);
  });
});
