# Local-AI Integration — Phase 3 (comment resolution + token UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn "fetch the feedback" into an iterative, converging loop: comments gain resolution state, the agent (via a new REST endpoint + MCP tool) marks feedback resolved-in-vN after pushing a fix, and the feedback payload reports `resolved` so the next pull surfaces only genuinely open comments. Plus the UI polish the earlier phases deferred: an account-level **API Tokens** management panel and a **version history** display in the prototype detail view.

**Architecture:** Two independent slices, both additive. (A) **Resolution** — two nullable columns on `comments` (`resolved_at`, `resolved_in_version`), a single owner-scoped `POST …/comments/:commentId/resolve` endpoint, the `resolved` boolean in the feedback payload wired to real data, and a `protoshare_resolve` MCP tool. (B) **UI** — an *account-scoped* API-token panel at `/admin/tokens` (a new page, since tokens are per-user not per-prototype) reusing the Phase 1 token endpoints, and a read-only version-history list added to the prototype detail page reading `GET /admin/prototypes/:id/versions`.

**Tech Stack:** Existing Express 5 / `pg` / Jest+supertest backend; server-rendered HTML views with vanilla JS (matching the existing admin views); the Phase 2 MCP client/handlers for the new tool.

---

## File Structure

```
src/db.js                              # MODIFY — add resolved_at, resolved_in_version columns to comments (idempotent).
src/routes/apiV1.js                    # MODIFY — feedback `resolved` from resolved_at; add POST resolve endpoint.
src/routes/admin.js                    # MODIFY — add GET /admin/tokens (page) + GET /admin/prototypes/:id/versions (JSON).
src/views/admin-tokens.html            # NEW — account-level token management page.
src/views/admin-prototypes.html        # MODIFY — add an "API Tokens" nav link in the topbar.
src/views/admin-prototype-detail.html  # MODIFY — add a "Versions" tab showing version history.
mcp/lib/client.cjs                     # MODIFY — add resolveComment(id, commentId, version?).
mcp/lib/handlers.cjs                   # MODIFY — add resolve handler.
mcp/server.mjs                         # MODIFY — register protoshare_resolve tool.
tests/resolution.test.js               # NEW — resolve endpoint + feedback `resolved` reflects it; cross-tenant 404.
tests/admin-versions.test.js           # NEW — GET /admin/prototypes/:id/versions owner-scoped JSON.
tests/mcp-handlers.test.js             # MODIFY — add resolve handler test.
tests/mcp-client.test.js               # MODIFY — add resolveComment request test.
```

---

## Task 1: DB — resolution columns on `comments`

**Files:**
- Modify: `src/db.js` (after the existing section H `version_id` ALTER, ~line 203)
- Test: `tests/resolution.test.js` (schema portion)

- [ ] **Step 1: Write the failing test** (schema check only; endpoint tests come in Task 2)

