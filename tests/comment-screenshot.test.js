// tests/comment-screenshot.test.js
// Backend persistence + access-control for comment screenshots. Covers:
//   - reviewer comment list NEVER exposes screenshot_* fields
//   - admin comment list exposes hasScreenshot + thumb but NOT screenshot_key
//   - the full-image route 403/redirects a reviewer (no org session) and 200s an admin
//   - deleting a comment / prototype removes the stored image
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();

const hasDb = !!process.env.DATABASE_URL;
jest.setTimeout(15000);

// In-memory storage mock with BOTH the prototype-file verbs and the image verbs
// (putImage/getImage/deleteImage + SCREENSHOT_PREFIX). Images are kept as Buffers.
jest.mock('../src/services/storage', () => {
  const files = new Map();
  const images = new Map();
  return {
    putPrototype: jest.fn(async (f, b) => { files.set(f, Buffer.isBuffer(b) ? b.toString('utf8') : String(b)); }),
    getPrototype: jest.fn(async (f) => (files.has(f) ? files.get(f) : null)),
    deletePrototype: jest.fn(async (f) => { files.delete(f); }),
    putImage: jest.fn(async (k, b) => { images.set(k, Buffer.isBuffer(b) ? b : Buffer.from(b)); }),
    getImage: jest.fn(async (k) => (images.has(k) ? images.get(k) : null)),
    deleteImage: jest.fn(async (k) => { images.delete(k); }),
    SCREENSHOT_PREFIX: 'screenshots/',
    __images: images,
  };
});

jest.resetModules();
const { initDb, getDb, closeDb } = require('../src/db');
const { nanoid } = require('nanoid');
const request = require('supertest');
const express = require('express');
const session = require('express-session');
const apiRouter = require('../src/routes/api');
const adminRouter = require('../src/routes/admin');
const storage = require('../src/services/storage');

// A 1x1 PNG, small enough to be stored as an inline thumb.
const SMALL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
// A PNG whose base64 exceeds the inline-thumb threshold, so it is stored as a
// separate object (screenshot_key set, thumb null) and reachable via the
// full-image route. Padded past MAX_THUMB_BASE64 (~60KB) with a tEXt chunk is
// not valid-PNG-safe for decoding, but the backend only checks the data: prefix
// and size, never decodes — so a long but well-formed-prefixed data URL suffices.
const LARGE_PNG = 'data:image/png;base64,' + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9aw'.padEnd(90000, 'A');

let app;

