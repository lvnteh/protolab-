// tests/sandbox.test.js
// HTML PROTOTYPE SANDBOXING — server-side contract for S1 (sandbox + CSP) and
// S3 (CSRF / origin guard on reviewer mutations). The in-browser isolation
// behaviours (parent-DOM access, storage, forged bridge messages, top nav) are
// asserted in the Playwright regression (see docs + the browser run); these
// header/parsing assertions SUPPLEMENT but do not replace those.
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();
process.env.BASE_URL = 'http://localhost:3000';

const hasDb = !!process.env.DATABASE_URL;
jest.setTimeout(15000);

// In-memory prototype storage so /raw + /view resolve a real HTML document
// without touching Supabase/disk.
const HTML_DOC = '<!DOCTYPE html><html><head></head><body><h1>Proto</h1></body></html>';
const MD_DOC = '# Heading\n\nSome **markdown** with <script>alert(1)</script> embedded HTML.';
jest.mock('../src/services/storage', () => {
  const files = new Map();
  return {
    putPrototype: jest.fn(async (f, b) => { files.set(f, String(b)); }),
    getPrototype: jest.fn(async (f) => (files.has(f) ? files.get(f) : null)),
    deletePrototype: jest.fn(async (f) => { files.delete(f); }),
    putImage: jest.fn(async () => {}),
    getImage: jest.fn(async () => null),
    deleteImage: jest.fn(async () => {}),
    SCREENSHOT_PREFIX: 'screenshots/',
    __files: files,
  };
});

jest.resetModules();
const { initDb, getDb, closeDb } = require('../src/db');
const { nanoid } = require('nanoid');
const request = require('supertest');
const express = require('express');
const session = require('express-session');
const deliveryRouter = require('../src/routes/delivery');
const apiRouter = require('../src/routes/api');
const storage = require('../src/services/storage');

let app;
let orgId, ownerId, htmlProtoId, htmlToken, mdProtoId, mdToken;

