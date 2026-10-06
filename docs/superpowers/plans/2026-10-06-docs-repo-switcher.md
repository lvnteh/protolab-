# Docs Repo Switcher — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `/docs` serve multiple GitHub repos added by URL and remembered per-org, read via the GitHub API (no clones), switchable in-app, identical on local and Railway.

**Architecture:** A per-org `docs_repos` Postgres registry + an add-by-URL service that validates and verifies access via the GitHub API; a GitHub-API `docSource` reader (trees/contents/commits + small TTL cache) replacing the v1 local-clone reader; repo-scoped, login-gated `/docs` routes with a registry CRUD surface; and a top-bar repo switcher/add UI in the existing docs SDK.

**Tech Stack:** Node 22, Express 5, CommonJS, Postgres, global `fetch`, Jest + supertest. Reuses the v1 comment codec, FBAnchor highlighting, and the docs shell/SDK.

**Spec:** `docs/superpowers/specs/2026-10-06-docs-repo-switcher-design.md`

## Global Constraints

- Node 22, CommonJS. **No new runtime dependency** — GitHub API via global `fetch`.
- Files read via the **GitHub API** everywhere; **no clones, no disk, no Railway volume**. The v1 local-clone `docSource` is replaced.
- **Per-org registry** (`docs_repos`), unique `(org_id, owner, repo)`. GitHub remains the only store for doc content and comments.
- `/docs` is **login-gated**: viewing → `requireOrg`; add/remove repos → `requireAdmin`.
- **Single configured token** (`DOCS_GITHUB_TOKEN` → `GITHUB_TOKEN` → `gh auth token`), server-side only, behind a resolution seam. Comments authored as that account.
- Security: add-by-URL accepts **github.com only**, parses `owner/repo`, **verifies access via `GET /repos/{owner}/{repo}`** before storing; the server only calls `api.github.com` with parsed `owner/repo` (never the raw URL). `path` validated (no `..`/absolute/non-`.md`); `ref` is a 7–64 hex sha or a branch name; `owner/repo` always from the registry.
- Conventional Commits, **no footer** (match repo history).

## Review Focus

- **Cross-org repo access** — a `?repo=<id>` belonging to another org must 404, never read. → Task 4 route-scope test.
- **Non-github / malformed add URL** (`https://evil.com/x`, `git@…`, `javascript:`): rejected with 400, no API call to a foreign host. → Task 2 `parseGithubUrl` + add-route tests.
- **Private/inaccessible repo add** — token can't see it → 404/403 from verify, not stored. → Task 2 add test (fake 404).
- **Missing token** — a clear, actionable error (not a stack trace) and `/docs/enabled` returns false. → Task 4 token-resolution + `/docs/enabled` test.
- **Path/ref injection into the API URL** (`path=../../`, `sha=../other/repo`): rejected before any fetch. → Task 3 validation tests.

---

### Task 1: `docs_repos` registry table

**Files:**
- Modify: `src/db.js` (add table in `initDb`, with the other multi-tenancy tables)
- Test: `tests/docs-repos-schema.test.js`

**Interfaces:**
- Produces: a `docs_repos` table — `id, org_id (FK organizations ON DELETE CASCADE), owner, repo, html_url, default_branch, created_by, created_at`, `UNIQUE(org_id, owner, repo)`.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run to verify it fails** — `npx jest tests/docs-repos-schema.test.js -i` → FAIL (no table).

- [ ] **Step 3: Implement** — in `src/db.js` `initDb`, alongside the other `CREATE TABLE IF NOT EXISTS` statements (after the `organizations` table exists), add:

```js
  await _pool.query(`
    CREATE TABLE IF NOT EXISTS docs_repos (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      html_url TEXT NOT NULL,
      default_branch TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (org_id, owner, repo)
    )
  `);
```

