// tests/admin-upload-md.test.js
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();
const hasDb = !!process.env.DATABASE_URL;
const { initDb, getDb, closeDb } = require('../src/db');
const { nanoid } = require('nanoid');
const request = require('supertest');
const express = require('express');
const session = require('express-session');
const adminRouter = require('../src/routes/admin');

let app, userId, orgId;

(hasDb ? describe : describe.skip)('admin upload markdown', () => {
  beforeAll(async () => {
    await initDb();
    userId = nanoid(12); orgId = nanoid(12);
    await getDb().query('INSERT INTO users (id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)',
      [userId, `md-${userId}@sap.com`, 'x', new Date().toISOString()]);
    await getDb().query('INSERT INTO organizations (id,name,created_at) VALUES ($1,$2,$3)',
      [orgId, 'MD Org ' + orgId, new Date().toISOString()]);
    await getDb().query(
      "INSERT INTO org_memberships (id,org_id,user_id,role,created_at) VALUES ($1,$2,$3,'admin',$4)",
      [nanoid(12), orgId, userId, new Date().toISOString()]);

    app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    app.use((req, _res, next) => { req.session.userId = userId; req.session.activeOrgId = orgId; next(); });
    app.use('/admin', adminRouter);
  });
  afterAll(async () => { await closeDb(); });

  test('uploads a .md file and stores content_type=markdown with a .md filename', async () => {
    const res = await request(app)
      .post('/admin/prototypes')
      .set('accept', 'application/json')
      .field('name', 'MD Proto')
      .attach('file', Buffer.from('# Doc\n\nHello.'), 'doc.md');
    expect(res.status).toBe(200);
    const id = res.body.id;
    const { rows } = await getDb().query('SELECT filename, content_type FROM prototypes WHERE id = $1', [id]);
    expect(rows[0].content_type).toBe('markdown');
    expect(rows[0].filename.endsWith('.md')).toBe(true);
    const { rows: vrows } = await getDb().query(
      'SELECT content_type, filename FROM prototype_versions WHERE prototype_id = $1', [id]);
    expect(vrows[0].content_type).toBe('markdown');
  });

  test('rejects a .txt file', async () => {
    const res = await request(app)
      .post('/admin/prototypes')
      .field('name', 'Bad')
      .attach('file', Buffer.from('nope'), 'notes.txt');
    expect(res.status).toBe(400);
  });
});
