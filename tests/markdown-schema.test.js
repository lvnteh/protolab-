// tests/markdown-schema.test.js
const hasDb = !!process.env.DATABASE_URL;
const { initDb, getDb, closeDb } = require('../src/db');
const { nanoid } = require('nanoid');

(hasDb ? describe : describe.skip)('markdown schema migrations', () => {
  beforeAll(async () => { await initDb(); });
  afterAll(async () => { await closeDb(); });

  test('prototypes + prototype_versions have content_type defaulting to html', async () => {
    const id = nanoid(12), tok = nanoid(12);
    await getDb().query(
      'INSERT INTO prototypes (id, name, filename, share_token, created_at) VALUES ($1,$2,$3,$4,$5)',
      [id, 'CT', `${id}.html`, tok, new Date().toISOString()]
    );
    const { rows } = await getDb().query('SELECT content_type FROM prototypes WHERE id = $1', [id]);
    expect(rows[0].content_type).toBe('html');
  });

  test("comments type CHECK now allows 'range'", async () => {
    const id = nanoid(12), tok = nanoid(12);
    await getDb().query(
      'INSERT INTO prototypes (id, name, filename, share_token, created_at) VALUES ($1,$2,$3,$4,$5)',
      [id, 'R', `${id}.html`, tok, new Date().toISOString()]
    );
    const cid = nanoid(12);
    await getDb().query(
      `INSERT INTO comments (id, prototype_id, email, type, comment, created_at,
         anchor_quote, anchor_prefix, anchor_suffix, anchor_start, anchor_end)
       VALUES ($1,$2,$3,'range',$4,$5,$6,$7,$8,$9,$10)`,
      [cid, id, 'u@example.com', 'selected text', new Date().toISOString(),
       'selected text', 'before ', ' after', 10, 23]
    );
    const { rows } = await getDb().query('SELECT type, anchor_quote, anchor_start FROM comments WHERE id = $1', [cid]);
    expect(rows[0].type).toBe('range');
    expect(rows[0].anchor_quote).toBe('selected text');
    expect(rows[0].anchor_start).toBe(10);
  });
});