- [ ] **Step 4: Run to verify it passes** — `npx jest tests/docs-repos-schema.test.js -i` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db.js tests/docs-repos-schema.test.js
git commit -m "feat(docs): add per-org docs_repos registry table"
```

---

### Task 2: Registry service (`docsRepos`) — parse, verify, CRUD

**Files:**
- Create: `src/services/docsRepos.js`
- Test: `tests/docs-repos.test.js`

**Interfaces:**
- Consumes: `getDb()`; a GitHub token; `fetchImpl` (injectable).
- Produces:
  - `parseGithubUrl(url)` → `{ owner, repo }`; throws `Error('not a github.com url')` / `Error('could not parse owner/repo')` for anything else. Accepts `https://github.com/o/r`, `…/o/r.git`, trailing slash.
  - `addRepo({ orgId, url, userId, token, fetchImpl? })` → the created row. Verifies `GET /repos/{owner}/{repo}` (200 → store with `default_branch`; 404/403 → throw `Error('no access')`). Duplicate → throw with `code:'23505'` propagated.
  - `listRepos(orgId)` → rows ordered by `created_at`.
  - `getRepo(orgId, id)` → row or null (scoped to org).
  - `removeRepo(orgId, id)` → boolean.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run to verify it fails** — `npx jest tests/docs-repos.test.js -i` → FAIL (module missing).

- [ ] **Step 3: Implement**

```js
// src/services/docsRepos.js
// Per-org registry of GitHub repos usable in the Docs workflow. Repos are added
// by URL (validated + access-verified against the GitHub API), never cloned.
const { nanoid } = require('nanoid');
const { getDb } = require('../db');

function parseGithubUrl(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { throw new Error('invalid url'); }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'github.com') {
    throw new Error('not a github.com url');
  }
  const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) throw new Error('could not parse owner/repo');
  return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
}

async function verifyAccess(owner, repo, token, fetchImpl) {
  const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'protoshare-docs' },
  });
  if (!res.ok) throw new Error(`no access to ${owner}/${repo} (GitHub ${res.status})`);
  return res.json();
}

async function addRepo({ orgId, url, userId, token, fetchImpl = fetch }) {
  const { owner, repo } = parseGithubUrl(url);
  const meta = await verifyAccess(owner, repo, token, fetchImpl);
  const id = nanoid(12);
  const html = `https://github.com/${owner}/${repo}`;
  const { rows } = await getDb().query(
    `INSERT INTO docs_repos (id, org_id, owner, repo, html_url, default_branch, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [id, orgId, owner, repo, html, meta.default_branch || 'main', userId || null, new Date().toISOString()]);
  return rows[0];
}

async function listRepos(orgId) {
  const { rows } = await getDb().query('SELECT * FROM docs_repos WHERE org_id = $1 ORDER BY created_at ASC', [orgId]);
  return rows;
}
async function getRepo(orgId, id) {
  const { rows } = await getDb().query('SELECT * FROM docs_repos WHERE org_id = $1 AND id = $2', [orgId, id]);
  return rows[0] || null;
}
async function removeRepo(orgId, id) {
  const { rowCount } = await getDb().query('DELETE FROM docs_repos WHERE org_id = $1 AND id = $2', [orgId, id]);
  return rowCount > 0;
}

module.exports = { parseGithubUrl, addRepo, listRepos, getRepo, removeRepo };
```

- [ ] **Step 4: Run to verify it passes** — `npx jest tests/docs-repos.test.js -i` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/docsRepos.js tests/docs-repos.test.js
git commit -m "feat(docs): per-org repo registry with add-by-url validation + access verify"
```

---

### Task 3: GitHub-API `docSource` reader (replaces the local-clone reader)

**Files:**
- Rewrite: `src/services/docSource.js`
- Rewrite: `tests/doc-source.test.js` (fake `fetch`, no git fixture)

**Interfaces:**
- Produces `createDocSource({ owner, repo, token, defaultBranch = 'main', fetchImpl = fetch })` →
  - `listDocs()` → `[{ path, title, created }]` — git-trees API (`recursive=1`), `type==='blob'` and `path` ends `.md`, excluding `README.md`/`CLAUDE.md`; `title` filename-derived; `created` = date from one recent-commits scan (else `null`).
  - `resolveVersionSha(path)` → latest commit sha touching `path` (commits API, `per_page=1`), or `null`.
  - `readDoc(path, ref)` → `{ raw, versionSha, dirty:false }` — contents API at `ref` (default branch when omitted); `versionSha` = `resolveVersionSha(path)`; frontmatter/H1 title parsing available to the route.
  - `recentVersions(path, limit=20)` → `[{ sha, date, subject }]` (commits API).
  - Validates `path` (no `..`/absolute/non-`.md`) and `ref` (`^[0-9a-f]{7,64}$` or a branch name) before building any URL.
  - A small per-instance TTL cache for trees/contents/commits.

- [ ] **Step 1: Write the failing test**

```js
// tests/doc-source.test.js
const { createDocSource, assertSafePath } = require('../src/services/docSource');

// fake fetch keyed by URL substring
function fake(routes) {
  return async (url) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    const r = key ? routes[key] : { status: 404, json: {} };
    return { ok: (r.status || 200) < 400, status: r.status || 200, async json() { return r.json; }, async text() { return r.text || ''; } };
  };
}

