// tests/apiv1-md.test.js
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();
const hasDb = !!process.env.DATABASE_URL;
const { initDb, getDb, closeDb } = require('../src/db');
const { nanoid } = require('nanoid');
const request = require('supertest');
const express = require('express');
const apiV1Router = require('../src/routes/apiV1');
const tokens = require('../src/services/tokens');

let app, protoId, orgId, userId, rawToken;

(hasDb ? describe : describe.skip)('api v1 markdown push', () => {
  beforeAll(async () => {
    await initDb();
    userId = nanoid(12); orgId = nanoid(12); protoId = nanoid(12);
    await getDb().query('INSERT INTO users (id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)',
      [userId, `v1md-${userId}@sap.com`, 'x', new Date().toISOString()]);
    await getDb().query('INSERT INTO organizations (id,name,created_at) VALUES ($1,$2,$3)',
      [orgId, 'V1 MD Org ' + orgId, new Date().toISOString()]);
    await getDb().query("INSERT INTO org_memberships (id,org_id,user_id,role,created_at) VALUES ($1,$2,$3,'admin',$4)",
      [nanoid(12), orgId, userId, new Date().toISOString()]);
    const vid = nanoid(12);
    await getDb().query('INSERT INTO prototypes (id,name,filename,share_token,created_at,owner_id,org_id,content_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [protoId, 'V1 Proto', `${protoId}.html`, nanoid(12), new Date().toISOString(), userId, orgId, 'html']);
    await getDb().query("INSERT INTO prototype_versions (id,prototype_id,version,filename,status,created_at,content_type) VALUES ($1,$2,1,$3,'published',$4,'html')",
      [vid, protoId, `${protoId}.html`, new Date().toISOString()]);
    await getDb().query('UPDATE prototypes SET published_version_id = $1 WHERE id = $2', [vid, protoId]);
    const t = await tokens.createToken(userId, 'test', orgId);
    rawToken = t.raw;

    app = express();
    app.use(express.json());
    app.use('/api/v1', apiV1Router);
  });
  afterAll(async () => { await closeDb(); });

  test('pushes a .md draft with content_type=markdown', async () => {
    const res = await request(app)
      .post(`/api/v1/prototypes/${protoId}/versions`)
      .set('Authorization', `Bearer ${rawToken}`)
      .attach('file', Buffer.from('# Draft\n\nMD body'), 'draft.md')
      .field('note', 'md push');
    expect(res.status).toBe(201);
    const { rows } = await getDb().query(
      'SELECT content_type, filename FROM prototype_versions WHERE prototype_id = $1 AND version = 2', [protoId]);
    expect(rows[0].content_type).toBe('markdown');
    expect(rows[0].filename.endsWith('.md')).toBe(true);
  });
});
