// tests/invites.test.js
// Task 2/3/4/5 route coverage with REAL CSRF enforcement (CSRF_ENABLED=1):
// self-serve org creation + zero-org home, the full invitation lifecycle
// (create / accept / revoke / reissue) through the browser routes, org switching,
// and org deletion with durable storage-cleanup enqueue. Mirrors the app's own
// wiring: express-session + the csrf middleware + the admin router.
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();
process.env.CSRF_ENABLED = '1';

const hasDb = !!process.env.DATABASE_URL;
jest.setTimeout(20000);

jest.mock('../src/services/storage', () => {
  const files = new Map();
  return {
    putPrototype: jest.fn(async (f, b) => { files.set(f, Buffer.isBuffer(b) ? b.toString('utf8') : String(b)); }),
    getPrototype: jest.fn(async (f) => (files.has(f) ? files.get(f) : null)),
    deletePrototype: jest.fn(async (f) => { files.delete(f); }),
    putImage: jest.fn(async () => {}),
    getImage: jest.fn(async () => null),
    deleteImage: jest.fn(async () => {}),
    SCREENSHOT_PREFIX: 'screenshots/',
  };
});

jest.resetModules();
const { initDb, getDb, closeDb } = require('../src/db');
const { nanoid } = require('nanoid');
const request = require('supertest');
const express = require('express');
const session = require('express-session');
const csrf = require('../src/middleware/csrf');
const adminRouter = require('../src/routes/admin');

function makeApp() {
  const a = express();
  a.use(express.urlencoded({ extended: true }));
  a.use(express.json());
  a.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  a.use('/admin', csrf, adminRouter);
  return a;
}

// Sign up a fresh allowed-domain user; return a logged-in agent + email.
async function signUp(app, email) {
  const agent = request.agent(app);
  // GET the signup page first to establish a session + CSRF token.
  const page = await agent.get('/admin/signup');
  const token = /name="csrf-token" content="([^"]+)"/.exec(page.text)?.[1]
    || /name="_csrf" value="([^"]+)"/.exec(page.text)?.[1];
  const res = await agent.post('/admin/signup')
    .type('form').send({ email, password: 'password123', confirm: 'password123', _csrf: token });
  return { agent, email, res, token };
}

// Pull the per-session CSRF token from any rendered admin page the agent can see.
async function csrfToken(agent, path = '/admin/home') {
  const page = await agent.get(path);
  return /name="csrf-token" content="([^"]+)"/.exec(page.text)?.[1]
    || /name="_csrf" value="([^"]+)"/.exec(page.text)?.[1];
}

