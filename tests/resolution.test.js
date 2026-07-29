// tests/resolution.test.js
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();

const hasDb = !!process.env.DATABASE_URL;
jest.setTimeout(15000);

jest.mock('../src/services/storage', () => {
  const files = new Map();
  return {
    putPrototype: jest.fn(async (f, b) => { files.set(f, Buffer.isBuffer(b) ? b.toString('utf8') : String(b)); }),
    getPrototype: jest.fn(async (f) => (files.has(f) ? files.get(f) : null)),
    deletePrototype: jest.fn(async (f) => { files.delete(f); }),
  };
});

jest.resetModules();
const { initDb, getDb, closeDb } = require('../src/db');
const { nanoid } = require('nanoid');
const request = require('supertest');
const express = require('express');
const apiV1Router = require('../src/routes/apiV1');
const tokens = require('../src/services/tokens');

let app, userId, otherUserId, orgA, orgB, protoId, rawToken, otherToken, v1Id, commentId;

async function createOrg(name) {
  const id = nanoid(12);
  await getDb().query('INSERT INTO organizations (id,name,created_at) VALUES ($1,$2,$3)',
    [id, name, new Date().toISOString()]);
  return id;
}

(hasDb ? describe : describe.skip)('comment resolution', () => {
  beforeAll(async () => {
    await initDb();
    app = express();
    app.use(express.json());
    app.use('/api/v1', apiV1Router);

    userId = nanoid(12); otherUserId = nanoid(12);
    await getDb().query('INSERT INTO users (id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)',
      [userId, `res-${userId}@sap.com`, 'x', new Date().toISOString()]);
    await getDb().query('INSERT INTO users (id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)',
      [otherUserId, `res-${otherUserId}@sap.com`, 'x', new Date().toISOString()]);
    orgA = await createOrg('orgA'); orgB = await createOrg('orgB');
    ({ raw: rawToken } = await tokens.createToken(userId, 't', orgA));
    ({ raw: otherToken } = await tokens.createToken(otherUserId, 't', orgB));

    protoId = nanoid(12);
    await getDb().query(
      'INSERT INTO prototypes (id,name,filename,share_token,created_at,owner_id,org_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [protoId, 'Res', `${protoId}.html`, nanoid(12), new Date().toISOString(), userId, orgA]);
    await initDb(); // backfill v1
    ({ rows: [{ id: v1Id }] } = await getDb().query(
      'SELECT id FROM prototype_versions WHERE prototype_id = $1', [protoId]));

    commentId = nanoid(12);
    await getDb().query(
      `INSERT INTO comments (id,prototype_id,email,type,comment,created_at,version_id)
       VALUES ($1,$2,$3,'general',$4,$5,$6)`,
      [commentId, protoId, 'alice@sap.com', 'please fix', new Date().toISOString(), v1Id]);
  });
  afterAll(async () => { await closeDb(); });

  test('comments table has resolved_at and resolved_in_version columns', async () => {
    const { rows } = await getDb().query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'comments'`);
    const cols = rows.map(r => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(['resolved_at', 'resolved_in_version']));
  });

  test('feedback shows the comment as unresolved before any resolve', async () => {
    const res = await request(app).get(`/api/v1/prototypes/${protoId}/feedback`)
      .set('Authorization', `Bearer ${rawToken}`);
    expect(res.status).toBe(200);
    const c = res.body.comments.find(c => c.id === commentId);
    expect(c.resolved).toBe(false);
  });

  test('POST resolve marks it resolved; feedback then reflects it with the version', async () => {
    const r = await request(app).post(`/api/v1/prototypes/${protoId}/comments/${commentId}/resolve`)
      .set('Authorization', `Bearer ${rawToken}`).send({ version: 2 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true });
    const res = await request(app).get(`/api/v1/prototypes/${protoId}/feedback`)
      .set('Authorization', `Bearer ${rawToken}`);
    const c = res.body.comments.find(c => c.id === commentId);
    expect(c.resolved).toBe(true);
    expect(c.resolvedInVersion).toBe(2);
  });

  test('resolve is idempotent (second call still 200)', async () => {
    const r = await request(app).post(`/api/v1/prototypes/${protoId}/comments/${commentId}/resolve`)
      .set('Authorization', `Bearer ${rawToken}`).send({ version: 2 });
    expect(r.status).toBe(200);
  });

  test('re-resolving without a version preserves the previously-recorded version', async () => {
    // The comment was resolved in v2 above. A later resolve with no version
    // (the MCP tool's version arg is optional) must NOT clear resolved_in_version.
    const r = await request(app).post(`/api/v1/prototypes/${protoId}/comments/${commentId}/resolve`)
      .set('Authorization', `Bearer ${rawToken}`).send({});
    expect(r.status).toBe(200);
    const res = await request(app).get(`/api/v1/prototypes/${protoId}/feedback`)
      .set('Authorization', `Bearer ${rawToken}`);
    const c = res.body.comments.find(c => c.id === commentId);
    expect(c.resolved).toBe(true);
    expect(c.resolvedInVersion).toBe(2); // preserved, not nulled
  });

  test('cross-tenant resolve returns 404', async () => {
    const r = await request(app).post(`/api/v1/prototypes/${protoId}/comments/${commentId}/resolve`)
      .set('Authorization', `Bearer ${otherToken}`).send({ version: 2 });
    expect(r.status).toBe(404);
  });

  test('resolving an unknown comment id returns 404', async () => {
    const r = await request(app).post(`/api/v1/prototypes/${protoId}/comments/nope/resolve`)
      .set('Authorization', `Bearer ${rawToken}`).send({ version: 2 });
    expect(r.status).toBe(404);
  });
});