```javascript
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

let app, userId, otherUserId, protoId, rawToken, otherToken, v1Id, commentId;

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
    ({ raw: rawToken } = await tokens.createToken(userId, 't'));
    ({ raw: otherToken } = await tokens.createToken(otherUserId, 't'));

    protoId = nanoid(12);
    await getDb().query(
      'INSERT INTO prototypes (id,name,filename,share_token,created_at,owner_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [protoId, 'Res', `${protoId}.html`, nanoid(12), new Date().toISOString(), userId]);
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

  // --- endpoint tests added in Task 2 ---
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `DATABASE_URL='postgresql://postgres:postgres@localhost:5433/postgres' PGSSLMODE=disable npx jest tests/resolution.test.js`
Expected: FAIL — the schema test fails (columns absent) and the endpoint tests 404/500 (route not added yet).

- [ ] **Step 3: Add the columns in `src/db.js`** — immediately after section H (the `version_id` ALTER on `comments`, ~line 203), add:

```javascript
  // J. Comment resolution (Phase 3): when the agent addresses feedback it stamps
  //    resolved_at + the version that fixed it, so pulls can surface only open items.
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS resolved_at TEXT`);
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS resolved_in_version INTEGER`);
```

- [ ] **Step 4: Run the schema test to verify it passes**

Run: `DATABASE_URL='postgresql://postgres:postgres@localhost:5433/postgres' PGSSLMODE=disable npx jest tests/resolution.test.js -t 'resolved_at'`
Expected: the schema test PASSES. (Endpoint tests still fail — Task 2.)

- [ ] **Step 5: Commit**

```bash
git add src/db.js tests/resolution.test.js
git commit -m "feat(db): add resolved_at + resolved_in_version to comments (Phase 3)"
```

---

## Task 2: REST — resolve endpoint + `resolved` in feedback payload

**Files:**
- Modify: `src/routes/apiV1.js` (feedback handler ~lines 63-80; add new route after publish ~line 181)
- Test: `tests/resolution.test.js` (endpoint tests, already written in Task 1)

- [ ] **Step 1: Confirm the endpoint tests currently fail**

Run: `DATABASE_URL='postgresql://postgres:postgres@localhost:5433/postgres' PGSSLMODE=disable npx jest tests/resolution.test.js`
Expected: schema + "unresolved before resolve" pass; the resolve POST tests FAIL (route missing → 404/500 but not the asserted shape).

- [ ] **Step 2: Wire `resolved` into the feedback payload.** In `src/routes/apiV1.js`, the feedback query (~line 63) currently selects `... parent_id, version_id`. Add the two columns:

Replace:
```javascript
      `SELECT id, email, type, element_selector, element_label, comment, page_url,
              created_at, tag, x_pct, y_pct, parent_id, version_id
       FROM comments WHERE prototype_id = $1 ORDER BY created_at ASC`, [proto.id]);
```
with:
```javascript
      `SELECT id, email, type, element_selector, element_label, comment, page_url,
              created_at, tag, x_pct, y_pct, parent_id, version_id,
              resolved_at, resolved_in_version
       FROM comments WHERE prototype_id = $1 ORDER BY created_at ASC`, [proto.id]);
```

Then in the `comments` mapping (~line 73-80), replace `resolved: false, // Phase 3 fills this` with:
```javascript
      resolved: !!r.resolved_at,
      resolvedInVersion: r.resolved_in_version ?? null,
```

- [ ] **Step 3: Add the resolve route** after the publish route (~line 181, before `module.exports`):

```javascript
// POST /prototypes/:id/comments/:commentId/resolve — mark a comment addressed.
// Idempotent: re-resolving updates the version stamp. Owner-scoped; a comment
// that isn't on a prototype you own (or doesn't exist) → 404.
router.post('/prototypes/:id/comments/:commentId/resolve', async (req, res) => {
  try {
    if (!await getOwned(req.params.id, req.userId, 'id')) return res.status(404).json({ error: 'Not found.' });
    const version = req.body && req.body.version != null ? parseInt(req.body.version, 10) : null;
    if (version != null && Number.isNaN(version)) return res.status(400).json({ error: 'version must be an integer.' });
    const { rowCount } = await getDb().query(
      `UPDATE comments SET resolved_at = $1, resolved_in_version = $2
       WHERE id = $3 AND prototype_id = $4`,
      [new Date().toISOString(), version, req.params.commentId, req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Comment not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/v1/prototypes/:id/comments/:commentId/resolve error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});
```

- [ ] **Step 4: Run the full resolution suite to verify it passes**

Run: `DATABASE_URL='postgresql://postgres:postgres@localhost:5433/postgres' PGSSLMODE=disable npx jest tests/resolution.test.js`
Expected: all tests PASS (schema, unresolved-before, resolve-then-reflected, idempotent, cross-tenant 404, unknown-comment 404).

- [ ] **Step 5: Commit**

```bash
git add src/routes/apiV1.js
git commit -m "feat(api-v1): add comment resolve endpoint + resolved flag in feedback"
```

---

## Task 3: MCP — `resolveComment` client method

**Files:**
- Modify: `mcp/lib/client.cjs` (add method after `publish`)
- Modify: `tests/mcp-client.test.js` (add a test)

- [ ] **Step 1: Add the failing test** to `tests/mcp-client.test.js` (append before the final `constructor throws` test):

