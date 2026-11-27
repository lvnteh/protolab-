// tests/capability-matrix.test.js
// Task 6: the capability matrix + the shared effective-reviewer-access resolver,
// exercised through the real reviewer-facing /api router and delivery.js share
// flow. Covers: viewers/reviewers may comment but not moderate others or author
// explanations; the 5-minute own-comment window enforced server-side; author
// identity derived server-side (forged body email ignored); same-org logged-out
// email share access with NO explicit allowlist row; cross-org denial; and
// access revocation on the next request after member/allowlist removal.
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();

const hasDb = !!process.env.DATABASE_URL;
jest.setTimeout(20000);

jest.mock('../src/services/storage', () => {
  const files = new Map();
  return {
    putPrototype: jest.fn(async (f, b) => { files.set(f, Buffer.isBuffer(b) ? b.toString('utf8') : String(b)); }),
    getPrototype: jest.fn(async (f) => (files.has(f) ? files.get(f) : '<html>x</html>')),
    deletePrototype: jest.fn(async () => {}),
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
const apiRouter = require('../src/routes/api');
const deliveryRouter = require('../src/routes/delivery');

let app, orgA, orgB, adminId, viewerId, protoId, shareToken;

// An app with a /__seed route to establish either an account (userId) or a
// reviewer (prototypeId + customerEmail) session, then the /api + /p routers.
function makeApp() {
  const a = express();
  a.use(express.urlencoded({ extended: true }));
  a.use(express.json());
  a.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  a.post('/__seed', (req, res) => { Object.assign(req.session, req.body); res.json({ ok: true }); });
  a.use('/api', apiRouter);
  a.use('/p', deliveryRouter);
  return a;
}

async function mkUser(email) {
  const id = nanoid(12);
  await getDb().query('INSERT INTO users (id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)',
    [id, email.toLowerCase(), 'x', new Date().toISOString()]);
  return id;
}
async function mkOrg(name) {
  const id = nanoid(12);
  await getDb().query('INSERT INTO organizations (id,name,created_at) VALUES ($1,$2,$3)', [id, name, new Date().toISOString()]);
  return id;
}
async function addMember(orgId, userId, role) {
  await getDb().query(`INSERT INTO org_memberships (id,org_id,user_id,role,created_at) VALUES ($1,$2,$3,$4,$5)`,
    [nanoid(12), orgId, userId, role, new Date().toISOString()]);
}
async function accountAgent(userId) {
  const ag = request.agent(app);
  await ag.post('/__seed').send({ userId });
  return ag;
}
async function reviewerAgent(email) {
  const ag = request.agent(app);
  await ag.post('/__seed').send({ prototypeId: protoId, customerEmail: email });
  return ag;
}

let adminEmail, viewerEmail;

(hasDb ? describe : describe.skip)('Task 6 capability matrix + effective access', () => {
  beforeAll(async () => {
    await initDb();
    app = makeApp();
    orgA = await mkOrg('A'); orgB = await mkOrg('B');
    adminId = await mkUser(adminEmail = `cm-admin-${nanoid(5)}@sap.com`);
    viewerId = await mkUser(viewerEmail = `cm-viewer-${nanoid(5)}@sap.com`);
    await addMember(orgA, adminId, 'admin');
    await addMember(orgA, viewerId, 'viewer');
    protoId = nanoid(12); shareToken = nanoid(12);
    await getDb().query(
      'INSERT INTO prototypes (id,name,filename,share_token,created_at,owner_id,org_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [protoId, 'CM', `${protoId}.html`, shareToken, new Date().toISOString(), adminId, orgA]);
    await initDb(); // v1 backfill
  });
  afterAll(async () => { await closeDb(); });

  test('viewer CAN create a comment, authored under their account identity (body email ignored)', async () => {
    const ag = await accountAgent(viewerId);
    const res = await ag.post('/api/comments').send({
      prototypeId: protoId, type: 'general', comment: 'viewer note', email: 'forged@evil.com',
    });
    expect(res.status).toBe(201);
    const { rows } = await getDb().query('SELECT email, author_user_id, author_kind FROM comments WHERE id = $1', [res.body.id]);
    expect(rows[0].email).toBe(viewerEmail.toLowerCase());   // server-derived, NOT forged@evil.com
    expect(rows[0].author_user_id).toBe(viewerId);
    expect(rows[0].author_kind).toBe('account');
  });

  test("viewer CANNOT delete another author's comment (403), admin CAN moderate it", async () => {
    // Admin authors a comment.
    const admin = await accountAgent(adminId);
    const c = await admin.post('/api/comments').send({ prototypeId: protoId, type: 'general', comment: 'admin owned' });
    const cid = c.body.id;
    // Viewer attempts to delete it → 403, row survives.
    const viewer = await accountAgent(viewerId);
    const del = await viewer.delete(`/api/comments/${cid}`);
    expect(del.status).toBe(403);
    expect((await getDb().query('SELECT 1 FROM comments WHERE id = $1', [cid])).rows).toHaveLength(1);
    // Admin moderates (deletes) it → 200.
    const modDel = await admin.delete(`/api/comments/${cid}`);
    expect(modDel.status).toBe(200);
  });

  test('viewer CANNOT create/edit/delete explanations; admin CAN', async () => {
    const viewer = await accountAgent(viewerId);
    const vr = await viewer.post('/api/explanations').send({ prototypeId: protoId, elementSelector: '.v', body: 'nope' });
    expect(vr.status).toBe(403);
    const admin = await accountAgent(adminId);
    const ar = await admin.post('/api/explanations').send({ prototypeId: protoId, elementSelector: '.a', body: 'yes' });
    expect(ar.status).toBe(201);
    const ve = await viewer.patch(`/api/explanations/${ar.body.id}`).send({ body: 'hacked' });
    expect(ve.status).toBe(403);
    const vd = await viewer.delete(`/api/explanations/${ar.body.id}`);
    expect(vd.status).toBe(403);
  });

  test('author can edit their own comment within 5 min; NOT after the window; never someone else', async () => {
    const viewer = await accountAgent(viewerId);
    const c = await viewer.post('/api/comments').send({ prototypeId: protoId, type: 'general', comment: 'mine' });
    const cid = c.body.id;
    // Within window: OK.
    const okEdit = await viewer.patch(`/api/comments/${cid}`).send({ comment: 'mine edited' });
    expect(okEdit.status).toBe(200);
    // Backdate the row past the 5-minute window → viewer can no longer edit it.
    await getDb().query('UPDATE comments SET created_at = $1 WHERE id = $2',
      [new Date(Date.now() - 6 * 60 * 1000).toISOString(), cid]);
    const lateEdit = await viewer.patch(`/api/comments/${cid}`).send({ comment: 'too late' });
    expect(lateEdit.status).toBe(403);
    // ...but an admin may still moderate past the window.
    const admin = await accountAgent(adminId);
    const modEdit = await admin.patch(`/api/comments/${cid}`).send({ comment: 'moderated' });
    expect(modEdit.status).toBe(200);
  });

  test('reviewer (share-link) can comment but CANNOT moderate others or author explanations', async () => {
    // Allowlist an external reviewer and bind a reviewer session.
    const extEmail = `ext-${nanoid(5)}@sap.com`;
    await getDb().query('INSERT INTO allowlist (prototype_id,email) VALUES ($1,$2) ON CONFLICT DO NOTHING', [protoId, extEmail]);
    const reviewer = await reviewerAgent(extEmail);
    const c = await reviewer.post('/api/comments').send({ prototypeId: protoId, type: 'general', comment: 'reviewer note' });
    expect(c.status).toBe(201);
    // Admin's comment: the reviewer cannot delete it.
    const admin = await accountAgent(adminId);
    const ac = await admin.post('/api/comments').send({ prototypeId: protoId, type: 'general', comment: 'admin again' });
    expect((await reviewer.delete(`/api/comments/${ac.body.id}`)).status).toBe(403);
    // Reviewers cannot author explanations.
    expect((await reviewer.post('/api/explanations').send({ prototypeId: protoId, elementSelector: '.r', body: 'x' })).status).toBe(403);
  });

  // ── Effective reviewer access via the share-link /enter flow ──────────────
  test('logged-out same-org admin opens an own-org share link by entering their account email (no allowlist row)', async () => {
    const ag = request.agent(app);  // fresh, logged-out
    const enter = await ag.post(`/p/${shareToken}/enter`).type('form').send({ email: '  ' + adminEmail.toUpperCase() + ' ' });
    expect(enter.status).toBe(302);           // mixed-case + whitespace normalized, membership-derived grant
    expect(enter.headers.location).toContain(`/p/${shareToken}/view`);
  });

  test('a member of ANOTHER org is denied on the share link (cross-org)', async () => {
    const orgBUserId = await mkUser(`cm-bmember-${nanoid(5)}@sap.com`);
    const { rows } = await getDb().query('SELECT email FROM users WHERE id = $1', [orgBUserId]);
    await addMember(orgB, orgBUserId, 'admin');
    const ag = request.agent(app);
    const enter = await ag.post(`/p/${shareToken}/enter`).type('form').send({ email: rows[0].email });
    expect(enter.status).toBe(403);           // membership is in org B, prototype is in org A
  });

  test('removing a member ends inherited share access on the next protected request', async () => {
    // Add a temp viewer, let them enter via membership, then remove them.
    const tempId = await mkUser(`cm-temp-${nanoid(5)}@sap.com`);
    const { rows: tr } = await getDb().query('SELECT email FROM users WHERE id = $1', [tempId]);
    await addMember(orgA, tempId, 'viewer');
    const ag = request.agent(app);
    expect((await ag.post(`/p/${shareToken}/enter`).type('form').send({ email: tr[0].email })).status).toBe(302);
    // Their /api read works while the membership stands.
    expect((await ag.get(`/api/comments/${protoId}`)).status).toBe(200);
    // Remove the membership → the very next protected read is denied.
    await getDb().query('DELETE FROM org_memberships WHERE org_id = $1 AND user_id = $2', [orgA, tempId]);
    expect((await ag.get(`/api/comments/${protoId}`)).status).toBe(403);
  });

  test('an independent explicit allowlist entry keeps a removed member in', async () => {
    const id = await mkUser(`cm-dual-${nanoid(5)}@sap.com`);
    const { rows: dr } = await getDb().query('SELECT email FROM users WHERE id = $1', [id]);
    const email = dr[0].email;
    await addMember(orgA, id, 'viewer');
    await getDb().query('INSERT INTO allowlist (prototype_id,email) VALUES ($1,$2) ON CONFLICT DO NOTHING', [protoId, email]);
    const ag = request.agent(app);
    expect((await ag.post(`/p/${shareToken}/enter`).type('form').send({ email })).status).toBe(302);
    // Remove the membership — the explicit allowlist row still grants access.
    await getDb().query('DELETE FROM org_memberships WHERE org_id = $1 AND user_id = $2', [orgA, id]);
    expect((await ag.get(`/api/comments/${protoId}`)).status).toBe(200);
  });
});