const base64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('listDocs filters .md blobs and excludes README/CLAUDE', async () => {
  const ds = createDocSource({ owner: 'o', repo: 'r', token: 't', fetchImpl: fake({
    '/git/trees/main': { json: { tree: [
      { path: 'guide/intro.md', type: 'blob' },
      { path: 'README.md', type: 'blob' },
      { path: 'img/logo.png', type: 'blob' },
      { path: 'guide', type: 'tree' },
    ] } },
    '/commits?': { json: [] },
  }) });
  const docs = await ds.listDocs();
  expect(docs.map((d) => d.path)).toEqual(['guide/intro.md']);
  expect(docs[0]).toHaveProperty('title');
  expect(docs[0]).toHaveProperty('created');
});

test('readDoc decodes contents at a ref and resolves the version sha', async () => {
  const ds = createDocSource({ owner: 'o', repo: 'r', token: 't', fetchImpl: fake({
    '/contents/guide/intro.md': { json: { content: base64('# Intro\nhi'), encoding: 'base64' } },
    '/commits?path=guide%2Fintro.md': { json: [{ sha: 'abcdef1234567' }] },
  }) });
  const doc = await ds.readDoc('guide/intro.md');
  expect(doc.raw).toContain('# Intro');
  expect(doc.versionSha).toBe('abcdef1234567');
  expect(doc.dirty).toBe(false);
});

test('rejects unsafe path and bad ref before fetching', async () => {
  const ds = createDocSource({ owner: 'o', repo: 'r', token: 't', fetchImpl: fake({}) });
  await expect(ds.readDoc('../../etc/passwd')).rejects.toThrow(/unsafe/i);
  await expect(ds.readDoc('a/b.md', 'not a ref!')).rejects.toThrow(/ref/i);
});
```

- [ ] **Step 2: Run to verify it fails** — `npx jest tests/doc-source.test.js -i` → FAIL (new API).

- [ ] **Step 3: Implement**

```js
// src/services/docSource.js
// Reads a GitHub repo's Markdown over the REST API (no clone). Behind the same
// surface the /docs routes expect. Paths/refs are validated before use; a small
// TTL cache keeps browsing responsive and under rate limits.
const path = require('path');
const IGNORED = new Set(['README.md', 'CLAUDE.md']);
const API = 'https://api.github.com';

function assertSafePath(p) {
  const norm = path.posix.normalize(String(p || ''));
  if (!norm.endsWith('.md') || norm.startsWith('/') || norm.startsWith('..') || norm.includes('../')) {
    throw new Error(`unsafe doc path: ${p}`);
  }
  return norm;
}
function assertRef(ref) {
  if (ref == null) return;
  if (!/^[0-9a-f]{7,64}$/.test(ref) && !/^[\w.\-/]{1,120}$/.test(ref)) throw new Error(`invalid ref: ${ref}`);
}
function titleFromPath(p) { return path.posix.basename(p).replace(/\.md$/, ''); }

