// tests/orgs.test.js — P1 organization multi-tenancy: migration, roles, isolation.
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();

const hasDb = !!process.env.DATABASE_URL;

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

const { initDb, getDb, closeDb, cleanDb } = require('../src/db');
const { nanoid } = require('nanoid');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const express = require('express');
const session = require('express-session');
const adminRouter = require('../src/routes/admin');

function makeApp() {
  const a = express();
  a.use(express.urlencoded({ extended: true }));
  a.use(express.json());
  a.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  a.use('/admin', adminRouter);
  return a;
}

// Create a user row directly and return its id. Email is lowercased to match
// the login route's normalization (it does email.trim().toLowerCase()).
async function mkUser(email) {
  const id = nanoid(12);
  await getDb().query('INSERT INTO users (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)',
    [id, email.toLowerCase(), bcrypt.hashSync('password123', 10), new Date().toISOString()]);
  return id;
}
async function mkOrg(name) {
  const id = nanoid(12);
  await getDb().query('INSERT INTO organizations (id, name, created_at) VALUES ($1,$2,$3)',
    [id, name, new Date().toISOString()]);
  return id;
}
async function addMember(orgId, userId, role) {
  await getDb().query(
    'INSERT INTO org_memberships (id, org_id, user_id, role, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (org_id,user_id) DO UPDATE SET role = $4',
    [nanoid(12), orgId, userId, role, new Date().toISOString()]);
}
// Log a user in via the real route so the session (userId + activeOrgId) is set.
async function login(app, email) {
  const agent = request.agent(app);
  await agent.post('/admin/login').send(`email=${email.toLowerCase()}&password=password123`);
  return agent;
}
async function mkPrototype(orgId, ownerId, name = 'P') {
  const id = nanoid(12);
  const filename = `${id}.html`;
  await getDb().query(
    'INSERT INTO prototypes (id, name, filename, share_token, created_at, owner_id, org_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, name, filename, nanoid(12), new Date().toISOString(), ownerId, orgId]);
  return id;
}

(hasDb ? describe : describe.skip)('org multi-tenancy', () => {
  beforeAll(async () => { await initDb(); });
  afterAll(async () => { await closeDb(); });

  describe('migration', () => {
    // The org migration is marker-guarded and idempotent; it folds legacy data
    // into one Default Organization. We simulate a legacy state (users +
    // prototypes with NULL org_id, marker removed) and re-run initDb.
    test('folds legacy users + prototypes into one Default Organization', async () => {
      await cleanDb();
      await getDb().query('DELETE FROM schema_migrations WHERE name = $1', ['org-multitenancy-v1']);
      // Legacy: two users, two prototypes with NO org_id.
      const u1 = await mkUser(`legacy1-${nanoid(6)}@sap.com`);
      const u2 = await mkUser(`legacy2-${nanoid(6)}@sap.com`);
      const p1 = nanoid(12), p2 = nanoid(12);
      for (const [pid, owner] of [[p1, u1], [p2, u2]]) {
        await getDb().query(
          'INSERT INTO prototypes (id, name, filename, share_token, created_at, owner_id) VALUES ($1,$2,$3,$4,$5,$6)',
          [pid, 'Legacy', `${pid}.html`, nanoid(12), new Date().toISOString(), owner]);
      }

      await initDb(); // runs the migration

      const { rows: orgs } = await getDb().query("SELECT id FROM organizations WHERE name = 'Default Organization'");
      expect(orgs).toHaveLength(1);
      const defId = orgs[0].id;
      // Both prototypes now belong to the default org.
      const { rows: pr } = await getDb().query('SELECT org_id FROM prototypes WHERE id IN ($1,$2)', [p1, p2]);
      expect(pr.every(r => r.org_id === defId)).toBe(true);
      // Both users are admins of it.
      const { rows: mem } = await getDb().query(
        'SELECT role FROM org_memberships WHERE org_id = $1 AND user_id IN ($2,$3)', [defId, u1, u2]);
      expect(mem).toHaveLength(2);
      expect(mem.every(m => m.role === 'admin')).toBe(true);
      // Marker recorded.
      const { rows: mk } = await getDb().query("SELECT 1 FROM schema_migrations WHERE name = 'org-multitenancy-v1'");
      expect(mk).toHaveLength(1);
    });

    test('is idempotent — second initDb does not create a second default org', async () => {
      await initDb();
      const { rows } = await getDb().query("SELECT COUNT(*)::int AS n FROM organizations WHERE name = 'Default Organization'");
      expect(rows[0].n).toBe(1);
    });
  });

  describe('roles', () => {
    let app, orgId, adminEmail, viewerEmail, protoId;
    beforeAll(async () => {
      await cleanDb();
      app = makeApp();
      orgId = await mkOrg('Acme');
      const adminId = await mkUser(adminEmail = `admin-${nanoid(6)}@sap.com`);
      const viewerId = await mkUser(viewerEmail = `viewer-${nanoid(6)}@sap.com`);
      await addMember(orgId, adminId, 'admin');
      await addMember(orgId, viewerId, 'viewer');
      protoId = await mkPrototype(orgId, adminId, 'Acme Proto');
    });

    test('viewer can READ the org prototype list and detail', async () => {
      const agent = await login(app, viewerEmail);
      expect((await agent.get('/admin/prototypes')).status).toBe(200);
      expect((await agent.get(`/admin/prototypes/${protoId}`)).status).toBe(200);
    });

    test('viewer is DENIED write actions (403)', async () => {
      const agent = await login(app, viewerEmail);
      expect((await agent.post(`/admin/prototypes/${protoId}/settings`).send('name=x')).status).toBe(403);
      expect((await agent.delete(`/admin/prototypes/${protoId}`)).status).toBe(403);
      expect((await agent.delete(`/admin/prototypes/${protoId}/comments`)).status).toBe(403);
      expect((await agent.post('/admin/tokens').send('name=t')).status).toBe(403);
    });

    test('admin is ALLOWED the same write actions', async () => {
      const agent = await login(app, adminEmail);
      expect((await agent.post(`/admin/prototypes/${protoId}/settings`).send('name=Renamed')).status).toBe(302);
      expect((await agent.post('/admin/tokens').send('name=t')).status).toBe(201);
    });
  });

  describe('cross-org isolation', () => {
    let app, protoA, viewerBEmail;
    beforeAll(async () => {
      await cleanDb();
      app = makeApp();
      const orgA = await mkOrg('OrgA');
      const orgB = await mkOrg('OrgB');
      const adminA = await mkUser(`a-${nanoid(6)}@sap.com`);
      const viewerB = await mkUser(viewerBEmail = `b-${nanoid(6)}@sap.com`);
      await addMember(orgA, adminA, 'admin');
      await addMember(orgB, viewerB, 'admin'); // admin of B, but not a member of A
      protoA = await mkPrototype(orgA, adminA, 'A only');
    });

    test('a member of org B cannot see or touch org A\'s prototype', async () => {
      const agent = await login(app, viewerBEmail);
      expect((await agent.get(`/admin/prototypes/${protoA}`)).status).toBe(404);
      expect((await agent.delete(`/admin/prototypes/${protoA}`)).status).toBe(404);
      expect((await agent.get(`/admin/prototypes/${protoA}/versions`)).status).toBe(404);
      const list = await agent.get('/admin/prototypes');
      expect(list.text).not.toContain(protoA);
    });
  });
});
