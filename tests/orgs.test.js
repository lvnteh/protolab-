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

  describe('migration (EMS consolidation)', () => {
    // The org migration is marker-guarded and idempotent; it folds ALL legacy
    // data into one org named 'EMS' and makes every existing user an admin of
    // it. We simulate a legacy state (users + prototypes/tokens with NULL
    // org_id, marker removed, org_id made nullable again) and re-run initDb.
    test('folds all legacy users + prototypes + tokens into one EMS org', async () => {
      await cleanDb();
      await getDb().query('DELETE FROM schema_migrations WHERE name = $1', ['org-ems-consolidation-v1']);
      // Drop the NOT NULL enforcement so we can insert legacy (org-less) rows,
      // exactly as they looked before the consolidation ran.
      await getDb().query('ALTER TABLE prototypes ALTER COLUMN org_id DROP NOT NULL');
      await getDb().query('ALTER TABLE api_tokens ALTER COLUMN org_id DROP NOT NULL');

      const u1 = await mkUser(`legacy1-${nanoid(6)}@sap.com`);
      const u2 = await mkUser(`legacy2-${nanoid(6)}@sap.com`);
      const p1 = nanoid(12), p2 = nanoid(12);
      for (const [pid, owner] of [[p1, u1], [p2, u2]]) {
        await getDb().query(
          'INSERT INTO prototypes (id, name, filename, share_token, created_at, owner_id) VALUES ($1,$2,$3,$4,$5,$6)',
          [pid, 'Legacy', `${pid}.html`, nanoid(12), new Date().toISOString(), owner]);
      }
      const tok = nanoid(12);
      await getDb().query(
        'INSERT INTO api_tokens (id, user_id, token_hash, name, created_at) VALUES ($1,$2,$3,$4,$5)',
        [tok, u1, 'h', 'legacy', new Date().toISOString()]);

      await initDb(); // runs the EMS consolidation

      const { rows: orgs } = await getDb().query("SELECT id FROM organizations WHERE name = 'EMS'");
      expect(orgs).toHaveLength(1);
      const emsId = orgs[0].id;
      // Both prototypes now belong to EMS.
      const { rows: pr } = await getDb().query('SELECT org_id FROM prototypes WHERE id IN ($1,$2)', [p1, p2]);
      expect(pr.every(r => r.org_id === emsId)).toBe(true);
      // The legacy token moved into EMS too.
      const { rows: tr } = await getDb().query('SELECT org_id FROM api_tokens WHERE id = $1', [tok]);
      expect(tr[0].org_id).toBe(emsId);
      // Both users are admins of EMS.
      const { rows: mem } = await getDb().query(
        'SELECT role FROM org_memberships WHERE org_id = $1 AND user_id IN ($2,$3)', [emsId, u1, u2]);
      expect(mem).toHaveLength(2);
      expect(mem.every(m => m.role === 'admin')).toBe(true);
      // Marker recorded.
      const { rows: mk } = await getDb().query("SELECT 1 FROM schema_migrations WHERE name = 'org-ems-consolidation-v1'");
      expect(mk).toHaveLength(1);
    });

    test('enforces NOT NULL org_id on prototypes and api_tokens after the fold', async () => {
      // After the consolidation the columns must be NOT NULL.
      const { rows } = await getDb().query(`
        SELECT table_name, is_nullable FROM information_schema.columns
        WHERE column_name = 'org_id' AND table_name IN ('prototypes','api_tokens')
      `);
      for (const r of rows) expect(r.is_nullable).toBe('NO');
    });

    test('is idempotent — second initDb does not create a second EMS org', async () => {
      await initDb();
      const { rows } = await getDb().query("SELECT COUNT(*)::int AS n FROM organizations WHERE name = 'EMS'");
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
      // Canonical org-scoped read URLs (Task 3); legacy unscoped reads 302 here.
      expect((await agent.get(`/admin/orgs/${orgId}/prototypes`)).status).toBe(200);
      expect((await agent.get(`/admin/orgs/${orgId}/prototypes/${protoId}`)).status).toBe(200);
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

  // --- Task 1: org management service (createOrg, members, roles, invites) ---
  describe('org management service', () => {
    const orgsSvc = require('../src/services/orgs');
    const tokens = require('../src/services/tokens');

    beforeEach(async () => { await cleanDb(); });

    test('createOrg makes the creator the first admin (one txn)', async () => {
      const uid = await mkUser(`creator-${nanoid(6)}@sap.com`);
      const org = await orgsSvc.createOrg(uid, 'Acme Inc');
      expect(org.name).toBe('Acme Inc');
      const m = await orgsSvc.membership(uid, org.id);
      expect(m.role).toBe('admin');
    });

    test('listUserOrgs lists each membership with its role', async () => {
      const uid = await mkUser(`multi-${nanoid(6)}@sap.com`);
      const a = await orgsSvc.createOrg(uid, 'A');
      const b = await mkOrg('B');
      await addMember(b, uid, 'viewer');
      const list = await orgsSvc.listUserOrgs(uid);
      expect(list.map(o => o.id).sort()).toEqual([a.id, b].sort());
      const byId = Object.fromEntries(list.map(o => [o.id, o.role]));
      expect(byId[a.id]).toBe('admin');
      expect(byId[b]).toBe('viewer');
    });

    test('listMembers returns members with email + role', async () => {
      const admin = await mkUser(`lm-admin-${nanoid(6)}@sap.com`);
      const viewer = await mkUser(`lm-view-${nanoid(6)}@sap.com`);
      const org = await orgsSvc.createOrg(admin, 'Org');
      await addMember(org.id, viewer, 'viewer');
      const members = await orgsSvc.listMembers(org.id);
      expect(members).toHaveLength(2);
      const roleByUser = Object.fromEntries(members.map(m => [m.user_id, m.role]));
      expect(roleByUser[admin]).toBe('admin');
      expect(roleByUser[viewer]).toBe('viewer');
    });

    test('setRole promotes a viewer to admin', async () => {
      const admin = await mkUser(`sr-admin-${nanoid(6)}@sap.com`);
      const viewer = await mkUser(`sr-view-${nanoid(6)}@sap.com`);
      const org = await orgsSvc.createOrg(admin, 'Org');
      await addMember(org.id, viewer, 'viewer');
      await orgsSvc.setRole(admin, org.id, viewer, 'admin');
      expect((await orgsSvc.membership(viewer, org.id)).role).toBe('admin');
    });

    test('setRole refuses to demote the last admin (LastAdminError)', async () => {
      const admin = await mkUser(`last-${nanoid(6)}@sap.com`);
      const org = await orgsSvc.createOrg(admin, 'Org');
      await expect(orgsSvc.setRole(admin, org.id, admin, 'viewer'))
        .rejects.toMatchObject({ code: 'LAST_ADMIN' });
      // Still an admin.
      expect((await orgsSvc.membership(admin, org.id)).role).toBe('admin');
    });

    test('setRole demotion revokes the demoted user\'s org tokens in the same txn', async () => {
      const admin = await mkUser(`d-admin-${nanoid(6)}@sap.com`);
      const second = await mkUser(`d-two-${nanoid(6)}@sap.com`);
      const org = await orgsSvc.createOrg(admin, 'Org');
      await addMember(org.id, second, 'admin'); // two admins, so demotion is allowed
      const { raw, id: tokId } = await tokens.createToken(second, 'wk', org.id);
      expect(await tokens.resolveToken(raw)).toMatchObject({ userId: second });
      await orgsSvc.setRole(admin, org.id, second, 'viewer');
      const { rows } = await getDb().query('SELECT 1 FROM api_tokens WHERE id = $1', [tokId]);
      expect(rows).toHaveLength(0); // token deleted in the same transaction
      expect(await tokens.resolveToken(raw)).toBeNull();
    });

    test('setRole is rejected when the actor is not an admin (NotAuthorizedError)', async () => {
      const admin = await mkUser(`na-admin-${nanoid(6)}@sap.com`);
      const viewer = await mkUser(`na-view-${nanoid(6)}@sap.com`);
      const org = await orgsSvc.createOrg(admin, 'Org');
      await addMember(org.id, viewer, 'viewer');
      await expect(orgsSvc.setRole(viewer, org.id, admin, 'viewer'))
        .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    });

    test('removeMember refuses to remove the last admin', async () => {
      const admin = await mkUser(`rm-last-${nanoid(6)}@sap.com`);
      const org = await orgsSvc.createOrg(admin, 'Org');
      await expect(orgsSvc.removeMember(admin, org.id, admin))
        .rejects.toMatchObject({ code: 'LAST_ADMIN' });
    });

    test('removeMember removes a member and revokes their tokens in the same txn', async () => {
      const admin = await mkUser(`rm-admin-${nanoid(6)}@sap.com`);
      const victim = await mkUser(`rm-victim-${nanoid(6)}@sap.com`);
      const org = await orgsSvc.createOrg(admin, 'Org');
      await addMember(org.id, victim, 'admin');
      const { raw } = await tokens.createToken(victim, 'wk', org.id);
      const res = await orgsSvc.removeMember(admin, org.id, victim);
      expect(res.removed).toBe(true);
      expect(await orgsSvc.membership(victim, org.id)).toBeNull();
      expect(await tokens.resolveToken(raw)).toBeNull();
    });

    test('createInvite stores a pending invite with a nanoid(24) token', async () => {
      const admin = await mkUser(`inv-admin-${nanoid(6)}@sap.com`);
      const org = await orgsSvc.createOrg(admin, 'Org');
      const inv = await orgsSvc.createInvite(admin, org.id, 'Guest@SAP.com', 'viewer');
      expect(inv.email).toBe('guest@sap.com'); // normalized
      expect(inv.token).toHaveLength(24);
      const list = await orgsSvc.listInvites(org.id, 'pending');
      expect(list).toHaveLength(1);
      expect(list[0].status).toBe('pending');
    });

    test('createInvite rejects a second PENDING invite for the same email (uq_invites_pending)', async () => {
      const admin = await mkUser(`inv2-${nanoid(6)}@sap.com`);
      const org = await orgsSvc.createOrg(admin, 'Org');
      await orgsSvc.createInvite(admin, org.id, 'dup@sap.com', 'viewer');
      await expect(orgsSvc.createInvite(admin, org.id, 'dup@sap.com', 'admin'))
        .rejects.toMatchObject({ code: 'INVITE_EXISTS' });
    });

    test('revokeInvite frees the email for a fresh invite', async () => {
      const admin = await mkUser(`rev-${nanoid(6)}@sap.com`);
      const org = await orgsSvc.createOrg(admin, 'Org');
      const inv = await orgsSvc.createInvite(admin, org.id, 'again@sap.com', 'viewer');
      const r = await orgsSvc.revokeInvite(admin, org.id, inv.id);
      expect(r.revoked).toBe(true);
      // A revoked invite no longer blocks the partial unique index.
      const inv2 = await orgsSvc.createInvite(admin, org.id, 'again@sap.com', 'admin');
      expect(inv2.token).not.toBe(inv.token);
    });

    test('reissueInvite revokes the old pending invite and returns a new token', async () => {
      const admin = await mkUser(`reiss-${nanoid(6)}@sap.com`);
      const org = await orgsSvc.createOrg(admin, 'Org');
      const inv = await orgsSvc.createInvite(admin, org.id, 'rot@sap.com', 'viewer');
      const inv2 = await orgsSvc.reissueInvite(admin, org.id, inv.id);
      expect(inv2.token).not.toBe(inv.token);
      expect(inv2.email).toBe('rot@sap.com');
      const pending = await orgsSvc.listInvites(org.id, 'pending');
      expect(pending).toHaveLength(1);
      expect(pending[0].token).toBe(inv2.token);
    });

    test('acceptInvite adds the membership and marks the invite accepted', async () => {
      const admin = await mkUser(`acc-admin-${nanoid(6)}@sap.com`);
      const org = await orgsSvc.createOrg(admin, 'Org');
      const email = `invitee-${nanoid(6)}@sap.com`;
      const invitee = await mkUser(email);
      const inv = await orgsSvc.createInvite(admin, org.id, email, 'viewer');
      const res = await orgsSvc.acceptInvite(invitee, inv.token, email);
      expect(res).toMatchObject({ orgId: org.id, role: 'viewer' });
      expect((await orgsSvc.membership(invitee, org.id)).role).toBe('viewer');
      const { rows } = await getDb().query(
        'SELECT status, accepted_at FROM org_invitations WHERE id = $1', [inv.id]);
      expect(rows[0].status).toBe('accepted');
      expect(rows[0].accepted_at).toBeTruthy();
    });

    test('acceptInvite rejects an email mismatch', async () => {
      const admin = await mkUser(`mm-admin-${nanoid(6)}@sap.com`);
      const org = await orgsSvc.createOrg(admin, 'Org');
      const invitee = await mkUser(`mm-u-${nanoid(6)}@sap.com`);
      const inv = await orgsSvc.createInvite(admin, org.id, 'someoneelse@sap.com', 'viewer');
      await expect(orgsSvc.acceptInvite(invitee, inv.token, 'mm-wrong@sap.com'))
        .rejects.toMatchObject({ code: 'INVALID_INVITE' });
      expect(await orgsSvc.membership(invitee, org.id)).toBeNull();
    });

    test('acceptInvite rejects an unknown or already-accepted token', async () => {
      const admin = await mkUser(`un-admin-${nanoid(6)}@sap.com`);
      const org = await orgsSvc.createOrg(admin, 'Org');
      const email = `un-u-${nanoid(6)}@sap.com`;
      const invitee = await mkUser(email);
      await expect(orgsSvc.acceptInvite(invitee, 'does-not-exist', email))
        .rejects.toMatchObject({ code: 'INVALID_INVITE' });
      const inv = await orgsSvc.createInvite(admin, org.id, email, 'viewer');
      await orgsSvc.acceptInvite(invitee, inv.token, email);
      // Second accept of the now-terminal invite must fail.
      await expect(orgsSvc.acceptInvite(invitee, inv.token, email))
        .rejects.toMatchObject({ code: 'INVALID_INVITE' });
    });
  });
});