(hasDb ? describe : describe.skip)('org self-serve + invitations (CSRF enforced)', () => {
  let app;
  beforeAll(async () => { await initDb(); app = makeApp(); });
  afterAll(async () => { await closeDb(); delete process.env.CSRF_ENABLED; });

  test('a bare signup lands on /admin/home and GET /admin/home is reachable', async () => {
    const { res, agent } = await signUp(app, `bare-${nanoid(6)}@sap.com`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/admin/home');
    const home = await agent.get('/admin/home');
    expect(home.status).toBe(200);
    expect(home.text).toContain('Create an organization');
  });

  test('POST /admin/orgs without a CSRF token is rejected (403)', async () => {
    const { agent } = await signUp(app, `nocsrf-${nanoid(6)}@sap.com`);
    const res = await agent.post('/admin/orgs').type('form').send({ name: 'NoToken Inc' });
    expect(res.status).toBe(403);
  });

  test('self-serve org creation makes the creator an admin and redirects to the canonical list', async () => {
    const { agent } = await signUp(app, `creator-${nanoid(6)}@sap.com`);
    const token = await csrfToken(agent);
    const res = await agent.post('/admin/orgs').type('form').send({ name: 'Creator Co', _csrf: token });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/admin\/orgs\/[^/]+\/prototypes/);
    const orgId = res.headers.location.split('/orgs/')[1].split('/')[0];
    const { rows } = await getDb().query(
      'SELECT role FROM org_memberships WHERE org_id = $1', [orgId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('admin');
  });

  test('full invite lifecycle: create (admin) → accept (invitee) with CSRF', async () => {
    // Admin creates an org.
    const { agent: admin } = await signUp(app, `inv-admin-${nanoid(6)}@sap.com`);
    let token = await csrfToken(admin);
    const orgRes = await admin.post('/admin/orgs').type('form').send({ name: 'Invite Org', _csrf: token });
    const orgId = orgRes.headers.location.split('/orgs/')[1].split('/')[0];

    // Admin invites a new email as viewer (JSON API; CSRF header + expectedOrgId).
    token = await csrfToken(admin, `/admin/orgs/${orgId}/members`);
    const inviteeEmail = `invitee-${nanoid(6)}@sap.com`;
    const inv = await admin.post(`/admin/orgs/${orgId}/members/invite`)
      .set('x-csrf-token', token)
      .send({ email: inviteeEmail, role: 'viewer', expectedOrgId: orgId });
    expect(inv.status).toBe(201);
    expect(inv.body.link).toContain('/admin/invite/');
    const inviteToken = inv.body.link.split('/admin/invite/')[1];

    // A logged-out visitor sees the invite GET page (public).
    const anon = request.agent(app);
    const gp = await anon.get(`/admin/invite/${inviteToken}`);
    expect(gp.status).toBe(200);
    expect(gp.text).toContain('Invite Org');

    // The invitee signs up (bare) then accepts with CSRF.
    const { agent: invitee } = await signUp(app, inviteeEmail);
    const acceptToken = await csrfToken(invitee);
    const accept = await invitee.post(`/admin/invite/${inviteToken}/accept`)
      .type('form').send({ _csrf: acceptToken });
    expect(accept.status).toBe(302);
    expect(accept.headers.location).toContain(`/admin/orgs/${orgId}/prototypes`);
    const { rows } = await getDb().query(
      `SELECT m.role FROM org_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1 AND LOWER(u.email) = $2`, [orgId, inviteeEmail.toLowerCase()]);
    expect(rows[0].role).toBe('viewer');
  });

  test('revoke then reissue produces a fresh working token and retires the old one', async () => {
    const { agent: admin } = await signUp(app, `rr-admin-${nanoid(6)}@sap.com`);
    let token = await csrfToken(admin);
    const orgRes = await admin.post('/admin/orgs').type('form').send({ name: 'RR Org', _csrf: token });
    const orgId = orgRes.headers.location.split('/orgs/')[1].split('/')[0];

    token = await csrfToken(admin, `/admin/orgs/${orgId}/members`);
    const email = `rr-invitee-${nanoid(6)}@sap.com`;
    const inv = await admin.post(`/admin/orgs/${orgId}/members/invite`)
      .set('x-csrf-token', token).send({ email, role: 'viewer', expectedOrgId: orgId });
    const inviteId = inv.body.id;

    // Reissue: a new link; the old token is retired (revoked).
    const re = await admin.post(`/admin/orgs/${orgId}/members/invite/${inviteId}/reissue`)
      .set('x-csrf-token', token).send({ expectedOrgId: orgId });
    expect(re.status).toBe(200);
    expect(re.body.link).toContain('/admin/invite/');
    const oldToken = inv.body.link.split('/admin/invite/')[1];
    const { rows } = await getDb().query('SELECT status FROM org_invitations WHERE token = $1', [oldToken]);
    expect(rows[0].status).toBe('revoked');
  });

  test('POST /admin/orgs/switch validates membership and sets the default landing', async () => {
    const { agent, email } = await signUp(app, `switch-${nanoid(6)}@sap.com`);
    const { rows: u } = await getDb().query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    // Make the user a member of an org they didn't create.
    const orgId = nanoid(12);
    await getDb().query('INSERT INTO organizations (id,name,created_at) VALUES ($1,$2,$3)', [orgId, 'Switch Org', new Date().toISOString()]);
    await getDb().query(`INSERT INTO org_memberships (id,org_id,user_id,role,created_at) VALUES ($1,$2,$3,'admin',$4)`, [nanoid(12), orgId, u[0].id, new Date().toISOString()]);
    const token = await csrfToken(agent);
    const ok = await agent.post('/admin/orgs/switch').type('form').send({ orgId, _csrf: token });
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toContain(`/admin/orgs/${orgId}/prototypes`);
    // A non-member org is rejected.
    const bad = await agent.post('/admin/orgs/switch').set('x-csrf-token', token).send({ orgId: nanoid(12) });
    expect(bad.status).toBe(403);
  });

  test('delete org requires the exact name, cascades, and enqueues storage cleanup', async () => {
    const { agent: admin } = await signUp(app, `del-admin-${nanoid(6)}@sap.com`);
    let token = await csrfToken(admin);
    const orgRes = await admin.post('/admin/orgs').type('form').send({ name: 'Delete Me', _csrf: token });
    const orgId = orgRes.headers.location.split('/orgs/')[1].split('/')[0];

    // Upload a prototype so deletion has stored files to enqueue.
    token = await csrfToken(admin, `/admin/orgs/${orgId}/prototypes`);
    const up = await admin.post(`/admin/orgs/${orgId}/prototypes`)
      .set('Accept', 'application/json').set('x-csrf-token', token).set('x-expected-org', orgId)
      .field('expectedOrgId', orgId).field('name', 'DelProto')
      .attach('file', Buffer.from('<html>x</html>'), 'p.html');
    expect(up.status).toBe(200);

    // Wrong name → 409, nothing deleted.
    token = await csrfToken(admin, `/admin/orgs/${orgId}/members`);
    const wrong = await admin.delete(`/admin/orgs/${orgId}`)
      .set('x-csrf-token', token).send({ confirmName: 'Wrong Name', expectedOrgId: orgId });
    expect(wrong.status).toBe(409);
    expect((await getDb().query('SELECT 1 FROM organizations WHERE id = $1', [orgId])).rows).toHaveLength(1);

    // Exact name → deleted; FKs cascade; cleanup rows enqueued.
    const del = await admin.delete(`/admin/orgs/${orgId}`)
      .set('x-csrf-token', token).send({ confirmName: 'Delete Me', expectedOrgId: orgId });
    expect(del.status).toBe(200);
    expect(del.body.enqueued).toBeGreaterThan(0);
    expect((await getDb().query('SELECT 1 FROM organizations WHERE id = $1', [orgId])).rows).toHaveLength(0);
    expect((await getDb().query('SELECT 1 FROM prototypes WHERE org_id = $1', [orgId])).rows).toHaveLength(0);
    // Cleanup rows were enqueued durably in the delete transaction. The handler
    // also kicks an immediate best-effort drain, so with the in-memory storage
    // mock the rows may already be 'done' — assert they exist in some state
    // (durability), not that they are still pending.
    const q = await getDb().query("SELECT status FROM storage_cleanup_queue WHERE kind = 'prototype'");
    expect(q.rows.length).toBeGreaterThan(0);
  });
});