```javascript
test('resolveComment POSTs JSON to the resolve endpoint with the version', async () => {
  const f = fakeFetch({ json: { ok: true } });
  const c = makeClient(f);
  await c.resolveComment('p1', 'c1', 3);
  expect(f.calls[0].url).toBe('https://host.example.com/api/v1/prototypes/p1/comments/c1/resolve');
  expect(f.calls[0].opts.method).toBe('POST');
  expect(f.calls[0].opts.headers['Content-Type']).toBe('application/json');
  expect(JSON.parse(f.calls[0].opts.body)).toEqual({ version: 3 });
});

test('resolveComment omits version when not given', async () => {
  const f = fakeFetch({ json: { ok: true } });
  await makeClient(f).resolveComment('p1', 'c1');
  expect(JSON.parse(f.calls[0].opts.body)).toEqual({});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest tests/mcp-client.test.js -t resolveComment`
Expected: FAIL — `client.resolveComment is not a function`.

- [ ] **Step 3: Add the method** in `mcp/lib/client.cjs` after `publish`:

```javascript
  async resolveComment(id, commentId, version) {
    const payload = version != null ? { version } : {};
    return (await this._request(`/api/v1/prototypes/${id}/comments/${commentId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })).json();
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest tests/mcp-client.test.js`
Expected: PASS (all client tests including the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add mcp/lib/client.cjs tests/mcp-client.test.js
git commit -m "feat(mcp): add resolveComment client method"
```

---

## Task 4: MCP — `resolve` handler + tool registration

**Files:**
- Modify: `mcp/lib/handlers.cjs` (add `resolve`)
- Modify: `tests/mcp-handlers.test.js` (add a test + extend the fake client)
- Modify: `mcp/server.mjs` (register `protoshare_resolve`)

- [ ] **Step 1: Add the failing test** to `tests/mcp-handlers.test.js`. First extend the fake client in `makeCtx` (add alongside the other client methods):

```javascript
    resolveComment: async (id, commentId, v) => (calls.push(['resolveComment', id, commentId, v]), overrides.resolve || { ok: true }),
```

Then add the test:

```javascript
test('resolve marks a comment addressed in a version', async () => {
  const { ctx, calls } = makeCtx({});
  const text = await handlers.resolve(ctx, { file_or_id: 'checkout.html', comment_id: 'c1', version: 3 });
  expect(calls.find(c => c[0] === 'resolveComment')).toEqual(['resolveComment', 'ID_C', 'c1', 3]);
  expect(text).toMatch(/resolved/i);
  expect(text).toMatch(/c1/);
});

test('resolve surfaces a 404 as a clear message', async () => {
  const { ctx } = makeCtx({});
  ctx.client.resolveComment = async () => { const e = new Error('x'); e.status = 404; throw e; };
  const text = await handlers.resolve(ctx, { file_or_id: 'checkout.html', comment_id: 'nope' });
  expect(text).toMatch(/not found/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest tests/mcp-handlers.test.js -t resolve`
Expected: FAIL — `handlers.resolve is not a function`.

- [ ] **Step 3: Add the handler** in `mcp/lib/handlers.cjs` (before `module.exports`), and add `resolve` to the exports:

```javascript
async function resolve(ctx, { file_or_id, comment_id, version }) {
  const id = manifestLib.resolveId(ctx.manifest, file_or_id);
  try {
    await ctx.client.resolveComment(id, comment_id, version);
    return `Marked comment ${comment_id} resolved${version != null ? ` in v${version}` : ''}.`;
  } catch (e) {
    if (e.status === 404) return `Comment ${comment_id} not found on this prototype (or not owned by this token).`;
    throw e;
  }
}
```

Update the exports line to include `resolve`:
```javascript
module.exports = { list, pull, source, push, publish, status, resolve };
```

- [ ] **Step 4: Register the tool** in `mcp/server.mjs` after the `protoshare_status` registration:

