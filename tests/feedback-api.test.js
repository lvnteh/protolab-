// tests/feedback-api.test.js
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

let app, userId, otherUserId, orgA, orgB, protoId, rawToken, otherToken, v1Id;

async function createOrg(name) {
  const id = nanoid(12);
  await getDb().query('INSERT INTO organizations (id,name,created_at) VALUES ($1,$2,$3)',
    [id, name, new Date().toISOString()]);
  return id;
}

function makeApp() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1', apiV1Router);
  return a;
}

(hasDb ? describe : describe.skip)('GET /api/v1 feedback', () => {
  beforeAll(async () => {
    await initDb();
    app = makeApp();

    userId = nanoid(12);
    otherUserId = nanoid(12);
    await getDb().query('INSERT INTO users (id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)',
      [userId, `fb-${userId}@sap.com`, 'x', new Date().toISOString()]);
    await getDb().query('INSERT INTO users (id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)',
      [otherUserId, `fb-${otherUserId}@sap.com`, 'x', new Date().toISOString()]);
    orgA = await createOrg('orgA'); orgB = await createOrg('orgB');
    ({ raw: rawToken } = await tokens.createToken(userId, 't', orgA));
    ({ raw: otherToken } = await tokens.createToken(otherUserId, 't', orgB));

    protoId = nanoid(12);
    await getDb().query(
      'INSERT INTO prototypes (id,name,filename,share_token,created_at,owner_id,org_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [protoId, 'FB', `${protoId}.html`, nanoid(12), new Date().toISOString(), userId, orgA]);
    await initDb(); // second call re-runs the idempotent backfill so this prototype gets its v1
    ({ rows: [{ id: v1Id }] } = await getDb().query(
      'SELECT id FROM prototype_versions WHERE prototype_id = $1', [protoId]));

    const cId = nanoid(12);
    await getDb().query(
      `INSERT INTO comments (id,prototype_id,email,type,element_selector,element_label,comment,page_url,created_at,tag,version_id)
       VALUES ($1,$2,$3,'element',$4,$5,$6,$7,$8,'bug',$9)`,
      [cId, protoId, 'alice@sap.com', '.cart', 'Cart', 'broken', '/cart', new Date().toISOString(), v1Id]);
    await getDb().query(
      `INSERT INTO comments (id,prototype_id,email,type,comment,created_at,parent_id)
       VALUES ($1,$2,$3,'reply',$4,$5,$6)`,
      [nanoid(12), protoId, 'bob@sap.com', 'confirmed', new Date().toISOString(), cId]);
    // A markdown range comment: no element_selector; the anchored text lives in
    // the anchor_* columns. The payload must surface these so a machine reader
    // knows which passage the note refers to.
    await getDb().query(
      `INSERT INTO comments (id,prototype_id,email,type,comment,page_url,created_at,tag,version_id,
                             anchor_quote,anchor_prefix,anchor_suffix,anchor_start,anchor_end)
       VALUES ($1,$2,$3,'range',$4,$5,$6,'copy',$7,$8,$9,$10,$11,$12)`,
      [nanoid(12), protoId, 'carol@sap.com', 'reword this', '/spec', new Date().toISOString(), v1Id,
       'must authenticate', 'The system ', ' every request', 11, 28]);
    await getDb().query(
      `INSERT INTO explanations (id,prototype_id,element_selector,page_url,body,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [nanoid(12), protoId, '.cart', '/cart', 'recomputes on change', new Date().toISOString(), new Date().toISOString()]);
  });
  afterAll(async () => { await closeDb(); });

  test('401 without a token', async () => {
    expect((await request(app).get('/api/v1/prototypes')).status).toBe(401);
  });

  test('GET /prototypes lists only the caller-owned prototype', async () => {
    const res = await request(app).get('/api/v1/prototypes').set('Authorization', `Bearer ${rawToken}`);
    expect(res.status).toBe(200);
    expect(res.body.map(p => p.id)).toContain(protoId);
  });

  test('feedback payload nests replies, includes explanations and madeAgainstVersion', async () => {
    const res = await request(app).get(`/api/v1/prototypes/${protoId}/feedback`)
      .set('Authorization', `Bearer ${rawToken}`);
    expect(res.status).toBe(200);
    expect(res.body.prototype.id).toBe(protoId);
    const el = res.body.comments.find(c => c.type === 'element');
    expect(el).toBeTruthy();
    expect(el.tag).toBe('bug');
    expect(el.madeAgainstVersion).toBe(1);
    expect(el.replies).toHaveLength(1);
    expect(res.body.explanations[0].body).toBe('recomputes on change');
  });

  test('range comments expose their anchored quote/prefix/suffix so a reader can locate the text', async () => {
    const res = await request(app).get(`/api/v1/prototypes/${protoId}/feedback`)
      .set('Authorization', `Bearer ${rawToken}`);
    expect(res.status).toBe(200);
    const range = res.body.comments.find(c => c.type === 'range');
    expect(range).toBeTruthy();
    expect(range.comment).toBe('reword this');
    expect(range.element).toBeNull();       // range comments have no DOM selector
    expect(range.anchor).toEqual({
      quote: 'must authenticate',
      prefix: 'The system ',
      suffix: ' every request',
      start: 11,
      end: 28,
    });
    // Element comments must NOT carry an anchor object.
    const el = res.body.comments.find(c => c.type === 'element');
    expect(el.anchor).toBeNull();
  });

  test('cross-tenant feedback returns 404', async () => {
    const res = await request(app).get(`/api/v1/prototypes/${protoId}/feedback`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(res.status).toBe(404);
  });
});