function createDocSource({ owner, repo, token, defaultBranch = 'main', fetchImpl = fetch, ttlMs = 15000 }) {
  const cache = new Map(); // key -> { at, val }
  async function gh(pathAndQuery) {
    const now = Date.now();
    const hit = cache.get(pathAndQuery);
    if (hit && now - hit.at < ttlMs) return hit.val;
    const res = await fetchImpl(`${API}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'protoshare-docs' },
    });
    if (!res.ok) throw new Error(`GitHub GET ${pathAndQuery} -> ${res.status}`);
    const val = await res.json();
    cache.set(pathAndQuery, { at: now, val });
    return val;
  }

  async function listDocs() {
    const tree = await gh(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`);
    const paths = (tree.tree || [])
      .filter((n) => n.type === 'blob' && n.path.endsWith('.md') && !IGNORED.has(path.posix.basename(n.path)))
      .map((n) => n.path);
    // one bounded recent-commits scan for best-effort creation dates
    const dates = {};
    try {
      const commits = await gh(`/repos/${owner}/${repo}/commits?per_page=100`);
      for (const c of (commits || [])) {
        const d = c.commit && c.commit.committer && c.commit.committer.date;
        if (d && Array.isArray(c.files)) for (const f of c.files) if (f.filename && !(f.filename in dates)) dates[f.filename] = d;
      }
    } catch { /* best-effort */ }
    return paths.sort().map((p) => ({ path: p, title: titleFromPath(p), created: dates[p] || null }));
  }

  async function resolveVersionSha(p) {
    const safe = assertSafePath(p);
    const rows = await gh(`/repos/${owner}/${repo}/commits?path=${encodeURIComponent(safe)}&per_page=1`);
    return (rows && rows[0] && rows[0].sha) || null;
  }

  async function readDoc(p, ref) {
    const safe = assertSafePath(p);
    assertRef(ref);
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const data = await gh(`/repos/${owner}/${repo}/contents/${safe.split('/').map(encodeURIComponent).join('/')}${q}`);
    const raw = data.encoding === 'base64' ? Buffer.from(data.content, 'base64').toString('utf8') : (data.content || '');
    const versionSha = ref && /^[0-9a-f]{7,64}$/.test(ref) ? ref : await resolveVersionSha(safe);
    return { raw, versionSha, dirty: false };
  }

  async function recentVersions(p, limit = 20) {
    const safe = assertSafePath(p);
    const rows = await gh(`/repos/${owner}/${repo}/commits?path=${encodeURIComponent(safe)}&per_page=${limit}`);
    return (rows || []).map((c) => ({ sha: c.sha, date: (c.commit && c.commit.committer && c.commit.committer.date) || '', subject: (c.commit && c.commit.message || '').split('\n')[0] }));
  }

  return { listDocs, resolveVersionSha, readDoc, recentVersions, owner, repo };
}

module.exports = { createDocSource, assertSafePath };
```

- [ ] **Step 4: Run to verify it passes** — `npx jest tests/doc-source.test.js -i` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/docSource.js tests/doc-source.test.js
git commit -m "feat(docs): read repo files via the GitHub API (replaces local-clone reader)"
```

---

### Task 4: Repo-scoped, login-gated routes + registry endpoints + mount

