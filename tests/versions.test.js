// tests/versions.test.js
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();

const hasDb = !!process.env.DATABASE_URL;
const { initDb, getDb, closeDb } = require('../src/db');
const { nanoid } = require('nanoid');

(hasDb ? describe : describe.skip)('schema: versions + tokens', () => {
  beforeAll(async () => { await initDb(); });
  afterAll(async () => { await closeDb(); });

  test('api_tokens table exists with expected columns', async () => {
    const { rows } = await getDb().query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'api_tokens'`
    );
    const cols = rows.map(r => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(
      ['id', 'user_id', 'token_hash', 'name', 'created_at', 'last_used_at']));
  });

  test('prototype_versions table exists with expected columns', async () => {
    const { rows } = await getDb().query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'prototype_versions'`
    );
    const cols = rows.map(r => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(
      ['id', 'prototype_id', 'version', 'filename', 'status', 'note', 'created_at']));
  });

  test('prototypes gains published_version_id and draft_version_id', async () => {
    const { rows } = await getDb().query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'prototypes'`
    );
    const cols = rows.map(r => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(['published_version_id', 'draft_version_id']));
  });

  test('comments gains version_id', async () => {
    const { rows } = await getDb().query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'comments'`
    );
    expect(rows.map(r => r.column_name)).toContain('version_id');
  });

  test('backfill: an existing prototype gets a published v1 pointing at its filename', async () => {
    const id = nanoid(12);
    // Insert a legacy-style prototype with only a filename, no version rows.
    await getDb().query(
      'INSERT INTO prototypes (id, name, filename, share_token, created_at) VALUES ($1,$2,$3,$4,$5)',
      [id, 'Legacy', `${id}.html`, nanoid(12), new Date().toISOString()]
    );
    // Insert a legacy comment with no version_id, to verify the comment backfill.
    const commentId = nanoid(12);
    await getDb().query(
      `INSERT INTO comments (id, prototype_id, email, type, comment, created_at)
       VALUES ($1,$2,$3,'general',$4,$5)`,
      [commentId, id, 'x@sap.com', 'legacy comment', new Date().toISOString()]
    );
    // Re-run initDb to trigger the idempotent backfill.
    await initDb();
    const { rows: pv } = await getDb().query(
      'SELECT version, status, filename FROM prototype_versions WHERE prototype_id = $1', [id]);
    expect(pv).toHaveLength(1);
    expect(pv[0]).toMatchObject({ version: 1, status: 'published', filename: `${id}.html` });
    const { rows: p } = await getDb().query(
      'SELECT published_version_id FROM prototypes WHERE id = $1', [id]);
    expect(p[0].published_version_id).toBeTruthy();
    // Assert that the legacy comment had its version_id backfilled to the new v1 id.
    const { rows: vrow } = await getDb().query(
      'SELECT id FROM prototype_versions WHERE prototype_id = $1', [id]);
    const { rows: crow } = await getDb().query(
      'SELECT version_id FROM comments WHERE id = $1', [commentId]);
    expect(crow[0].version_id).toBe(vrow[0].id);
  });
});

(hasDb ? describe : describe.skip)('version service', () => {
  // These tests share protoId and run in order: createDraft (v2) → publish → latestVersion.
  const versions = require('../src/services/versions');
  let protoId, userId;

  beforeAll(async () => {
    await initDb();
    userId = nanoid(12);
    await getDb().query('INSERT INTO users (id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)',
      [userId, `ver-${userId}@sap.com`, 'x', new Date().toISOString()]);
    protoId = nanoid(12);
    await getDb().query(
      'INSERT INTO prototypes (id,name,filename,share_token,created_at,owner_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [protoId, 'Ver', `${protoId}.html`, nanoid(12), new Date().toISOString(), userId]);
    await initDb(); // second call re-runs the idempotent backfill so this prototype gets its v1
  });
  afterAll(async () => { await closeDb(); });

  test('createDraft allocates the next version number as a draft', async () => {
    const v = await versions.createDraft(protoId, `${protoId}-v2.html`, 'my note');
    expect(v.version).toBe(2);
    expect(v.status).toBe('draft');
    const { rows } = await getDb().query('SELECT draft_version_id FROM prototypes WHERE id = $1', [protoId]);
    expect(rows[0].draft_version_id).toBe(v.id);
  });

  test('resolvePublishedFile returns the v1 filename before any publish', async () => {
    const file = await versions.resolvePublishedFile(protoId);
    expect(file).toBe(`${protoId}.html`);
  });

  test('publish promotes the draft and moves the published pointer', async () => {
    await versions.publish(protoId, 2);
    const file = await versions.resolvePublishedFile(protoId);
    expect(file).toBe(`${protoId}-v2.html`);
    const { rows } = await getDb().query(
      'SELECT status FROM prototype_versions WHERE prototype_id = $1 AND version = 2', [protoId]);
    expect(rows[0].status).toBe('published');
  });

  test('latestVersion returns the highest version number', async () => {
    expect(await versions.latestVersion(protoId)).toBe(2);
  });
});
