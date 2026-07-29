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

// Sign up a fresh user and make them an ADMIN of their own org (P1 multi-tenancy).
// A plain signup only enrols the user as a VIEWER of the Default Organization, which
// cannot upload prototypes (POST /admin/prototypes is requireAdmin). So we directly
// INSERT a dedicated organization + an 'admin' org_membership for the user, then log
// in so the session's activeOrgId points at that org (defaultOrgId picks the newest
// membership). The returned agent is an admin member of orgId and can upload + read.
async function signUpAsOrgAdmin(a, userEmail) {
  await request(a).post('/admin/signup').send(`email=${userEmail}&password=${password}&confirm=${password}`);
  const { rows: userRows } = await getDb().query('SELECT id FROM users WHERE email = $1', [userEmail]);
  const userId = userRows[0].id;
  const orgId = nanoid(12);
  const now = new Date().toISOString();
  await getDb().query(
    'INSERT INTO organizations (id, name, created_at) VALUES ($1,$2,$3)',
    [orgId, `Org ${userEmail}`, now]
  );
  await getDb().query(
    `INSERT INTO org_memberships (id, org_id, user_id, role, created_at)
     VALUES ($1,$2,$3,'admin',$4)`,
    [nanoid(12), orgId, userId, now]
  );
  const agent = request.agent(a);
  await agent.post('/admin/login').send(`email=${userEmail}&password=${password}`);
  return { agent, email: userEmail, orgId, userId };
}

(hasDb ? describe : describe.skip)('admin versions endpoint', () => {
  let protoId;
  beforeAll(async () => {
    await initDb();
    app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    app.use('/admin', adminRouter);

    // User A: admin of their own org, so the upload (requireAdmin) succeeds and the
    // new prototype is stamped with that org's id. The same agent is a member of the
    // org, so it can read the version history.
    const { agent } = await signUpAsOrgAdmin(app, email);
    // User B: a plain signup (viewer of the Default Organization, NOT of A's org),
    // used by the "another user gets 404" test.
    await request(app).post('/admin/signup').send(`email=${emailB}&password=${password}&confirm=${password}`);

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
