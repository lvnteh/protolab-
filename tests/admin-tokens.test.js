// tests/admin-tokens.test.js
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();

const hasDb = !!process.env.DATABASE_URL;
jest.setTimeout(15000);
jest.resetModules();
const { initDb, closeDb, getDb } = require('../src/db');
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

  // Sign up a fresh user, then directly provision an organization with that user
  // as an ADMIN member (signup itself only yields a viewer of the Default Org
  // since P1). Logging in afterwards sets req.session.activeOrgId to the
  // most-recently-created membership — i.e. this admin org — so the returned
  // agent can hit the admin-gated token routes. Returns { agent, email, orgId, userId }.
  async function signUpAsOrgAdmin(app) {
    const userEmail = `tok-orgadmin-${nanoid(8)}@sap.com`.toLowerCase();
    await request(app).post('/admin/signup').send(`email=${userEmail}&password=${password}&confirm=${password}`);

    const { rows: userRows } = await getDb().query('SELECT id FROM users WHERE email = $1', [userEmail]);
    const userId = userRows[0].id;

    const orgId = nanoid(12);
    const now = new Date().toISOString();
    await getDb().query(
      'INSERT INTO organizations (id, name, created_at) VALUES ($1,$2,$3)',
      [orgId, `Org ${nanoid(6)}`, now]
    );
    await getDb().query(
      `INSERT INTO org_memberships (id, org_id, user_id, role, created_at) VALUES ($1,$2,$3,'admin',$4)`,
      [nanoid(12), orgId, userId, now]
    );

    const agent = request.agent(app);
    await agent.post('/admin/login').send(`email=${userEmail}&password=${password}`);
    return { agent, email: userEmail, orgId, userId };
  }

  test('generate → list → revoke lifecycle', async () => {
    const { agent } = await signUpAsOrgAdmin(app);

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

  test('a viewer is denied token routes (403)', async () => {
    // A plain signup enrols the user as a VIEWER of the Default Organization,
    // so the admin-gated token routes must reject them with 403.
    const viewerEmail = `tok-viewer-${nanoid(8)}@sap.com`.toLowerCase();
    const viewerAgent = request.agent(app);
    await viewerAgent.post('/admin/signup').send(`email=${viewerEmail}&password=${password}&confirm=${password}`);
    expect((await viewerAgent.get('/admin/tokens')).status).toBe(403);
    expect((await viewerAgent.post('/admin/tokens').send('name=nope')).status).toBe(403);
  });

  test('a user in a different org cannot revoke another org\'s token', async () => {
    // Tokens are ORG-scoped since P1: revoke only affects the caller's active org.
    // User A (an org admin) creates a token in their org.
    const { agent: agentA } = await signUpAsOrgAdmin(app);
    const gen = await agentA.post('/admin/tokens').send('name=A-token');
    const aTokenId = gen.body.id;

    // User B is an admin of a DIFFERENT org. Deleting A's token by id is an
    // idempotent no-op for B (revoke is scoped to B's org, which doesn't own it).
    const { agent: agentB } = await signUpAsOrgAdmin(app);
    const del = await agentB.delete(`/admin/tokens/${aTokenId}`);
    expect(del.status).toBe(200); // idempotent no-op for B (not B's org's token)

    // A's token survives — it was never in B's org.
    const listA = await agentA.get('/admin/tokens');
    expect(listA.body.some(t => t.id === aTokenId)).toBe(true);
  });
});
