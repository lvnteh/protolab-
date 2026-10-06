// tests/docs-repos-schema.test.js
const hasDb = !!process.env.DATABASE_URL;
const { initDb, getDb, closeDb } = require('../src/db');

(hasDb ? describe : describe.skip)('docs_repos schema', () => {
  beforeAll(async () => { await initDb(); });
  afterAll(async () => { await closeDb(); });

  test('table exists with the expected columns + unique constraint', async () => {
    const { rows } = await getDb().query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='docs_repos' ORDER BY column_name`);
    const cols = rows.map((r) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(
      ['id', 'org_id', 'owner', 'repo', 'html_url', 'default_branch', 'created_by', 'created_at']));
    // unique(org_id, owner, repo): a duplicate insert must fail
    const org = 'o_' + Date.now();
    await getDb().query(`INSERT INTO organizations (id,name,created_at) VALUES ($1,'t',$2) ON CONFLICT DO NOTHING`, [org, new Date().toISOString()]);
    const ins = (id) => getDb().query(
      `INSERT INTO docs_repos (id,org_id,owner,repo,html_url,created_at) VALUES ($1,$2,'acme','widgets','u',$3)`,
      [id, org, new Date().toISOString()]);
    await ins('r1');
    await expect(ins('r2')).rejects.toMatchObject({ code: '23505' });
  });
});