**Files:**
- Rewrite: `src/routes/docs.js`
- Modify: `src/server.js` (mount `/docs` behind the router's own guards; drop the `DOCS_REPO_PATH` gate)
- Modify: `src/config.js` (drop `docsRepoPath`; add `canUseDocs()` token check)
- Rewrite: `tests/docs-mount.test.js` (the v1 test asserted a 404 when `DOCS_REPO_PATH` was unset; that gate is retired)
- Test: `tests/docs-routes.test.js` (rewrite for repo scoping + guards + registry)

**Interfaces:**
- Consumes: `docsRepos` (Task 2), `createDocSource` (Task 3), `ghComments`+`resolveToken` (v1), `orgs.requireOrg`/`requireAdmin`, `markdown`.
- Produces `createDocsRouter(deps?)` mounting:
  - `GET /docs/enabled` — **no auth** — `{ enabled: <token resolvable> }` (for the landing check).
  - `GET /docs` (requireOrg) — shell with the org's repos + active repo.
  - `GET /docs/view?repo=&path=&sha=` (requireOrg) — rendered doc; 404 if `repo` not in the caller's org.
  - `GET /docs/comments?repo=&path=&sha=` / `POST` / `DELETE /docs/comments/:id?repo=` (requireOrg) — GitHub commit comments for that repo.
  - `GET /docs/repos` (requireOrg) — the org's registry.
  - `POST /docs/repos {url}` (requireAdmin) — add; 400 bad url, 409 duplicate, 502 no-access.
  - `DELETE /docs/repos/:id` (requireAdmin) — remove.
- `deps` (tests): `{ docsRepos, makeDocSource, makeGhComments, markdown, readView, tokenAvailable }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/docs-routes.test.js
const express = require('express');
const request = require('supertest');
const { createDocsRouter } = require('../src/routes/docs');

function app(overrides = {}) {
  const repos = { r1: { id: 'r1', org_id: 'org1', owner: 'acme', repo: 'widgets', html_url: 'h', default_branch: 'main' } };
  const deps = {
    tokenAvailable: () => true,
    docsRepos: {
      listRepos: async () => Object.values(repos),
      getRepo: async (org, id) => (repos[id] && repos[id].org_id === org ? repos[id] : null),
      addRepo: async ({ url }) => ({ id: 'r2', owner: 'new', repo: 'repo', url }),
      removeRepo: async () => true,
    },
    makeDocSource: () => ({
      listDocs: async () => [{ path: 'a.md', title: 'A', created: null }],
      readDoc: async () => ({ raw: '# A\n', versionSha: 'abc1234', dirty: false }),
      recentVersions: async () => [],
    }),
    makeGhComments: () => ({ list: async () => [{ id: 1, kind: 'note', text: 'hi' }], post: async () => ({ id: 2 }), del: async () => {} }),
    markdown: require('../src/services/markdown'),
    readView: () => '<!doctype html><body>{{content}}<script id="docs-cfg">{{cfg}}</script></body>',
    // test shims for the org guards:
    requireOrg: (req, _res, next) => { req.orgId = 'org1'; req.orgRole = req.headers['x-role'] || 'admin'; next(); },
    requireAdmin: (req, res, next) => { req.orgId = 'org1'; if ((req.headers['x-role'] || 'admin') !== 'admin') return res.status(403).json({ error: 'admin' }); next(); },
    ...overrides,
  };
  const a = express(); a.use(express.json());
  a.use('/docs', createDocsRouter(deps));
  return a;
}

test('GET /docs/enabled is public and reports token availability', async () => {
  const res = await request(app()).get('/docs/enabled');
  expect(res.status).toBe(200); expect(res.body).toEqual({ enabled: true });
  const res2 = await request(app({ tokenAvailable: () => false })).get('/docs/enabled');
  expect(res2.body).toEqual({ enabled: false });
});

test('GET /docs/view 404s for a repo outside the caller org', async () => {
  const res = await request(app()).get('/docs/view').query({ repo: 'nope', path: 'a.md' });
  expect(res.status).toBe(404);
});

test('GET /docs/view renders for an in-org repo', async () => {
  const res = await request(app()).get('/docs/view').query({ repo: 'r1', path: 'a.md' });
  expect(res.status).toBe(200);
  expect(res.text).toContain('data-source-line'); // sourceLines render
  expect(res.text).toContain('abc1234');          // version sha in cfg
});

test('GET /docs/comments is repo-scoped', async () => {
  const res = await request(app()).get('/docs/comments').query({ repo: 'r1', path: 'a.md', sha: 'abc1234' });
  expect(res.status).toBe(200); expect(res.body[0]).toMatchObject({ kind: 'note' });
});

test('POST /docs/repos requires admin', async () => {
  const ok = await request(app()).post('/docs/repos').send({ url: 'https://github.com/new/repo' });
  expect(ok.status).toBe(201);
  const no = await request(app()).post('/docs/repos').set('x-role', 'viewer').send({ url: 'https://github.com/new/repo' });
  expect(no.status).toBe(403);
});

test('POST /docs/repos maps a bad url to 400', async () => {
  const bad = await request(app({ docsRepos: { addRepo: async () => { const e = new Error('not a github.com url'); throw e; }, listRepos: async () => [], getRepo: async () => null, removeRepo: async () => true } }))
    .post('/docs/repos').send({ url: 'https://evil.com/x/y' });
  expect(bad.status).toBe(400);
});
```

- [ ] **Step 2: Run to verify it fails** — `npx jest tests/docs-routes.test.js -i` → FAIL.

- [ ] **Step 3: Implement the router**

```js
// src/routes/docs.js
const fs = require('fs');
const path = require('path');
const express = require('express');

function defaultReadView(name) { return fs.readFileSync(path.join(__dirname, '..', 'views', name), 'utf8'); }
const SHA_RE = /^[0-9a-f]{7,64}$/;

function buildRealDeps() {
  const orgs = require('../services/orgs');
  const docsRepos = require('../services/docsRepos');
  const markdown = require('../services/markdown');
  const { createDocSource } = require('../services/docSource');
  const { createGhComments, resolveToken } = require('../services/ghComments');
  let cachedToken;
  const token = () => (cachedToken !== undefined ? cachedToken : (cachedToken = (() => { try { return resolveToken(); } catch { return null; } })()));
  return {
    docsRepos, markdown, readView: defaultReadView,
    requireOrg: orgs.requireOrg, requireAdmin: orgs.requireAdmin,
    tokenAvailable: () => !!token(),
    makeDocSource: (row) => createDocSource({ owner: row.owner, repo: row.repo, token: token(), defaultBranch: row.default_branch }),
    makeGhComments: (row) => createGhComments({ owner: row.owner, repo: row.repo, token: token() }),
  };
}

function createDocsRouter(deps) {
  const d = deps || buildRealDeps();
  const router = express.Router();
  const esc = (s) => JSON.stringify(s).replace(/</g, '\\u003c');

  // public: landing feature-check
  router.get('/enabled', (_req, res) => res.json({ enabled: !!d.tokenAvailable() }));

  // resolve + scope a repo row to the caller's org, or 404
  async function repoOr404(req, res) {
    const row = await d.docsRepos.getRepo(req.orgId, req.query.repo);
    if (!row) { res.status(404).send('Repo not found.'); return null; }
    return row;
  }

  router.get('/', d.requireOrg, async (req, res, next) => {
    try {
      const repos = await d.docsRepos.listRepos(req.orgId);
      const cfg = { mode: 'home', repos, role: req.orgRole };
      res.send(d.readView('docs-shell.html').split('{{banner}}').join('').split('{{content}}').join('').split('{{cfg}}').join(esc(cfg)));
    } catch (e) { next(e); }
  });

  router.get('/view', d.requireOrg, async (req, res, next) => {
    try {
      const row = await repoOr404(req, res); if (!row) return;
      const ds = d.makeDocSource(row);
      const { raw, versionSha, dirty } = await ds.readDoc(req.query.path, req.query.sha || undefined);
      const { html } = d.markdown.render(raw, { sourceLines: true });
      const banner = dirty ? '' : '';
      const repos = await d.docsRepos.listRepos(req.orgId);
      const versions = await ds.recentVersions(req.query.path).catch(() => []);
      const cfg = { mode: 'view', repo: row.id, repos, role: req.orgRole, path: req.query.path, sha: versionSha, commentable: !!versionSha, versions };
      res.send(d.readView('docs-shell.html').split('{{banner}}').join(banner).split('{{content}}').join(html).split('{{cfg}}').join(esc(cfg)));
    } catch (e) { next(e); }
  });

  router.get('/comments', d.requireOrg, async (req, res, next) => {
    try {
      const row = await repoOr404(req, res); if (!row) return;
      if (req.query.sha && !SHA_RE.test(req.query.sha)) return res.status(400).json({ error: 'invalid sha' });
      res.json(await d.makeGhComments(row).list(req.query.sha, req.query.path));
    } catch (e) { next(e); }
  });

  router.post('/comments', d.requireOrg, async (req, res, next) => {
    try {
      const row = await d.docsRepos.getRepo(req.orgId, req.body.repo);
      if (!row) return res.status(404).json({ error: 'repo not found' });
      const ds = d.makeDocSource(row);
      const doc = await ds.readDoc(req.body.path, req.body.sha || undefined);
      if (!doc.versionSha) return res.status(409).json({ error: 'no committed version' });
      const created = await d.makeGhComments(row).post(doc.versionSha, req.body);
      res.status(201).json(created);
    } catch (e) { next(e); }
  });

  router.delete('/comments/:id', d.requireOrg, async (req, res, next) => {
    try {
      const row = await repoOr404(req, res); if (!row) return;
      await d.makeGhComments(row).del(req.params.id);
      res.status(204).end();
    } catch (e) { next(e); }
  });

  router.get('/repos', d.requireOrg, async (req, res, next) => {
    try { res.json(await d.docsRepos.listRepos(req.orgId)); } catch (e) { next(e); }
  });

  router.post('/repos', d.requireAdmin, async (req, res, next) => {
    try {
      const row = await d.docsRepos.addRepo({ orgId: req.orgId, url: req.body.url, userId: req.session && req.session.userId });
      res.status(201).json(row);
    } catch (e) {
      if (e && e.code === '23505') return res.status(409).json({ error: 'already added' });
      if (/github\.com|owner\/repo|invalid url/i.test(e.message)) return res.status(400).json({ error: e.message });
      if (/no access/i.test(e.message)) return res.status(502).json({ error: e.message });
      next(e);
    }
  });

  router.delete('/repos/:id', d.requireAdmin, async (req, res, next) => {
    try { res.json({ removed: await d.docsRepos.removeRepo(req.orgId, req.params.id) }); } catch (e) { next(e); }
  });

  return router;
}

module.exports = { createDocsRouter };
```

Note: `addRepo` in real wiring needs the token; `buildRealDeps` wraps `docsRepos.addRepo` to inject it:

```js
// in buildRealDeps(), wrap addRepo so the route call site stays token-free:
const bareRepos = require('../services/docsRepos');
const docsRepos = { ...bareRepos, addRepo: (args) => bareRepos.addRepo({ ...args, token: token() }) };
```
(Place this in `buildRealDeps` and return that `docsRepos`.)

- [ ] **Step 4: Config + mount**

In `src/config.js`: remove the `docsRepoPath` line (retired).
In `src/server.js`: replace the `if (config.docsRepoPath) { … }` mount with an unconditional, self-guarding mount:

```js
// Docs workflow (login-gated inside the router; GitHub-API backed).
app.use('/docs', require('./routes/docs').createDocsRouter());
```

- [ ] **Step 5: Run tests** — `npx jest tests/docs-routes.test.js -i` → PASS; then `npm test` (keep green).

- [ ] **Step 5b: Retire the obsolete mount test** — the v1 `tests/docs-mount.test.js` asserted `GET /docs` → 404 when `DOCS_REPO_PATH` is unset. `/docs` now mounts unconditionally and is login-gated, so rewrite that file to assert the new contract instead:

```js
// tests/docs-mount.test.js
const request = require('supertest');
function freshApp() { jest.resetModules(); return require('../src/server'); }

test('/docs/enabled is public (no login) and returns JSON', async () => {
  const res = await request(freshApp()).get('/docs/enabled');
  expect(res.status).toBe(200);
  expect(typeof res.body.enabled).toBe('boolean');
});

test('/docs requires login (redirects or 403 when unauthenticated)', async () => {
  const res = await request(freshApp()).get('/docs').redirects(0);
  expect([302, 401, 403]).toContain(res.status);
});
```

- [ ] **Step 6: Commit**

```bash
git add src/routes/docs.js src/server.js src/config.js tests/docs-routes.test.js tests/docs-mount.test.js
git commit -m "feat(docs): repo-scoped, login-gated routes with registry CRUD + /docs/enabled"
```

---

### Task 5: Repo switcher + add/remove UI in the docs SDK/shell

**Files:**
- Modify: `src/views/docs-shell.html` (top-bar: repo `<select>` + "Add repo" + remove; CSS)
- Modify: `public/sdk/docs.js` (read `cfg.repos`/`cfg.repo`/`cfg.role`; thread `repo` into every fetch + view link; add/remove calls; home/empty state)
- Test: `tests/docs-sdk.test.js` (extend)

**Interfaces:**
- Consumes: `GET/POST/DELETE /docs/repos`, repo-scoped `/docs/*` (Task 4).
- Produces pure helpers (exported for tests): `repoViewHref(repo, path, sha?)`, `addRepoPayload(url)`, plus the existing `nearestSourceLine`/`buildTree`/`commentPayload` unchanged.

- [ ] **Step 1: Write the failing test**

```js
// tests/docs-sdk.test.js  (add to existing)
const { repoViewHref, addRepoPayload } = require('../public/sdk/docs.js');
test('repoViewHref builds a repo-scoped view url', () => {
  expect(repoViewHref('r1', 'guide/intro.md')).toBe('/docs/view?repo=r1&path=guide%2Fintro.md');
  expect(repoViewHref('r1', 'a.md', 'abc1234')).toBe('/docs/view?repo=r1&path=a.md&sha=abc1234');
});
test('addRepoPayload wraps a url', () => {
  expect(addRepoPayload(' https://github.com/a/b ')).toEqual({ url: 'https://github.com/a/b' });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx jest tests/docs-sdk.test.js -i` → FAIL.

- [ ] **Step 3: Implement**

In `public/sdk/docs.js`, add the pure helpers near the other exports and include them in `module.exports`:

```js
function repoViewHref(repo, p, sha) {
  let u = `/docs/view?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(p)}`;
  if (sha) u += `&sha=${encodeURIComponent(sha)}`;
  return u;
}
function addRepoPayload(url) { return { url: String(url).trim() }; }
// …
module.exports = { nearestSourceLine, buildTree, commentPayload, repoViewHref, addRepoPayload };
```

