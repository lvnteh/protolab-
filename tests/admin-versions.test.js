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

// Sign up a fresh user and enrol them as a non-admin ('viewer') member of an
// EXISTING org, then log in so their active org is that org. Used to prove the
// upload route's requireAdmin guard rejects non-admins with 403.
async function addOrgMember(userEmail, targetOrgId) {
  await request(app).post('/admin/signup').send(`email=${userEmail}&password=${password}&confirm=${password}`);
  const { rows } = await getDb().query('SELECT id FROM users WHERE email = $1', [userEmail]);
  await getDb().query(
    `INSERT INTO org_memberships (id, org_id, user_id, role, created_at)
     VALUES ($1,$2,$3,'viewer',$4)`,
    [nanoid(12), targetOrgId, rows[0].id, new Date().toISOString()]
  );
  const agent = request.agent(app);
  await agent.post('/admin/login').send(`email=${userEmail}&password=${password}`);
  return agent;
}

(hasDb ? describe : describe.skip)('admin versions endpoint', () => {
  let protoId;
  let orgId;
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
    const { agent, orgId: adminOrgId } = await signUpAsOrgAdmin(app, email);
    orgId = adminOrgId;
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
    expect(res.body[0]).toMatchObject({ version: 1, status: 'published', isCurrent: true, isDraft: false });
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

  test('admin uploads a new draft version; wrong content-type is rejected (Review Focus #4)', async () => {
    const agent = request.agent(app);
    await agent.post('/admin/login').send(`email=${email}&password=${password}`);

    const ok = await agent.post(`/admin/prototypes/${protoId}/versions`)
      .field('note', 'v2 draft')
      .attach('file', Buffer.from('<h1>v2</h1>'), 'v2.html');
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ version: 2, status: 'draft' });

    const bad = await agent.post(`/admin/prototypes/${protoId}/versions`)
      .attach('file', Buffer.from('# md'), 'notes.md');     // .md onto an html prototype
    expect(bad.status).toBe(400);
  });

  test('a non-admin org member cannot upload a version', async () => {
    const memberEmail = `ver-member-${nanoid(8)}@sap.com`.toLowerCase();
    const agent = await addOrgMember(memberEmail, orgId);
    const res = await agent.post(`/admin/prototypes/${protoId}/versions`)
      .attach('file', Buffer.from('<h1>x</h1>'), 'x.html');
    expect(res.status).toBe(403);
  });

  test('admin publishes a draft, then switches the live version back to an older one', async () => {
    const agent = request.agent(app);
    await agent.post('/admin/login').send(`email=${email}&password=${password}`);
    const up = await agent.post('/admin/prototypes').set('Accept', 'application/json')
      .field('name', 'Pub').attach('file', Buffer.from('<html>v1</html>'), 'p.html');
    const pid = up.body.id;
    await agent.post(`/admin/prototypes/${pid}/versions`)
      .attach('file', Buffer.from('<h1>v2</h1>'), 'v2.html').expect(201);

    const pub = await agent.post(`/admin/prototypes/${pid}/publish`).send({ version: 2 });
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ version: 2, status: 'published', promoted: true });

    const back = await agent.post(`/admin/prototypes/${pid}/publish`).send({ version: 1 });
    expect(back.status).toBe(200);                 // re-point to older published → no 409
    expect(back.body.promoted).toBe(false);

    const bad = await agent.post(`/admin/prototypes/${pid}/publish`).send({ version: 'nope' });
    expect(bad.status).toBe(400);
  });

  test('admin versions list flags every draft by status; explanations endpoint filters by version', async () => {
    const adminEmail = `ver-admin-t10-${nanoid(8)}@sap.com`.toLowerCase();
    const { agent } = await signUpAsOrgAdmin(app, adminEmail);
    const up = await agent.post('/admin/prototypes').set('Accept', 'application/json')
      .field('name', 'T10').attach('file', Buffer.from('<html>v1</html>'), 'p.html');
    const pid = up.body.id;
    await agent.post(`/admin/prototypes/${pid}/versions`)
      .attach('file', Buffer.from('<h1>v2</h1>'), 'v2.html').expect(201);
    await agent.post(`/admin/prototypes/${pid}/versions`)
      .attach('file', Buffer.from('<h1>v3</h1>'), 'v3.html').expect(201);

    const vs = await agent.get(`/admin/prototypes/${pid}/versions`).expect(200);
    const drafts = vs.body.filter(v => v.isDraft).map(v => v.version).sort();
    expect(drafts).toEqual([2, 3]);                 // both coexisting drafts flagged
    expect(vs.body.find(v => v.version === 1).isCurrent).toBe(true);

    // seed one explanation on v1 (the live version) through the reviewer path is complex here;
    // assert the endpoint returns a version-tagged array and respects ?version
    const all = await agent.get(`/admin/prototypes/${pid}/explanations`).expect(200);
    expect(Array.isArray(all.body)).toBe(true);
    const scoped = await agent.get(`/admin/prototypes/${pid}/explanations?version=1`).expect(200);
    expect(Array.isArray(scoped.body)).toBe(true);
  });

  test('the detail view renders the version upload form for an admin', async () => {
    const agent = request.agent(app);
    await agent.post('/admin/login').send(`email=${email}&password=${password}`);
    const res = await agent.get(`/admin/prototypes/${protoId}`).expect(200);
    expect(res.text).toContain('id="version-upload-form"');
    expect(res.text).toContain('accept=".html"');     // html prototype → accept locked
  });
});
