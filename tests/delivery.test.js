// tests/delivery.test.js
const path = require('path');
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();
process.env.BASE_URL = 'http://localhost:3000';

const hasDb = !!process.env.DATABASE_URL;

const { initDb, getDb, closeDb } = require('../src/db');
const { nanoid } = require('nanoid');
const fs = require('fs');
const request = require('supertest');
const express = require('express');
const session = require('express-session');
const deliveryRouter = require('../src/routes/delivery');
const versions = require('../src/services/versions');
const storage = require('../src/services/storage');

let app, protoId, shareToken;

(hasDb ? describe : describe.skip)('delivery routes', () => {
  beforeAll(async () => {
    await initDb();
    protoId = nanoid(12);
    shareToken = nanoid(12);

    const htmlPath = path.join(os.tmpdir(), `${protoId}.html`);
    fs.writeFileSync(htmlPath, '<!DOCTYPE html><html><head></head><body><h1>Test</h1></body></html>');

    await getDb().query(
      'INSERT INTO prototypes (id, name, filename, share_token, created_at) VALUES ($1,$2,$3,$4,$5)',
      [protoId, 'Test Proto', `${protoId}.html`, shareToken, new Date().toISOString()]
    );
    await getDb().query(
      'INSERT INTO allowlist (prototype_id, email) VALUES ($1,$2)',
      [protoId, 'allowed@example.com']
    );

    app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    app.use('/p', deliveryRouter);
  });

  afterAll(async () => {
    await closeDb();
  });

  test('GET /p/:token renders the prototype', async () => {
    const res = await request(app).get(`/p/${shareToken}`);
    expect(res.status).toBe(200);
  });

  test('GET /p/:token with unknown token responds 404', async () => {
    const res = await request(app).get('/p/unknowntoken123');
    expect(res.status).toBe(404);
  });

  test('GET /p/:token/view serves the published version file, not prototypes.filename', async () => {
    await initDb(); // no-op for backfill (beforeAll already ran it); kept as a guard in case this test runs standalone

    // Publish a v2 with distinct content via the real (fs-fallback) storage.
    const v2file = `${protoId}-v2.html`;
    await storage.putPrototype(v2file, '<!DOCTYPE html><html><head></head><body>PUBLISHED-V2</body></html>');
    const v = await versions.createDraft(protoId, v2file, 'v2');
    await versions.publish(protoId, v.version);

    // Establish an authorized reviewer session, then fetch the view.
    const agent = request.agent(app);
    await agent.post(`/p/${shareToken}/enter`).send('email=allowed@example.com');
    const res = await agent.get(`/p/${shareToken}/view`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('PUBLISHED-V2');
  });

  test('GET /p/:token/view renders a Markdown version to sanitized, SDK-injected HTML', async () => {
    const mdFile = `${protoId}-md.md`;
    await storage.putPrototype(mdFile, '# Hello MD\n\nSome **bold** text.', 'text/markdown; charset=utf-8');
    const v = await versions.createDraft(protoId, mdFile, 'md', 'markdown');
    await versions.publish(protoId, v.version);

    const agent = request.agent(app);
    await agent.post(`/p/${shareToken}/enter`).send('email=allowed@example.com');
    const res = await agent.get(`/p/${shareToken}/view`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<h1>Hello MD</h1>');
    expect(res.text).toContain('<strong>bold</strong>');
    expect(res.text).toContain('/sdk/feedback.js');
    // Markdown view is locked down with a CSP (scripts same-origin only). It must
    // still permit our injected SDK (script-src 'self') and its /api fetches
    // (connect-src 'self') — verified end-to-end in the browser.
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['content-security-policy']).toMatch(/script-src 'self'/);
  });

  test('GET /p/:token/view does NOT set the markdown CSP on an HTML prototype', async () => {
    // HTML prototypes may legitimately use inline scripts/handlers, so the strict
    // markdown CSP must not apply to them. Republish an HTML version.
    const htmlFile = `${protoId}-back-to-html.html`;
    await storage.putPrototype(htmlFile, '<!DOCTYPE html><html><head></head><body>HTML AGAIN</body></html>');
    const v = await versions.createDraft(protoId, htmlFile, 'html', 'html');
    await versions.publish(protoId, v.version);

    const agent = request.agent(app);
    await agent.post(`/p/${shareToken}/enter`).send('email=allowed@example.com');
    const res = await agent.get(`/p/${shareToken}/view`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('HTML AGAIN');
    expect(res.headers['content-security-policy']).toBeUndefined();
  });
});
