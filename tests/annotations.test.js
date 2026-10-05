// tests/annotations.test.js
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();
const hasDb = !!process.env.DATABASE_URL;
jest.setTimeout(15000);

const { initDb, getDb, closeDb, runAnnotationVersionBackfill } = require('../src/db');
const { nanoid } = require('nanoid');

async function mkProto() {
  const id = nanoid(12);
  await getDb().query(
    'INSERT INTO prototypes (id,name,filename,share_token,created_at) VALUES ($1,$2,$3,$4,$5)',
    [id, 'P', `${id}.html`, nanoid(12), new Date().toISOString()]);
  return id;
}
async function mkVersion(protoId, version, status) {
  const vid = nanoid(12);
  await getDb().query(
    `INSERT INTO prototype_versions (id,prototype_id,version,filename,status,created_at,content_type)
     VALUES ($1,$2,$3,$4,$5,$6,'html')`,
    [vid, protoId, version, `${vid}.html`, status, new Date().toISOString()]);
  return vid;
}

(hasDb ? describe : describe.skip)('explanations version schema', () => {
  beforeAll(async () => { await initDb(); });
  afterAll(async () => { await closeDb(); });

  test('same selector/page is allowed on two different versions, rejected on the same version', async () => {
    const p = await mkProto();
    const v1 = await mkVersion(p, 1, 'published');
    const v2 = await mkVersion(p, 2, 'published');
    const ins = (versionId) => getDb().query(
      `INSERT INTO explanations (id,prototype_id,element_selector,page_url,body,created_at,updated_at,version_id)
       VALUES ($1,$2,'.cart','/cart','x',$3,$3,$4)`,
      [nanoid(12), p, new Date().toISOString(), versionId]);
    await expect(ins(v1)).resolves.toBeDefined();
    await expect(ins(v2)).resolves.toBeDefined();          // different version → OK
    await expect(ins(v1)).rejects.toMatchObject({ code: '23505' }); // same version → conflict
  });

  test('deleting a version nulls its explanations (ON DELETE SET NULL)', async () => {
    const p = await mkProto();
    const v = await mkVersion(p, 1, 'published');
    await getDb().query(
      `INSERT INTO explanations (id,prototype_id,element_selector,page_url,body,created_at,updated_at,version_id)
       VALUES ($1,$2,'.a','/a','x',$3,$3,$4)`,
      [nanoid(12), p, new Date().toISOString(), v]);
    await getDb().query('DELETE FROM prototype_versions WHERE id = $1', [v]);
    const { rows } = await getDb().query(
      'SELECT version_id FROM explanations WHERE prototype_id = $1', [p]);
    expect(rows[0].version_id).toBeNull();
  });

  test('backfill stamps replies with their parent version and clears null-version explanations', async () => {
    const p = await mkProto();
    const v1 = await mkVersion(p, 1, 'published');

    const parentId = nanoid(12);
    await getDb().query(
      `INSERT INTO comments (id,prototype_id,email,type,comment,created_at,version_id)
       VALUES ($1,$2,'a@x.com','element','parent',$3,$4)`,
      [parentId, p, new Date().toISOString(), v1]);
    const replyId = nanoid(12);
    await getDb().query(                                   // reply created by the buggy path: no version_id
      `INSERT INTO comments (id,prototype_id,email,type,comment,created_at,parent_id)
       VALUES ($1,$2,'b@x.com','reply','re',$3,$4)`,
      [replyId, p, new Date().toISOString(), parentId]);
    await getDb().query(                                   // a legacy prototype-scoped explanation (no version)
      `INSERT INTO explanations (id,prototype_id,element_selector,page_url,body,created_at,updated_at)
       VALUES ($1,$2,'.legacy','/x','old',$3,$3)`,
      [nanoid(12), p, new Date().toISOString()]);

    await runAnnotationVersionBackfill(getDb());

    const { rows: reply } = await getDb().query('SELECT version_id FROM comments WHERE id = $1', [replyId]);
    expect(reply[0].version_id).toBe(v1);
    const { rows: expl } = await getDb().query(
      'SELECT COUNT(*)::int AS n FROM explanations WHERE prototype_id = $1', [p]);
    expect(expl[0].n).toBe(0);
  });

  const annotations = require('../src/services/annotations');

  test('resolveViewedVersion honors a published version, rejects a draft, falls back to the pointer', async () => {
    const p = await mkProto();
    const v1 = await mkVersion(p, 1, 'published');
    const v2 = await mkVersion(p, 2, 'draft');
    await getDb().query('UPDATE prototypes SET published_version_id = $1 WHERE id = $2', [v1, p]);

    expect((await annotations.resolveViewedVersion(p, 1)).versionId).toBe(v1);  // published → honored
    expect((await annotations.resolveViewedVersion(p, 2)).versionId).toBe(v1);  // draft → fall back to pointer
    expect((await annotations.resolveViewedVersion(p, 99)).versionId).toBe(v1); // unknown → pointer
    expect((await annotations.resolveViewedVersion(p, null)).versionId).toBe(v1); // none requested → pointer
    void v2;
  });

  test('a version from another prototype is never resolvable', async () => {
    const a = await mkProto();
    const b = await mkProto();
    const bv = await mkVersion(b, 1, 'published');
    const { rows } = await getDb().query('SELECT version FROM prototype_versions WHERE id = $1', [bv]);
    // prototype A has no such published version → requesting B's number falls back to A's pointer (null here)
    expect((await annotations.resolveViewedVersion(a, rows[0].version)).versionId).toBeNull();
  });

  test('createComment stamps the version; a reply is stamped from the passed version; reads are version-scoped', async () => {
    const p = await mkProto();
    const v1 = await mkVersion(p, 1, 'published');
    const v2 = await mkVersion(p, 2, 'published');
    await getDb().query('UPDATE prototypes SET published_version_id = $1 WHERE id = $2', [v1, p]);

    const { id: parentId } = await annotations.createComment(p, v1,
      { email: 'a@x.com', type: 'element', comment: 'c1', element: { selector: '.x', label: 'X' } });
    await annotations.createComment(p, v1, { email: 'b@x.com', comment: 're', parentId });   // reply on v1
    await annotations.createComment(p, v2,
      { email: 'c@x.com', type: 'element', comment: 'c2', element: { selector: '.y', label: 'Y' } });

    const onV1 = await annotations.listComments(p, v1);
    expect(onV1).toHaveLength(1);
    expect(onV1[0].comment).toBe('c1');
    expect(onV1[0].replies).toHaveLength(1);     // reply nested, same version (Review Focus #2)
    const onV2 = await annotations.listComments(p, v2);
    expect(onV2.map(c => c.comment)).toEqual(['c2']);
  });

  test('createExplanation re-throws 23505 on a same-version/selector conflict', async () => {
    const p = await mkProto();
    const v1 = await mkVersion(p, 1, 'published');
    await annotations.createExplanation(p, v1, { elementSelector: '.a', pageUrl: '/a', body: 'one' });
    await expect(annotations.createExplanation(p, v1, { elementSelector: '.a', pageUrl: '/a', body: 'two' }))
      .rejects.toMatchObject({ code: '23505' });
  });
});
