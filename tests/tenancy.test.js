// tests/tenancy.test.js
const path = require('path');
const os = require('os');
const fs = require('fs');
process.env.UPLOADS_PATH = os.tmpdir();
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_EMAIL = 'admin@sap.com';

const bcrypt = require('bcryptjs');
process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync('secret', 10);

const hasDb = !!process.env.DATABASE_URL;

// Mock Supabase Storage with an in-memory store so upload/read/delete work
// without live Supabase credentials. Behaves like the real module: getPrototype
// returns what putPrototype stored, or null if absent.
jest.mock('../src/services/storage', () => {
  const files = new Map();
  return {
    putPrototype: jest.fn(async (filename, body) => {
      files.set(filename, Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
    }),
    getPrototype: jest.fn(async (filename) => (files.has(filename) ? files.get(filename) : null)),
    deletePrototype: jest.fn(async (filename) => { files.delete(filename); }),
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
let tmpHtml;

function makeApp() {
  const a = express();
  a.use(express.urlencoded({ extended: true }));
  a.use(express.json());
  a.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  a.use('/admin', adminRouter);
  return a;
}

// Sign up a fresh user with a unique allowed-domain email and return a
// logged-in agent plus the email used. NOTE: under the P1 org model a fresh
// signup joins the Default Organization as a *viewer* (read+comment only).
async function signUp(app) {
  const email = `user-${nanoid(8)}@sap.com`.toLowerCase();
  const agent = request.agent(app);
  const res = await agent.post('/admin/signup').send(`email=${email}&password=password123&confirm=password123`);
  return { agent, email, res };
}

// Sign up a user, then provision them as ADMIN of their OWN fresh organization
// (org creation is admin-provisioned in this phase, so we seed it directly),
// and log them back in so the session's activeOrgId points at that org. This is
// the fixture for "an org admin who can create/manage prototypes", and — because
// each call makes a *separate* org — for cross-tenant isolation between orgs.
async function signUpAsOrgAdmin(app) {
  const { email } = await signUp(app);
  const { rows: u } = await getDb().query('SELECT id FROM users WHERE email = $1', [email]);
  const userId = u[0].id;
  const orgId = nanoid(12);
  await getDb().query('INSERT INTO organizations (id, name, created_at) VALUES ($1,$2,$3)',
    [orgId, `Org ${orgId}`, new Date().toISOString()]);
  await getDb().query(
    `INSERT INTO org_memberships (id, org_id, user_id, role, created_at) VALUES ($1,$2,$3,'admin',$4)`,
    [nanoid(12), orgId, userId, new Date().toISOString()]);
  // Re-login so activeOrgId = most-recently-created membership = this admin org.
  const agent = request.agent(app);
  await agent.post('/admin/login').send(`email=${email}&password=password123`);
  return { agent, email, userId, orgId };
}

(hasDb ? describe : describe.skip)('multi-tenancy', () => {
  beforeAll(async () => {
    await initDb();
    app = makeApp();
    tmpHtml = path.join(os.tmpdir(), `proto-${nanoid(6)}.html`);
    fs.writeFileSync(tmpHtml, '<!doctype html><html><body>hi</body></html>');
  });

  afterAll(async () => {
    if (tmpHtml && fs.existsSync(tmpHtml)) fs.unlinkSync(tmpHtml);
    await closeDb();
  });

  describe('signup validation', () => {
    test('rejects a disallowed email domain and creates no user', async () => {
      const email = `nope-${nanoid(8)}@gmail.com`;
      const res = await request(app).post('/admin/signup').send(`email=${email}&password=password123&confirm=password123`);
      expect(res.status).toBe(400);
      const { rows } = await getDb().query('SELECT 1 FROM users WHERE email = $1', [email.toLowerCase()]);
      expect(rows).toHaveLength(0);
    });

    test('rejects a password shorter than 8 characters', async () => {
      const email = `short-${nanoid(8)}@sap.com`;
      const res = await request(app).post('/admin/signup').send(`email=${email}&password=abc&confirm=abc`);
      expect(res.status).toBe(400);
      const { rows } = await getDb().query('SELECT 1 FROM users WHERE email = $1', [email.toLowerCase()]);
      expect(rows).toHaveLength(0);
    });

    test('rejects mismatched password confirmation', async () => {
      const email = `mismatch-${nanoid(8)}@sap.com`;
      const res = await request(app).post('/admin/signup').send(`email=${email}&password=password123&confirm=password124`);
      expect(res.status).toBe(400);
      const { rows } = await getDb().query('SELECT 1 FROM users WHERE email = $1', [email.toLowerCase()]);
      expect(rows).toHaveLength(0);
    });

    test('rejects a duplicate email with 409', async () => {
      const email = `dup-${nanoid(8)}@sap.com`.toLowerCase();
      const first = await request(app).post('/admin/signup').send(`email=${email}&password=password123&confirm=password123`);
      expect(first.status).toBe(302);
      const second = await request(app).post('/admin/signup').send(`email=${email}&password=password123&confirm=password123`);
      expect(second.status).toBe(409);
      const { rows } = await getDb().query('SELECT 1 FROM users WHERE email = $1', [email]);
      expect(rows).toHaveLength(1);
    });

    test('succeeds and stores a bcrypt hash (not plaintext)', async () => {
      const { email, res } = await signUp(app);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('prototypes');
      const { rows } = await getDb().query('SELECT password_hash FROM users WHERE email = $1', [email]);
      expect(rows).toHaveLength(1);
      expect(rows[0].password_hash).not.toBe('password123');
      expect(bcrypt.compareSync('password123', rows[0].password_hash)).toBe(true);
    });
  });

  describe('login by email', () => {
    test('a signed-up user can log in via email + password', async () => {
      const { email } = await signUp(app);
      const res = await request(app).post('/admin/login').send(`email=${email}&password=password123`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('prototypes');
    });
  });

  describe('ownership on upload', () => {
    test('a new prototype is owned by the uploading user', async () => {
      const { agent, email } = await signUpAsOrgAdmin(app);
      const res = await agent
        .post('/admin/prototypes')
        .set('Accept', 'application/json')
        .field('name', 'Owned Proto')
        .attach('file', tmpHtml);
      expect(res.status).toBe(200);
      const { id } = res.body;
      const { rows: userRows } = await getDb().query('SELECT id FROM users WHERE email = $1', [email]);
      const { rows: protoRows } = await getDb().query('SELECT owner_id FROM prototypes WHERE id = $1', [id]);
      expect(protoRows[0].owner_id).toBe(userRows[0].id);
    });

    test('a viewer (fresh signup) cannot upload a prototype', async () => {
      // Ensure a Default Organization exists so the signup enrols as a viewer.
      await getDb().query(
        `INSERT INTO organizations (id, name, created_at)
         SELECT $1,'Default Organization',$2
         WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE name = 'Default Organization')`,
        [nanoid(12), new Date().toISOString()]);
      const { agent } = await signUp(app);
      const res = await agent
        .post('/admin/prototypes')
        .set('Accept', 'application/json')
        .field('name', 'Viewer Upload')
        .attach('file', tmpHtml);
      expect(res.status).toBe(403);
    });
  });

  describe('v1 version on upload', () => {
    test('uploading a prototype immediately creates a published v1 version', async () => {
      const { agent } = await signUpAsOrgAdmin(app);
      const up = await agent
        .post('/admin/prototypes')
        .set('Accept', 'application/json')
        .field('name', 'V1 Check')
        .attach('file', Buffer.from('<html>orig</html>'), 'p.html');
      expect(up.status).toBe(200);
      const protoId = up.body.id;

      const { rows } = await getDb().query(
        'SELECT version, status FROM prototype_versions WHERE prototype_id = $1', [protoId]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ version: 1, status: 'published' });
      const { rows: p } = await getDb().query(
        'SELECT published_version_id FROM prototypes WHERE id = $1', [protoId]);
      expect(p[0].published_version_id).toBeTruthy();
    });
  });

  describe('cross-tenant isolation', () => {
    test('user B cannot see, open, or delete user A\'s prototype', async () => {
      // A uploads a prototype
      const { agent: agentA } = await signUpAsOrgAdmin(app);
      const upload = await agentA
        .post('/admin/prototypes')
        .set('Accept', 'application/json')
        .field('name', 'A Private')
        .attach('file', tmpHtml);
      const protoIdA = upload.body.id;

      // B signs up separately
      const { agent: agentB } = await signUpAsOrgAdmin(app);

      // B cannot open A's prototype detail -> 404
      const detail = await agentB.get(`/admin/prototypes/${protoIdA}`);
      expect(detail.status).toBe(404);

      // B cannot delete A's prototype -> 404, and it still exists
      const del = await agentB.delete(`/admin/prototypes/${protoIdA}`);
      expect(del.status).toBe(404);
      const { rows: stillThere } = await getDb().query('SELECT 1 FROM prototypes WHERE id = $1', [protoIdA]);
      expect(stillThere).toHaveLength(1);

      // A's prototype does not appear in B's list
      const list = await agentB.get('/admin/prototypes');
      expect(list.status).toBe(200);
      expect(list.text).not.toContain(protoIdA);

      // ...but it DOES appear in A's list
      const listA = await agentA.get('/admin/prototypes');
      expect(listA.text).toContain(protoIdA);
    });

    test('scoped sub-resources (funnels, access-log, comments) 404 across tenants', async () => {
      const { agent: agentA } = await signUpAsOrgAdmin(app);
      const upload = await agentA
        .post('/admin/prototypes')
        .set('Accept', 'application/json')
        .field('name', 'A Analytics')
        .attach('file', tmpHtml);
      const protoIdA = upload.body.id;

      const { agent: agentB } = await signUpAsOrgAdmin(app);
      expect((await agentB.get(`/admin/prototypes/${protoIdA}/funnels`)).status).toBe(404);
      expect((await agentB.get(`/admin/prototypes/${protoIdA}/allowlist-count`)).status).toBe(404);
      expect((await agentB.post(`/admin/prototypes/${protoIdA}/access-log`).send({})).status).toBe(404);
      expect((await agentB.post(`/admin/prototypes/${protoIdA}/comments`).send({})).status).toBe(404);
    });
  });

  describe('storage cleanup on delete', () => {
    test('deleting a prototype removes ALL its version files from storage', async () => {
      const storage = require('../src/services/storage');
      const versions = require('../src/services/versions');
      const { agent } = await signUpAsOrgAdmin(app);

      // Upload → creates prototype + published v1 file
      const up = await agent
        .post('/admin/prototypes')
        .set('Accept', 'application/json')
        .field('name', 'DelTest')
        .attach('file', Buffer.from('<html>v1</html>'), 'p.html');
      expect(up.status).toBe(200);
      const protoId = up.body.id;

      const { rows: v1rows } = await getDb().query(
        'SELECT filename FROM prototype_versions WHERE prototype_id = $1', [protoId]);
      const v1file = v1rows[0].filename;

      // Push a v2 draft: store a second file and insert a version row
      const v2file = `${protoId}-v2.html`;
      await storage.putPrototype(v2file, '<html>v2</html>');
      await versions.createDraft(protoId, v2file, 'v2');

      // Sanity: both files present in the mock store
      expect(await storage.getPrototype(v1file)).not.toBeNull();
      expect(await storage.getPrototype(v2file)).not.toBeNull();

      // Delete the prototype
      const del = await agent.delete(`/admin/prototypes/${protoId}`);
      expect(del.status).toBe(200);
      expect(del.body).toEqual({ ok: true });

      // Both version files must be gone from storage
      expect(await storage.getPrototype(v1file)).toBeNull();
      expect(await storage.getPrototype(v2file)).toBeNull();
    });
  });
});