async function mkUser() {
  const id = nanoid(12);
  await getDb().query('INSERT INTO users (id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)',
    [id, `sb-${id}@sap.com`, 'x', new Date().toISOString()]);
  return id;
}
async function mkOrg() {
  const id = nanoid(12);
  await getDb().query('INSERT INTO organizations (id,name,created_at) VALUES ($1,$2,$3)',
    [id, 'sb-org', new Date().toISOString()]);
  return id;
}
async function mkProto(contentType, body) {
  const id = nanoid(12);
  const token = nanoid(12);
  const ext = contentType === 'markdown' ? 'md' : 'html';
  const filename = `${id}.${ext}`;
  await storage.putPrototype(filename, body);
  await getDb().query(
    'INSERT INTO prototypes (id,name,filename,share_token,created_at,owner_id,org_id,content_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, 'SB', filename, token, new Date().toISOString(), ownerId, orgId, contentType]);
  await getDb().query('INSERT INTO allowlist (prototype_id, email) VALUES ($1,$2)', [id, 'rev@sap.com']);
  return { id, token };
}

// A reviewer agent whose session is bound to `protoId` (as delivery.js /enter
// would set it). Uses a tiny seed route so we don't depend on the email flow.
async function reviewerFor(protoId) {
  const agent = request.agent(app);
  await agent.post('/__seed').send({ prototypeId: protoId, customerEmail: 'rev@sap.com' });
  return agent;
}

(hasDb ? describe : describe.skip)('HTML prototype sandboxing', () => {
  beforeAll(async () => {
    await initDb();
    app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json({ limit: '15mb' }));
    app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    app.post('/__seed', (req, res) => { Object.assign(req.session, req.body); res.json({ ok: true }); });
    app.use('/p', deliveryRouter);
    app.use('/api', apiRouter);

    ownerId = await mkUser();
    orgId = await mkOrg();
    ({ id: htmlProtoId, token: htmlToken } = await mkProto('html', HTML_DOC));
    ({ id: mdProtoId, token: mdToken } = await mkProto('markdown', MD_DOC));
    await initDb(); // idempotent backfill → v1 for each prototype
    // The v1 backfill defaults versions.content_type to 'html'; the real markdown
    // upload path sets it on the version. Mirror that so resolvePublished returns
    // 'markdown' for the markdown prototype (matching a genuine .md upload).
    await getDb().query(
      'UPDATE prototype_versions SET content_type = $1 WHERE prototype_id = $2',
      ['markdown', mdProtoId]);
  });
  afterAll(async () => { await closeDb(); });

  // ── S1: sandbox CSP header on executable uploaded HTML ──────────────────────
  test('GET /p/:token/raw sends exactly "sandbox allow-scripts" CSP', async () => {
    const reviewer = await reviewerFor(htmlProtoId);
    const res = await reviewer.get(`/p/${htmlToken}/raw`);
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBe('sandbox allow-scripts');
    // The sandbox header must NOT grant same-origin back to the prototype.
    expect(res.headers['content-security-policy']).not.toMatch(/allow-same-origin/);
    // The injected bridge carries the trusted shell origin so it can message
    // back. delivery derives it from the request host (correct behind proxies),
    // falling back to BASE_URL — so assert it names an http(s) origin, never the
    // opaque "null" the prototype would otherwise compute for itself.
    expect(res.text).toContain('frame-bridge.js');
    expect(res.text).toMatch(/data-shell-origin="https?:\/\/[^"]+"/);
    expect(res.text).not.toContain('data-shell-origin="null"');
  });

  test('the shell /view keeps app-origin privileges (NO sandbox CSP) and sandboxes the iframe', async () => {
    const reviewer = await reviewerFor(htmlProtoId);
    const res = await reviewer.get(`/p/${htmlToken}/view`);
    expect(res.status).toBe(200);
    // The trusted shell is app-origin; it must NOT carry the sandbox CSP.
    expect(res.headers['content-security-policy']).toBeUndefined();
    // Defence-in-depth: the iframe element carries sandbox WITHOUT allow-same-origin.
    expect(res.text).toMatch(/<iframe[^>]*sandbox="allow-scripts allow-forms"/);
    expect(res.text).not.toMatch(/sandbox="[^"]*allow-same-origin/);
    // The shell SDK carries the session CSRF token and the framed flag.
    expect(res.text).toMatch(/data-csrf-token="[0-9a-f]{64}"/);
    expect(res.text).toContain('data-framed="1"');
  });

  // ── Markdown: restrictive CSP preserved, NO sandbox header, HTML can't bypass ─
  test('markdown /view keeps its restrictive CSP and is NOT sandboxed', async () => {
    const reviewer = await reviewerFor(mdProtoId);
    const res = await reviewer.get(`/p/${mdToken}/view`);
    expect(res.status).toBe(200);
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toBe('sandbox allow-scripts'); // not the HTML sandbox header
    // Embedded raw HTML in the markdown source is escaped, never emitted live.
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain('&lt;script&gt;');
  });

  test('markdown token /raw 302s to the in-document view (never served executable)', async () => {
    const reviewer = await reviewerFor(mdProtoId);
    const res = await reviewer.get(`/p/${mdToken}/raw`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/p/${mdToken}/view`);
  });

  // ── S3: CSRF / origin guard on cookie-authenticated reviewer mutations ──────
  test('POST /api/comments with Origin: null (opaque sandbox origin) is rejected BEFORE side effects', async () => {
    const reviewer = await reviewerFor(htmlProtoId);
    const before = await getDb().query('SELECT COUNT(*) n FROM comments WHERE prototype_id=$1', [htmlProtoId]);
    const res = await reviewer
      .post('/api/comments')
      .set('Origin', 'null')
      .send({ prototypeId: htmlProtoId, type: 'general', comment: 'from opaque origin' });
    expect(res.status).toBe(403);
    const after = await getDb().query('SELECT COUNT(*) n FROM comments WHERE prototype_id=$1', [htmlProtoId]);
    expect(after.rows[0].n).toBe(before.rows[0].n); // no row created
  });

  test('POST /api/comments from a cross-origin site is rejected', async () => {
    const reviewer = await reviewerFor(htmlProtoId);
    const res = await reviewer
      .post('/api/comments')
      .set('Origin', 'http://evil.example')
      .send({ prototypeId: htmlProtoId, type: 'general', comment: 'csrf attempt' });
    expect(res.status).toBe(403);
  });

  test('POST /api/nav with Origin: null is rejected (no nav row written)', async () => {
    const reviewer = await reviewerFor(htmlProtoId);
    const before = await getDb().query('SELECT COUNT(*) n FROM nav_events WHERE prototype_id=$1', [htmlProtoId]);
    const res = await reviewer
      .post('/api/nav')
      .set('Origin', 'null')
      .send({ prototypeId: htmlProtoId, pageUrl: '/x' });
    expect(res.status).toBe(403);
    const after = await getDb().query('SELECT COUNT(*) n FROM nav_events WHERE prototype_id=$1', [htmlProtoId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  test('same-origin reviewer mutation still works (Origin matches host)', async () => {
    const reviewer = await reviewerFor(htmlProtoId);
    const res = await reviewer
      .post('/api/comments')
      .set('Origin', 'http://localhost:3000')
      .set('Host', 'localhost:3000')
      .send({ prototypeId: htmlProtoId, type: 'general', comment: 'legit same-origin' });
    expect(res.status).toBe(201);
  });

  test('reviewer mutation with NO Origin header still works (non-browser / supertest default)', async () => {
    const reviewer = await reviewerFor(htmlProtoId);
    const res = await reviewer
      .post('/api/comments')
      .send({ prototypeId: htmlProtoId, type: 'general', comment: 'no origin header' });
    expect(res.status).toBe(201);
  });

  test('POST /p/:token/enter rejects a CROSS-origin (foreign) submission', async () => {
    // The entry form is a TOP-LEVEL navigation: browsers may legitimately send
    // Origin: null for a same-origin form post, so opaque origin is NOT treated
    // as hostile here (the hidden _csrf token proves same-origin intent instead).
    // A NAMED foreign origin, however, is a classic CSRF and is rejected.
    const agent = request.agent(app);
    const res = await agent
      .post(`/p/${htmlToken}/enter`)
      .set('Origin', 'http://evil.example')
      .send({ email: 'rev@sap.com' });
    expect(res.status).toBe(403);
  });

  test('POST /p/:token/enter allows a same-origin / origin-less submission (token not hard-enforced in test)', async () => {
    const agent = request.agent(app);
    const res = await agent
      .post(`/p/${htmlToken}/enter`)
      .send({ email: 'rev@sap.com' });
    // Allowlisted email → redirect to the view (302). Proves the form-nav guard
    // does not block a legitimate same-origin entry.
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/p/${htmlToken}/view`);
  });
});
