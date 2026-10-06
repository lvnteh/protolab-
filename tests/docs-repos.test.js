// tests/docs-repos.test.js
const { parseGithubUrl, addRepo, listRepos, getRepo, removeRepo } = require('../src/services/docsRepos');
const hasDb = !!process.env.DATABASE_URL;

describe('parseGithubUrl', () => {
  test('parses https + .git + trailing slash', () => {
    expect(parseGithubUrl('https://github.com/acme/widgets')).toEqual({ owner: 'acme', repo: 'widgets' });
    expect(parseGithubUrl('https://github.com/acme/widgets.git')).toEqual({ owner: 'acme', repo: 'widgets' });
    expect(parseGithubUrl('https://github.com/acme/widgets/')).toEqual({ owner: 'acme', repo: 'widgets' });
  });
  test('rejects non-github and junk', () => {
    expect(() => parseGithubUrl('https://evil.com/acme/widgets')).toThrow(/github\.com/i);
    expect(() => parseGithubUrl('javascript:alert(1)')).toThrow();
    expect(() => parseGithubUrl('https://github.com/acme')).toThrow(/owner\/repo/i);
  });
});

function fakeFetch(status, json) {
  return async () => ({ ok: status < 400, status, async json() { return json; } });
}

(hasDb ? describe : describe.skip)('registry CRUD (per-org)', () => {
  const { initDb, getDb, closeDb } = require('../src/db');
  const org = 'o_' + Math.random().toString(36).slice(2);
  beforeAll(async () => { await initDb(); await getDb().query(`INSERT INTO organizations (id,name,created_at) VALUES ($1,'t',$2) ON CONFLICT DO NOTHING`, [org, new Date().toISOString()]); });
  afterAll(async () => { await closeDb(); });

  test('addRepo verifies access then stores; lists + scopes + removes', async () => {
    const row = await addRepo({ orgId: org, url: 'https://github.com/acme/widgets', userId: 'u1', token: 't', fetchImpl: fakeFetch(200, { default_branch: 'main' }) });
    expect(row).toMatchObject({ org_id: org, owner: 'acme', repo: 'widgets', default_branch: 'main' });
    expect(await listRepos(org)).toHaveLength(1);
    expect(await getRepo(org, row.id)).toMatchObject({ owner: 'acme' });
    expect(await getRepo('other-org', row.id)).toBeNull(); // cross-org scoped out
    expect(await removeRepo(org, row.id)).toBe(true);
    expect(await listRepos(org)).toHaveLength(0);
  });

  test('addRepo rejects a repo the token cannot access', async () => {
    await expect(addRepo({ orgId: org, url: 'https://github.com/acme/secret', userId: 'u1', token: 't', fetchImpl: fakeFetch(404, {}) }))
      .rejects.toThrow(/access/i);
  });
});