Then, inside the `typeof document !== 'undefined'` block, thread `repo`:
- `cfg` now carries `repo`, `repos`, `role`. Tree file links use `repoViewHref(cfg.repo, path)`.
- `loadComments`/`postComment`/`deleteComment` include `repo: cfg.repo` in the query/body.
- Render a **repo switcher** `<select id="docs-repo">` from `cfg.repos` (selected = `cfg.repo`); on change → `location.href = '/docs?repo=' + id` (home) or `repoViewHref(id, firstDocOrHome)`.
- If `cfg.role === 'admin'`: show an **"Add repo"** control (prompt or small inline input) → `POST /docs/repos` with `addRepoPayload(url)`; on 201 reload; on 400/409/502 show the returned error. Show a **remove** affordance per repo.
- Home mode (`cfg.mode === 'home'`): render the repo list + empty state ("Add a GitHub repo to get started") instead of a document.

In `src/views/docs-shell.html`: add the repo `<select>` + "Add repo" button to the top bar (next to the version switcher), styled with the existing palette; keep the version switcher.

- [ ] **Step 4: Run tests** — `npx jest tests/docs-sdk.test.js -i` → PASS; manual browser check deferred to the end.

- [ ] **Step 5: Commit**

```bash
git add public/sdk/docs.js src/views/docs-shell.html tests/docs-sdk.test.js
git commit -m "feat(docs): repo switcher + add/remove UI; thread repo through the client"
```