async function mkUser() {
  const id = nanoid(12);
  await getDb().query('INSERT INTO users (id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)',
    [id, `ss-${id}@sap.com`, 'x', new Date().toISOString()]);
  return id;
}
async function mkOrg(name) {
  const id = nanoid(12);
  await getDb().query('INSERT INTO organizations (id,name,created_at) VALUES ($1,$2,$3)',
    [id, name, new Date().toISOString()]);
  return id;
}
async function mkAdminMembership(orgId, userId) {
  await getDb().query(
    `INSERT INTO org_memberships (id,org_id,user_id,role,created_at) VALUES ($1,$2,$3,'admin',$4)`,
    [nanoid(12), orgId, userId, new Date().toISOString()]);
}
async function mkProto(orgId, ownerId) {
  const id = nanoid(12);
  await getDb().query(
    'INSERT INTO prototypes (id,name,filename,share_token,created_at,owner_id,org_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, 'SS', `${id}.html`, nanoid(12), new Date().toISOString(), ownerId, orgId]);
  return id;
}

// A reviewer session: share-link bound to a prototype, with a customerEmail but
// NO userId (so it is NOT an org member). It is established via the /__seed
// route mounted in beforeAll.

(hasDb ? describe : describe.skip)('comment screenshots', () => {
  let adminUserId, orgId, protoId, adminAgent;

  beforeAll(async () => {
    await initDb();
    // App with a tiny session seeder so a test can establish either a reviewer
    // (prototypeId+customerEmail) or admin (userId+activeOrgId) session.
    app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json({ limit: '15mb' }));
    app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    app.post('/__seed', (req, res) => { Object.assign(req.session, req.body); res.json({ ok: true }); });
    app.use('/api', apiRouter);
    app.use('/admin', adminRouter);

    adminUserId = await mkUser();
    orgId = await mkOrg('ss-org');
    await mkAdminMembership(orgId, adminUserId);
    protoId = await mkProto(orgId, adminUserId);
    await initDb(); // idempotent backfill gives the prototype its v1

    adminAgent = request.agent(app);
    await adminAgent.post('/__seed').send({ userId: adminUserId, activeOrgId: orgId });
  });
  afterAll(async () => { await closeDb(); });

  async function postComment(agent, body) {
    return agent.post('/api/comments').send(body);
  }

  test('reviewer comment list never exposes screenshot fields', async () => {
    const reviewer = request.agent(app);
    await reviewer.post('/__seed').send({ prototypeId: protoId, customerEmail: 'rev@x.com' });
    const create = await postComment(reviewer, {
      prototypeId: protoId, type: 'element', comment: 'with shot',
      element: { selector: '.a', label: 'A' }, xPct: 0.5, yPct: 0.5,
      screenshot: { dataUrl: SMALL_PNG, w: 100, h: 80, xPct: 0.25, yPct: 0.4 },
    });
    expect(create.status).toBe(201);

    const list = await reviewer.get(`/api/comments/${protoId}`);
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThan(0);
    for (const c of list.body) {
      for (const k of Object.keys(c)) {
        expect(k.startsWith('screenshot')).toBe(false);
      }
      expect(c.hasScreenshot).toBeUndefined();
    }
    // And the row really did persist a screenshot (so the absence above is a
    // filter, not a no-op). A SMALL image is stored inline as the thumb only —
    // no separate object (and thus no key) to avoid double-storing it.
    const { rows } = await getDb().query(
      'SELECT screenshot_key, screenshot_thumb, screenshot_w FROM comments WHERE id = $1', [create.body.id]);
    expect(rows[0].screenshot_thumb).toBe(SMALL_PNG);  // small → stored inline
    expect(rows[0].screenshot_key).toBeNull();          // small → no separate object
    expect(rows[0].screenshot_w).toBe(100);
  });

  test('admin list exposes hasScreenshot + thumb but not screenshot_key', async () => {
    const res = await adminAgent.post(`/admin/prototypes/${protoId}/comments`).send({});
    expect(res.status).toBe(200);
    const withShot = res.body.data.find(c => c.hasScreenshot);
    expect(withShot).toBeTruthy();
    expect(withShot.screenshot_key).toBeUndefined();        // key never leaks
    expect(withShot.screenshot_thumb).toBe(SMALL_PNG);      // thumb for preview
    expect(withShot.screenshot_w).toBe(100);
    expect(withShot.screenshot_x_pct).toBeCloseTo(0.25);
  });

  test('full-image route: 403/redirect to reviewer, 200 PNG to admin', async () => {
    // Create a comment with a shot and grab its id.
    const reviewer = request.agent(app);
    await reviewer.post('/__seed').send({ prototypeId: protoId, customerEmail: 'rev@x.com' });
    const create = await postComment(reviewer, {
      prototypeId: protoId, type: 'element', comment: 'img', element: { selector: '.b' },
      screenshot: { dataUrl: LARGE_PNG, w: 10, h: 10, xPct: 0.1, yPct: 0.1 },
    });
    const commentId = create.body.id;

    // Reviewer (no userId) is NOT an org member → requireOrg redirects to login.
    const revRes = await reviewer.get(`/admin/prototypes/${protoId}/comments/${commentId}/screenshot`);
    expect([302, 401, 403]).toContain(revRes.status);
    expect(revRes.headers['content-type']).not.toMatch(/image\/png/);

    // Admin gets the PNG bytes with a private, no-store cache header.
    const adminRes = await adminAgent.get(`/admin/prototypes/${protoId}/comments/${commentId}/screenshot`);
    expect(adminRes.status).toBe(200);
    expect(adminRes.headers['content-type']).toMatch(/image\/png/);
    expect(adminRes.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.isBuffer(adminRes.body)).toBe(true);
    expect(adminRes.body.length).toBeGreaterThan(0);
  });

  test('full-image route 404s when the comment/prototype/screenshot is missing', async () => {
    // Comment that exists but has no screenshot.
    const reviewer = request.agent(app);
    await reviewer.post('/__seed').send({ prototypeId: protoId, customerEmail: 'rev@x.com' });
    const noShot = await postComment(reviewer, {
      prototypeId: protoId, type: 'general', comment: 'no shot',
    });
    const r1 = await adminAgent.get(`/admin/prototypes/${protoId}/comments/${noShot.body.id}/screenshot`);
    expect(r1.status).toBe(404);
    // Unknown comment id.
    const r2 = await adminAgent.get(`/admin/prototypes/${protoId}/comments/nope/screenshot`);
    expect(r2.status).toBe(404);
  });

  test('deleting a comment removes its stored image', async () => {
    const reviewer = request.agent(app);
    await reviewer.post('/__seed').send({ prototypeId: protoId, customerEmail: 'rev@x.com' });
    const create = await postComment(reviewer, {
      prototypeId: protoId, type: 'element', comment: 'del me', element: { selector: '.c' },
      screenshot: { dataUrl: LARGE_PNG, w: 5, h: 5, xPct: 0, yPct: 0 },
    });
    const { rows } = await getDb().query('SELECT screenshot_key FROM comments WHERE id = $1', [create.body.id]);
    const key = rows[0].screenshot_key;
    expect(await storage.getImage(key)).not.toBeNull();

    // Reviewer deletes their own comment via the reviewer-facing route.
    const del = await reviewer.delete(`/api/comments/${create.body.id}`);
    expect(del.status).toBe(200);
    expect(await storage.getImage(key)).toBeNull();
  });

  test('deleting a prototype removes all its comment images', async () => {
    // Fresh prototype so we can delete it wholesale.
    const pid = await mkProto(orgId, adminUserId);
    await initDb();
    const reviewer = request.agent(app);
    await reviewer.post('/__seed').send({ prototypeId: pid, customerEmail: 'rev@x.com' });
    const c = await postComment(reviewer, {
      prototypeId: pid, type: 'element', comment: 'proto del', element: { selector: '.d' },
      screenshot: { dataUrl: LARGE_PNG, w: 5, h: 5, xPct: 0, yPct: 0 },
    });
    const { rows } = await getDb().query('SELECT screenshot_key FROM comments WHERE id = $1', [c.body.id]);
    const key = rows[0].screenshot_key;
    expect(await storage.getImage(key)).not.toBeNull();

    const del = await adminAgent.delete(`/admin/prototypes/${pid}`);
    expect(del.status).toBe(200);
    expect(await storage.getImage(key)).toBeNull();
  });

  test('replies never carry a screenshot, and non-PNG / oversized data is skipped', async () => {
    const reviewer = request.agent(app);
    await reviewer.post('/__seed').send({ prototypeId: protoId, customerEmail: 'rev@x.com' });
    // Non-PNG dataUrl is ignored; comment still posts.
    const bad = await postComment(reviewer, {
      prototypeId: protoId, type: 'general', comment: 'bad shot',
      screenshot: { dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', w: 1, h: 1 },
    });
    expect(bad.status).toBe(201);
    const { rows: badRows } = await getDb().query('SELECT screenshot_key FROM comments WHERE id = $1', [bad.body.id]);
    expect(badRows[0].screenshot_key).toBeNull();

    // A reply with a screenshot in the body: screenshot is ignored.
    const parent = await postComment(reviewer, { prototypeId: protoId, type: 'general', comment: 'parent' });
    const reply = await postComment(reviewer, {
      prototypeId: protoId, comment: 'reply', parentId: parent.body.id,
      screenshot: { dataUrl: SMALL_PNG, w: 1, h: 1, xPct: 0, yPct: 0 },
    });
    expect(reply.status).toBe(201);
    const { rows: repRows } = await getDb().query('SELECT screenshot_key FROM comments WHERE id = $1', [reply.body.id]);
    expect(repRows[0].screenshot_key).toBeNull();
  });
});