```javascript
server.tool('protoshare_resolve', 'Mark a comment as addressed (resolved) in a given version. Run after pushing a fix so future pulls surface only open feedback.',
  { file_or_id: z.string().describe('Local HTML file or prototype id'),
    comment_id: z.string().describe('The comment id from protoshare_pull'),
    version: z.number().int().optional().describe('The version that addressed it (defaults to none)') },
  tool(handlers.resolve));
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx jest tests/mcp-handlers.test.js tests/mcp-client.test.js`
Expected: PASS (all handler + client tests).

- [ ] **Step 6: Commit**

```bash
git add mcp/lib/handlers.cjs mcp/server.mjs tests/mcp-handlers.test.js
git commit -m "feat(mcp): add protoshare_resolve tool"
```

---

## Task 5: Admin — versions JSON endpoint

**Files:**
- Modify: `src/routes/admin.js` (add route after `/prototypes/:id/preview`, ~line 343)
- Test: `tests/admin-versions.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/admin-versions.test.js
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
const session = require('express-session');
const adminRouter = require('../src/routes/admin');

let app;
const email = `ver-admin-${nanoid(8)}@sap.com`.toLowerCase();
const emailB = `ver-admin-b-${nanoid(8)}@sap.com`.toLowerCase();
const password = 'password123';

(hasDb ? describe : describe.skip)('admin versions endpoint', () => {
  let protoId;
  beforeAll(async () => {
    await initDb();
    app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    app.use('/admin', adminRouter);
    await request(app).post('/admin/signup').send(`email=${email}&password=${password}&confirm=${password}`);
    await request(app).post('/admin/signup').send(`email=${emailB}&password=${password}&confirm=${password}`);

    const agent = request.agent(app);
    await agent.post('/admin/login').send(`email=${email}&password=${password}`);
    const up = await agent.post('/admin/prototypes').set('Accept', 'application/json')
      .field('name', 'Ver').attach('file', Buffer.from('<html>v1</html>'), 'p.html');
    protoId = up.body.id;
  });
  afterAll(async () => { await closeDb(); });

  test('owner sees version history newest-first', async () => {
    const agent = request.agent(app);
    await agent.post('/admin/login').send(`email=${email}&password=${password}`);
    const res = await agent.get(`/admin/prototypes/${protoId}/versions`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject({ version: 1, status: 'published' });
  });

  test('another user gets 404 (owner-scoped)', async () => {
    const agentB = request.agent(app);
    await agentB.post('/admin/login').send(`email=${emailB}&password=${password}`);
    const res = await agentB.get(`/admin/prototypes/${protoId}/versions`);
    expect(res.status).toBe(404);
  });

  test('requires a session', async () => {
    expect((await request(app).get(`/admin/prototypes/${protoId}/versions`)).status).toBe(302);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `DATABASE_URL='postgresql://postgres:postgres@localhost:5433/postgres' PGSSLMODE=disable npx jest tests/admin-versions.test.js`
Expected: FAIL — the owner test gets 404 (route missing).

- [ ] **Step 3: Add the route** in `src/routes/admin.js` after the `/prototypes/:id/preview` handler (~line 343):

```javascript
router.get('/prototypes/:id/versions', adminAuth, async (req, res) => {
  if (!await getOwnedPrototype(req.params.id, req.session.userId, 'id')) return res.status(404).json({ error: 'Not found.' });
  const { rows } = await getDb().query(
    `SELECT v.version, v.status, v.note, v.created_at,
            (v.id = p.published_version_id) AS is_published,
            (v.id = p.draft_version_id)     AS is_draft
     FROM prototype_versions v
     JOIN prototypes p ON p.id = v.prototype_id
     WHERE v.prototype_id = $1 ORDER BY v.version DESC`,
    [req.params.id]);
  res.json(rows.map(r => ({
    version: r.version, status: r.status, note: r.note, createdAt: r.created_at,
    isPublished: r.is_published, isDraft: r.is_draft,
  })));
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `DATABASE_URL='postgresql://postgres:postgres@localhost:5433/postgres' PGSSLMODE=disable npx jest tests/admin-versions.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.js tests/admin-versions.test.js
git commit -m "feat(admin): add owner-scoped version-history JSON endpoint"
```

---

## Task 6: Admin — account-level API Tokens page

**Files:**
- Modify: `src/routes/admin.js` (add `GET /tokens/page` serving the view — note the existing `GET /tokens` returns JSON, so the HTML page needs a distinct path)
- Create: `src/views/admin-tokens.html`
- Modify: `src/views/admin-prototypes.html` (add topbar nav link to the tokens page)

> **Design note:** Phase 1 already exposed `POST /admin/tokens` (generate), `GET /admin/tokens` (list JSON), `DELETE /admin/tokens/:tokenId` (revoke). Those stay as the data API. This task adds only the **HTML page** that consumes them. To avoid colliding with the existing `GET /admin/tokens` (JSON), the page is served at `GET /admin/tokens/page`.

- [ ] **Step 1: Add the page route** in `src/routes/admin.js` (right after the existing `router.post('/tokens', …)` / `router.get('/tokens', …)` block, ~line 362):

```javascript
router.get('/tokens/page', adminAuth, (_req, res) => {
  res.send(readView('admin-tokens.html'));
});
```

- [ ] **Step 2: Create `src/views/admin-tokens.html`** — a self-contained page matching the existing admin visual style (purple topbar, card, table). It calls the Phase 1 JSON endpoints.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>API Tokens — Engagement Cloud ProtoLab (Beta!)</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;color:hsl(222,47%,11%);background:hsl(220,14%,96%);min-height:100vh}
a{color:hsl(252,83%,57%);text-decoration:none}
.topbar{background:hsl(252,83%,57%);height:52px;display:flex;align-items:center;padding:0 24px;gap:16px;position:sticky;top:0;z-index:100;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.topbar__back{display:flex;align-items:center;gap:6px;color:rgba(255,255,255,.85);font-size:13px;cursor:pointer;background:none;border:none;padding:4px 8px;border-radius:8px;text-decoration:none}
.topbar__back:hover{background:rgba(255,255,255,.15);color:#fff}
.topbar__title{font-weight:700;font-size:15px;color:#fff}
.page{max-width:860px;margin:0 auto;padding:32px 24px}
.page-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.page-title{font-size:22px;font-weight:700;letter-spacing:-.3px}
.page-sub{color:hsl(220,9%,46%);font-size:13px;margin-bottom:24px;line-height:1.6}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:none}
.btn-primary{background:hsl(252,83%,57%);color:#fff}.btn-primary:hover{background:hsl(252,83%,48%)}
.btn-danger{background:none;color:#c0392b;border:1px solid #e0c0bd;padding:5px 10px;font-size:12px;border-radius:8px}.btn-danger:hover{background:#fdf2f2}
.card{background:#fff;border-radius:12px;border:1px solid hsl(220,13%,91%);overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.04)}
.tbl{width:100%;border-collapse:collapse}
.tbl th{text-align:left;font-size:12px;font-weight:600;color:hsl(220,9%,46%);text-transform:uppercase;letter-spacing:.5px;padding:10px 16px;border-bottom:2px solid hsl(220,13%,91%);white-space:nowrap}
.tbl td{padding:14px 16px;border-bottom:1px solid hsl(220,14%,96%);vertical-align:middle;font-size:13px}
.tbl tr:last-child td{border-bottom:none}
.tbl-empty{text-align:center;padding:48px;color:hsl(220,9%,46%)}
.ts{color:hsl(220,9%,46%);font-size:12px}
.mono{font-family:'SF Mono',Monaco,Consolas,monospace;font-size:12px}
.gen-row{display:flex;gap:10px;align-items:center;margin-bottom:20px}
.input{padding:9px 12px;border:1px solid hsl(220,13%,87%);border-radius:8px;font-size:14px;font-family:inherit;outline:none;background:#fff}
.input:focus{border-color:hsl(252,83%,57%);box-shadow:0 0 0 3px hsl(252,83%,90%)}
.token-reveal{background:#f0fdf4;border:1px solid #b3e8cf;border-radius:10px;padding:16px;margin-bottom:20px;display:none}
.token-reveal__label{font-size:12px;font-weight:700;color:#1a7f4b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
.token-reveal__value{display:flex;gap:8px;align-items:center}
.token-reveal code{flex:1;background:#fff;border:1px solid #b3e8cf;border-radius:6px;padding:8px 10px;font-size:12px;word-break:break-all;font-family:'SF Mono',Monaco,Consolas,monospace}
.token-reveal__warn{font-size:12px;color:hsl(38,92%,30%);margin-top:8px}
.copy-btn{background:#fff;border:1px solid #b3e8cf;cursor:pointer;color:#1a7f4b;font-size:12px;padding:8px 12px;border-radius:6px;font-weight:600;white-space:nowrap}
</style>
</head>
<body>
<div class="topbar">
  <a href="/admin/prototypes" class="topbar__back">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path fill-rule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z"/></svg>
    All Prototypes
  </a>
  <span class="topbar__title">API Tokens</span>
</div>

<div class="page">
  <div class="page-head"><h1 class="page-title">API Tokens</h1></div>
  <p class="page-sub">Tokens let the local-AI MCP client (and other machine callers) pull feedback and push versioned updates through the <code class="mono">/api/v1</code> API. A token carries your account's access to all your prototypes. The secret is shown only once at creation — store it in your <code class="mono">.env</code> as <code class="mono">PROTOSHARE_TOKEN</code>.</p>

  <div class="token-reveal" id="reveal">
    <div class="token-reveal__label">New token — copy it now</div>
    <div class="token-reveal__value">
      <code id="reveal-value"></code>
      <button class="copy-btn" onclick="copyToken()">Copy</button>
    </div>
    <div class="token-reveal__warn">⚠ This is the only time the full token is shown. It cannot be retrieved later.</div>
  </div>

  <div class="gen-row">
    <input class="input" id="token-name" type="text" placeholder="Token name (e.g. laptop-dev)" style="flex:1">
    <button class="btn btn-primary" onclick="generateToken()">Generate Token</button>
  </div>

  <div class="card">
    <table class="tbl">
      <thead><tr><th>Name</th><th>Created</th><th>Last used</th><th></th></tr></thead>
      <tbody id="tbody"><tr><td colspan="4" class="tbl-empty">Loading…</td></tr></tbody>
    </table>
  </div>
</div>

<script>
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function fmtDate(iso){return iso?new Date(iso).toLocaleString('en-GB',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—';}

async function loadTokens(){
  const resp = await fetch('/admin/tokens');
  if(!resp.ok){ location.href='/admin/login'; return; }
  const rows = await resp.json();
  const tbody = document.getElementById('tbody');
  if(!rows.length){ tbody.innerHTML = '<tr><td colspan="4" class="tbl-empty">No tokens yet. Generate one above.</td></tr>'; return; }
  tbody.innerHTML = rows.map(t => `
    <tr id="tok-${esc(t.id)}">
      <td><strong>${esc(t.name)}</strong> <span class="mono ts">${esc(t.id)}</span></td>
      <td class="ts">${fmtDate(t.created_at)}</td>
      <td class="ts">${fmtDate(t.last_used_at)}</td>
      <td style="text-align:right"><button class="btn btn-danger" onclick="revoke('${esc(t.id)}','${esc(t.name)}')">Revoke</button></td>
    </tr>`).join('');
}

async function generateToken(){
  const nameEl = document.getElementById('token-name');
  const name = nameEl.value.trim() || 'token';
  const resp = await fetch('/admin/tokens', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'name='+encodeURIComponent(name) });
  if(!resp.ok){ alert('Failed to generate token.'); return; }
  const { token } = await resp.json();
  document.getElementById('reveal-value').textContent = token;
  document.getElementById('reveal').style.display = 'block';
  nameEl.value = '';
  loadTokens();
}

function copyToken(){
  navigator.clipboard.writeText(document.getElementById('reveal-value').textContent);
  event.target.textContent = 'Copied!';
  setTimeout(()=>event.target.textContent='Copy',1600);
}

async function revoke(id, name){
  if(!confirm(`Revoke token "${name}"? Any client using it will stop working immediately.`)) return;
  await fetch('/admin/tokens/'+encodeURIComponent(id), { method:'DELETE' });
  document.getElementById('tok-'+id)?.remove();
  loadTokens();
}

loadTokens();
</script>
</body>
</html>
```

- [ ] **Step 3: Add a nav link** to `src/views/admin-prototypes.html`. In the topbar (`<div class="topbar">`, ~line 82), after the title `<span>`, add a right-aligned link:

Replace:
```html
<div class="topbar">
  <span class="topbar__title" style="display:flex;align-items:center;gap:8px">
```
…keeping the existing title span, and add just before the closing `</div>` of `.topbar`:
```html
  <a href="/admin/tokens/page" style="margin-left:auto;color:rgba(255,255,255,.9);font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="15" height="15"><path fill-rule="evenodd" d="M18 8a6 6 0 01-7.743 5.743L10 14l-1 1-1 1H6v2H2v-4l4.257-4.257A6 6 0 1118 8zm-6-4a1 1 0 100 2 2 2 0 012 2 1 1 0 102 0 4 4 0 00-4-4z"/></svg>
    API Tokens
  </a>
```

- [ ] **Step 4: Manual verification** (the page is static HTML calling tested JSON endpoints; a full browser test is optional). Start the server and confirm the page renders and the endpoints respond:

```bash
DATABASE_URL='postgresql://postgres:postgres@localhost:5433/postgres' PGSSLMODE=disable \
  ADMIN_EMAIL=admin@sap.com ADMIN_PASSWORD_HASH="$(node -e "console.log(require('bcryptjs').hashSync('pw123456',10))")" \
  node src/server.js & sleep 2
JAR=$(mktemp)
curl -s -c "$JAR" -b "$JAR" -X POST http://localhost:3000/admin/login --data 'email=admin@sap.com&password=pw123456' -o /dev/null
curl -s -c "$JAR" -b "$JAR" http://localhost:3000/admin/tokens/page | grep -c 'API Tokens'   # expect >=1
kill %1 2>/dev/null
```

Expected: the grep finds the page title (page served behind auth). Record output.

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.js src/views/admin-tokens.html src/views/admin-prototypes.html
git commit -m "feat(admin): add account-level API Tokens management page"
```

---

## Task 7: Admin — version history in the prototype detail view

**Files:**
- Modify: `src/views/admin-prototype-detail.html` (add a "Versions" tab + loader)

The endpoint (`GET /admin/prototypes/:id/versions`) already exists from Task 5. This is a read-only display following the existing tab pattern (Comments / Access Log / Settings / Funnels / Explanations).

- [ ] **Step 1: Add the tab button.** In the `.tabs` div (~line 102-108), add after the Explanations tab button:

```html
    <button class="tab" data-tab="versions">Versions</button>
```

- [ ] **Step 2: Add the tab panel.** After the Explanations `tab-panel` div (~line 259, before the closing `</div><!-- tab-body -->`), add:

```html
    <!-- Versions tab -->
    <div class="tab-panel" id="tab-versions">
      <div class="tbl-wrap">
        <table class="tbl" id="versions-table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Status</th>
              <th>Note</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody id="versions-body">
            <tr><td colspan="4" style="text-align:center;padding:40px;color:hsl(220,9%,46%)">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    </div>
```

- [ ] **Step 3: Wire the tab activation.** In the tab-switching handler (~line 291-292), add `versions` alongside the existing lazy loaders:

Replace:
```javascript
    if (btn.dataset.tab === 'funnels') loadFunnels();
    if (btn.dataset.tab === 'explanations') loadExplanations();
```
with:
```javascript
    if (btn.dataset.tab === 'funnels') loadFunnels();
    if (btn.dataset.tab === 'explanations') loadExplanations();
    if (btn.dataset.tab === 'versions') loadVersions();
```

- [ ] **Step 4: Add the loader** near the other loaders (e.g. after `loadExplanations`/`renderExplanations`, before the closing `</script>` ~line 682):

```javascript
// Versions tab
let versionsLoaded = false;
async function loadVersions() {
  if (versionsLoaded) return;
  try {
    const resp = await fetch('/admin/prototypes/' + PROTO_ID + '/versions');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const rows = await resp.json();
    const tbody = document.getElementById('versions-body');
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:40px;color:hsl(220,9%,46%)">No versions yet.</td></tr>`;
      versionsLoaded = true;
      return;
    }
    tbody.innerHTML = rows.map(v => {
      const badge = v.isPublished
        ? '<span class="badge badge-general">published (live)</span>'
        : v.isDraft
          ? '<span class="badge badge-element">draft</span>'
          : `<span class="badge badge-other">${esc(v.status)}</span>`;
      return `<tr>
        <td><strong>v${v.version}</strong></td>
        <td>${badge}</td>
        <td class="comment-text">${esc(v.note || '—')}</td>
        <td class="ts">${fmtDate(v.createdAt)}</td>
      </tr>`;
    }).join('');
    versionsLoaded = true;
  } catch (e) {
    document.getElementById('versions-body').innerHTML =
      `<tr><td colspan="4" style="text-align:center;padding:40px;color:hsl(220,9%,46%)">Failed to load versions.</td></tr>`;
  }
}
```

- [ ] **Step 5: Manual verification** — start the server, open a prototype detail page, click **Versions**, confirm v1 shows as "published (live)". (Covered functionally by Task 5's endpoint tests; this is a display check.)

```bash
# (reuse the running server from Task 6 Step 4 if still up, else restart as there)
# Visual confirm only — the JSON endpoint is already test-covered.
```

- [ ] **Step 6: Commit**

```bash
git add src/views/admin-prototype-detail.html
git commit -m "feat(admin): show version history tab in prototype detail"
```

---

## Task 8: Full regression + docs touch-up

**Files:**
- Modify: `docs/superpowers/specs/2026-07-29-local-ai-integration-design.md` (flip Status line for Phases 2-3 to shipped — optional, low-risk)

- [ ] **Step 1: Run the entire suite against the local DB**

Run: `DATABASE_URL='postgresql://postgres:postgres@localhost:5433/postgres' PGSSLMODE=disable npx jest --runInBand`
Expected: all green except the 2 known pre-existing `inject.test.js` failures. New suites (`resolution`, `admin-versions`) pass with DB; MCP suites pass without DB.

- [ ] **Step 2: Run the MCP suites in isolation (no DB) to confirm they're self-contained**

Run: `npx jest tests/mcp-manifest.test.js tests/mcp-client.test.js tests/mcp-handlers.test.js`
Expected: PASS with no `DATABASE_URL` set.

- [ ] **Step 3: Commit any doc update**

```bash
git add docs/superpowers/specs/2026-07-29-local-ai-integration-design.md
git commit -m "docs: mark local-AI integration phases 2-3 as shipped"
```

---

## Self-Review

- **Spec coverage (§5 Phase 3):** `resolved_at` + `resolved_in_version` columns ✓ (Task 1); `POST …/comments/:commentId/resolve` ✓ (Task 2); feedback `resolved` derives from `resolved_at` ✓ (Task 2); MCP resolve tool ✓ (Tasks 3-4); token-management UI ✓ (Task 6); version-history display ✓ (Tasks 5, 7).
- **Path-collision guard:** the token HTML page is at `/admin/tokens/page` because Phase 1's `GET /admin/tokens` already returns JSON — noted explicitly so the implementer doesn't clobber it.
- **Owner-scoping:** every new endpoint (resolve, admin versions) reuses the existing `getOwned`/`getOwnedPrototype` 404-on-cross-tenant guarantee, with tests asserting it.
- **Type consistency:** `resolvedInVersion` (camelCase) in the payload matches the test assertion; `resolveComment(id, commentId, version)` signature matches the handler call site and both client/handler tests; `isPublished`/`isDraft` keys match between the admin route and the detail-view renderer.
- **No placeholders:** every code and test step is complete and runnable.
- **Deferred (correctly out of scope):** the design's §10 out-of-scope list (analytics in payload, branching, multi-file, realtime, auto-publish) remains untouched.
```