---

### Task 6: Landing "Go to Wiki" uses `/docs/enabled`

**Files:**
- Modify: `src/views/landing.html` (swap the `HEAD /docs` check for `GET /docs/enabled`)

**Interfaces:** Consumes `GET /docs/enabled` (Task 4). `/docs` is now login-gated, so a `HEAD /docs` would 302/403 for anonymous visitors; the public `enabled` endpoint is the correct signal.

- [ ] **Step 1: Change the feature-check** — replace the landing's reveal script:

```html
<script>
  fetch('/docs/enabled').then(function (r) { return r.ok ? r.json() : { enabled: false }; })
    .then(function (j) { if (j.enabled) { var w = document.getElementById('wiki-btn'); if (w) w.style.display = 'inline-flex'; } })
    .catch(function () {});
</script>
```

- [ ] **Step 2: Verify** — `curl -s localhost:<port>/docs/enabled` returns `{"enabled":true}` when a token is configured; the button reveals.

- [ ] **Step 3: Commit**

```bash
git add src/views/landing.html
git commit -m "feat(landing): reveal Go to Wiki via public /docs/enabled check"
```

---

### Task 7: Future plan — per-user GitHub OAuth

**Files:**
- Create: `docs/superpowers/plans/2026-10-06-future-per-user-github-oauth.md`

- [ ] **Step 1: Write the future plan** — a design/plan doc (not implemented now) covering: GitHub OAuth App vs GitHub App choice; the connect/callback flow; encrypted per-user token storage (table or Supabase); using the acting user's token for reads and comment authorship; mapping GitHub identity ↔ ProtoLab user; migration from the single configured token (the `token()` seam in `buildRealDeps`); rate-limit implications; and the security review checklist. Note it is **free from GitHub within rate limits**; the cost is build effort.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-10-06-future-per-user-github-oauth.md
git commit -m "docs: future plan for per-user GitHub OAuth in the docs workflow"
```

---

## Final verification (after all tasks)

- `npm test && npm run lint` green.
- Manual (local): `DOCS_GITHUB_TOKEN=$(gh auth token) PORT=1338 npm start` → log in → `/docs`:
  add a repo by URL, confirm it persists (restart), switch repos, browse a doc,
  comment, and confirm cross-org isolation (a `?repo=` from another org 404s).
- Confirm no `DOCS_REPO_PATH` is required anywhere.
