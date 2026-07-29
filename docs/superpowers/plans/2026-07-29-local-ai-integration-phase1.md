# Local-AI Integration — Phase 1 (REST + Versioning) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a token-authenticated `/api/v1/*` REST surface to the deployed app so a machine can pull a prototype's feedback (comments + replies + explanations) and push improved HTML back as versioned drafts that publish on demand — without changing the prototype's identity or share link.

**Architecture:** Additive, parallel to the existing session-cookie admin surface. A new `api_tokens` table + bearer-token middleware authenticates the caller to a `user_id`, reusing the existing owner-scoping (cross-tenant → 404). A new `prototype_versions` table makes each prototype a linear version history; the share link serves `prototypes.published_version_id`, while pushes create drafts that never affect reviewers until published. The legacy single `filename` becomes version 1 via an idempotent backfill in `initDb()`.

**Tech Stack:** Node/Express 5, `pg` (parameterized queries), `bcryptjs`, `nanoid`, `multer` (memoryStorage), Jest + supertest. Storage abstracted behind `src/services/storage.js` (Supabase or local-fs fallback).

**Spec:** `docs/superpowers/specs/2026-07-29-local-ai-integration-design.md` (§1, §2, §6, §8 — Phase 1 scope). Phases 2 (MCP + manifest) and 3 (comment resolution) are separate plans.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/db.js` (modify) | New tables `api_tokens`, `prototype_versions`; new columns on `prototypes`/`comments`; v1 backfill — all idempotent in `initDb()` |
| `src/services/tokens.js` (create) | Token generate/verify helpers: raw-token creation, bcrypt hash, lookup-by-bearer resolving to a user row |
| `src/middleware/apiTokenAuth.js` (create) | Express middleware: parse `Authorization: Bearer`, resolve to `req.userId`, bump `last_used_at`, else 401 |
| `src/services/versions.js` (create) | Version helpers: next version number, create-draft, publish, resolve-published-file — the DB logic shared by routes |
| `src/routes/apiV1.js` (create) | The `/api/v1/*` endpoints (list, feedback, versions, source, push-draft, publish) |
| `src/routes/admin.js` (modify) | Token management endpoints (generate/list/revoke); stamp `version_id` on admin-side comment paths (none today — no-op placeholder note) |
| `src/routes/api.js` (modify) | Public comment insert stamps `version_id` = currently published version |
| `src/routes/delivery.js` (modify) | `/p/:token/view` resolves file via published version, not `prototypes.filename` |
| `src/server.js` (modify) | Mount `/api/v1` router |
| `.env.example` (modify) | Document `PROTOSHARE_TOKEN` (used by Phase 2, but noted now) |
| `tests/tokens.test.js` (create) | Token generate/verify/revoke unit + route tests |
| `tests/versions.test.js` (create) | Draft/publish lifecycle, delivery serves published, v1 backfill |
| `tests/feedback-api.test.js` (create) | Feedback payload shape, owner-scoping 404, madeAgainstVersion, explanations |
| `tests/conflict.test.js` (create) | Stale baseVersion push → 409 |

---

## Task 1: Database schema — new tables, columns, backfill

**Files:**
- Modify: `src/db.js` (inside `initDb()`, after the existing `// --- Multi-tenancy ---` block, before `return _pool;`)
- Test: `tests/versions.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/versions.test.js`:

```javascript
// tests/versions.test.js
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();

const hasDb = !!process.env.DATABASE_URL;
jest.resetModules();
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
    // Re-run initDb to trigger the idempotent backfill.
    await initDb();
    const { rows: pv } = await getDb().query(
      'SELECT version, status, filename FROM prototype_versions WHERE prototype_id = $1', [id]);
    expect(pv).toHaveLength(1);
    expect(pv[0]).toMatchObject({ version: 1, status: 'published', filename: `${id}.html` });
    const { rows: p } = await getDb().query(
      'SELECT published_version_id FROM prototypes WHERE id = $1', [id]);
    expect(p[0].published_version_id).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL="postgresql://postgres:postgres@localhost:5433/postgres" npx jest tests/versions.test.js -t schema -i`
Expected: FAIL — `api_tokens` / `prototype_versions` columns not found; backfill assertion fails.

- [ ] **Step 3: Add the schema + backfill to `initDb()`**

In `src/db.js`, immediately before `return _pool;` at the end of `initDb()`, insert:

```javascript
  // --- Local-AI integration: API tokens + prototype versioning ---

  // E. API tokens (machine auth; one user_id per token, bcrypt-hashed secret)
  await _pool.query(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash   TEXT NOT NULL,
      name         TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      last_used_at TEXT
    )
  `);
  await _pool.query(`CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id)`);

  // F. Prototype versions (linear history; one published + optional draft per proto)
  await _pool.query(`
    CREATE TABLE IF NOT EXISTS prototype_versions (
      id            TEXT PRIMARY KEY,
      prototype_id  TEXT NOT NULL REFERENCES prototypes(id) ON DELETE CASCADE,
      version       INTEGER NOT NULL,
      filename      TEXT NOT NULL,
      status        TEXT NOT NULL CONSTRAINT prototype_versions_status_check
                       CHECK (status IN ('draft', 'published')),
      note          TEXT,
      created_at    TEXT NOT NULL,
      UNIQUE (prototype_id, version)
    )
  `);
  await _pool.query(`CREATE INDEX IF NOT EXISTS idx_versions_proto ON prototype_versions(prototype_id, version)`);

  // G. Pointers on prototypes (nullable; enforced in code, mirrors owner_id)
  await _pool.query(`ALTER TABLE prototypes ADD COLUMN IF NOT EXISTS published_version_id TEXT REFERENCES prototype_versions(id)`);
  await _pool.query(`ALTER TABLE prototypes ADD COLUMN IF NOT EXISTS draft_version_id     TEXT REFERENCES prototype_versions(id)`);

  // H. version_id stamp on comments (which version the feedback was made against)
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS version_id TEXT REFERENCES prototype_versions(id)`);

  // I. Backfill: every prototype with no versions becomes "v1, published" pointing
  //    at its existing filename. Idempotent — only fires for unversioned prototypes.
  const { rows: unversioned } = await _pool.query(`
    SELECT p.id, p.filename FROM prototypes p
    WHERE NOT EXISTS (SELECT 1 FROM prototype_versions v WHERE v.prototype_id = p.id)
  `);
  for (const p of unversioned) {
    const vId = nanoid(12);
    await _pool.query(
      `INSERT INTO prototype_versions (id, prototype_id, version, filename, status, created_at)
       VALUES ($1, $2, 1, $3, 'published', $4)`,
      [vId, p.id, p.filename, new Date().toISOString()]
    );
    await _pool.query('UPDATE prototypes SET published_version_id = $1 WHERE id = $2', [vId, p.id]);
    await _pool.query(
      'UPDATE comments SET version_id = $1 WHERE prototype_id = $2 AND version_id IS NULL',
      [vId, p.id]
    );
  }
```

`nanoid` is already imported at the top of `src/db.js` (`const { nanoid } = require('nanoid');`).

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL="postgresql://postgres:postgres@localhost:5433/postgres" npx jest tests/versions.test.js -t schema -i`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db.js tests/versions.test.js
git commit -m "feat(db): add api_tokens, prototype_versions, version pointers + v1 backfill"
```

---

## Task 2: Token service + generation/verification helpers

**Files:**
- Create: `src/services/tokens.js`
- Test: `tests/tokens.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/tokens.test.js`:

```javascript
// tests/tokens.test.js
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();

const hasDb = !!process.env.DATABASE_URL;
jest.resetModules();
const { initDb, getDb, closeDb } = require('../src/db');
const { nanoid } = require('nanoid');
const tokens = require('../src/services/tokens');

let userId;

(hasDb ? describe : describe.skip)('token service', () => {
  beforeAll(async () => {
    await initDb();
    userId = nanoid(12);
    await getDb().query(
      'INSERT INTO users (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)',
      [userId, `tok-${userId}@sap.com`, 'x', new Date().toISOString()]
    );
  });
  afterAll(async () => { await closeDb(); });

  test('createToken returns a raw secret and stores only a hash', async () => {
    const { raw, id } = await tokens.createToken(userId, 'laptop');
    expect(typeof raw).toBe('string');
    expect(raw.length).toBeGreaterThanOrEqual(32);
    const { rows } = await getDb().query('SELECT token_hash FROM api_tokens WHERE id = $1', [id]);
    expect(rows[0].token_hash).not.toBe(raw); // stored value is a hash, not the secret
  });

  test('resolveToken returns the owning user for a valid raw token', async () => {
    const { raw } = await tokens.createToken(userId, 'second');
    const resolved = await tokens.resolveToken(raw);
    expect(resolved).toMatchObject({ userId });
  });

  test('resolveToken returns null for a bogus token', async () => {
    expect(await tokens.resolveToken('not-a-real-token')).toBeNull();
  });

  test('revokeToken makes the token stop resolving', async () => {
    const { raw, id } = await tokens.createToken(userId, 'third');
    await tokens.revokeToken(id, userId);
    expect(await tokens.resolveToken(raw)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL="postgresql://postgres:postgres@localhost:5433/postgres" npx jest tests/tokens.test.js -i`
Expected: FAIL — `Cannot find module '../src/services/tokens'`.

- [ ] **Step 3: Write `src/services/tokens.js`**

```javascript
// src/services/tokens.js
// API token lifecycle. A raw token is shown to the user ONCE at creation; only
// its bcrypt hash is stored. resolveToken() maps a presented bearer token back
// to its owning user, mirroring the password check in the admin login route.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const { getDb } = require('../db');

// Create a token for a user. Returns { id, raw } — raw is the secret, never re-derivable.
async function createToken(userId, name) {
  const id = nanoid(12);
  const raw = crypto.randomBytes(24).toString('base64url'); // 32-char url-safe secret
  const tokenHash = bcrypt.hashSync(raw, 10);
  await getDb().query(
    'INSERT INTO api_tokens (id, user_id, token_hash, name, created_at) VALUES ($1,$2,$3,$4,$5)',
    [id, userId, tokenHash, name || 'token', new Date().toISOString()]
  );
  return { id, raw };
}

// Resolve a presented raw token to { userId, tokenId }, or null if none match.
// Bumps last_used_at on success. Compares against every token's hash (bcrypt is
// intentionally slow, but token counts per user are tiny).
async function resolveToken(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const { rows } = await getDb().query('SELECT id, user_id, token_hash FROM api_tokens');
  for (const row of rows) {
    if (bcrypt.compareSync(raw, row.token_hash)) {
      await getDb().query('UPDATE api_tokens SET last_used_at = $1 WHERE id = $2',
        [new Date().toISOString(), row.id]);
      return { userId: row.user_id, tokenId: row.id };
    }
  }
  return null;
}

// List a user's tokens (never returns the hash or raw secret).
async function listTokens(userId) {
  const { rows } = await getDb().query(
    'SELECT id, name, created_at, last_used_at FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return rows;
}

// Revoke = delete. Scoped by user so one user can't revoke another's token.
async function revokeToken(tokenId, userId) {
  await getDb().query('DELETE FROM api_tokens WHERE id = $1 AND user_id = $2', [tokenId, userId]);
}

module.exports = { createToken, resolveToken, listTokens, revokeToken };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL="postgresql://postgres:postgres@localhost:5433/postgres" npx jest tests/tokens.test.js -i`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/tokens.js tests/tokens.test.js
git commit -m "feat(tokens): add API token create/resolve/list/revoke service"
```

---

## Task 3: Bearer-token auth middleware

**Files:**
- Create: `src/middleware/apiTokenAuth.js`
- Test: extend `tests/tokens.test.js`

- [ ] **Step 1: Write the failing test**

Append inside the `describe('token service', …)` block in `tests/tokens.test.js` (before its closing `});`):

```javascript
  test('apiTokenAuth sets req.userId for a valid bearer token and 401s otherwise', async () => {
    const express = require('express');
    const request = require('supertest');
    const apiTokenAuth = require('../src/middleware/apiTokenAuth');
    const { raw } = await tokens.createToken(userId, 'mw');

    const app = express();
    app.get('/whoami', apiTokenAuth, (req, res) => res.json({ userId: req.userId }));

    const ok = await request(app).get('/whoami').set('Authorization', `Bearer ${raw}`);
    expect(ok.status).toBe(200);
    expect(ok.body.userId).toBe(userId);

    const noHeader = await request(app).get('/whoami');
    expect(noHeader.status).toBe(401);

    const bad = await request(app).get('/whoami').set('Authorization', 'Bearer nope');
    expect(bad.status).toBe(401);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL="postgresql://postgres:postgres@localhost:5433/postgres" npx jest tests/tokens.test.js -t apiTokenAuth -i`
Expected: FAIL — `Cannot find module '../src/middleware/apiTokenAuth'`.

- [ ] **Step 3: Write `src/middleware/apiTokenAuth.js`**

```javascript
// src/middleware/apiTokenAuth.js
// Machine-facing auth for /api/v1/*. Parses a Bearer token, resolves it to a
// user via the token service, and sets req.userId. The session-cookie adminAuth
// and this never mix — /api/v1 is bearer-only, /admin is cookie-only.
const { resolveToken } = require('../services/tokens');

async function apiTokenAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ error: 'Missing bearer token.' });
    const resolved = await resolveToken(match[1].trim());
    if (!resolved) return res.status(401).json({ error: 'Invalid or revoked token.' });
    req.userId = resolved.userId;
    req.tokenId = resolved.tokenId;
    next();
  } catch (err) {
    console.error('apiTokenAuth error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
}

module.exports = apiTokenAuth;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL="postgresql://postgres:postgres@localhost:5433/postgres" npx jest tests/tokens.test.js -i`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/middleware/apiTokenAuth.js tests/tokens.test.js
git commit -m "feat(auth): add apiTokenAuth bearer middleware for /api/v1"
```

---

## Task 4: Version service — next number, create draft, publish, resolve published file

**Files:**
- Create: `src/services/versions.js`
- Test: extend `tests/versions.test.js`

- [ ] **Step 1: Write the failing test**

Add a second `describe` block at the end of `tests/versions.test.js` (after the existing schema block, still inside the file, top-level):

```javascript
(hasDb ? describe : describe.skip)('version service', () => {
  const { nanoid } = require('nanoid');
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
    await initDb(); // backfill v1
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL="postgresql://postgres:postgres@localhost:5433/postgres" npx jest tests/versions.test.js -t "version service" -i`
Expected: FAIL — `Cannot find module '../src/services/versions'`.

- [ ] **Step 3: Write `src/services/versions.js`**

```javascript
// src/services/versions.js
// Prototype version lifecycle. A push creates a DRAFT (never touches the
// published pointer); publish promotes a draft to the version the share link
// serves. All functions assume ownership has already been checked by the caller.
const { nanoid } = require('nanoid');
const { getDb } = require('../db');

// Highest version number for a prototype (0 if none — shouldn't happen post-backfill).
async function latestVersion(prototypeId) {
  const { rows } = await getDb().query(
    'SELECT COALESCE(MAX(version), 0) AS max FROM prototype_versions WHERE prototype_id = $1',
    [prototypeId]
  );
  return parseInt(rows[0].max, 10);
}

// Create a new draft version with the next number. Sets prototypes.draft_version_id.
async function createDraft(prototypeId, filename, note) {
  const version = (await latestVersion(prototypeId)) + 1;
  const id = nanoid(12);
  await getDb().query(
    `INSERT INTO prototype_versions (id, prototype_id, version, filename, status, note, created_at)
     VALUES ($1,$2,$3,$4,'draft',$5,$6)`,
    [id, prototypeId, version, filename, note || null, new Date().toISOString()]
  );
  await getDb().query('UPDATE prototypes SET draft_version_id = $1 WHERE id = $2', [id, prototypeId]);
  return { id, version, status: 'draft' };
}

// Promote a version to published: flip its status, point the prototype at it,
// clear the draft pointer if it was this version. Throws {code:'CONFLICT'} if
// the version doesn't exist or is already published.
async function publish(prototypeId, version) {
  const { rows } = await getDb().query(
    'SELECT id, status FROM prototype_versions WHERE prototype_id = $1 AND version = $2',
    [prototypeId, version]
  );
  if (!rows[0]) { const e = new Error('Version not found.'); e.code = 'CONFLICT'; throw e; }
  if (rows[0].status === 'published') { const e = new Error('Already published.'); e.code = 'CONFLICT'; throw e; }
  const vId = rows[0].id;
  await getDb().query(`UPDATE prototype_versions SET status = 'published' WHERE id = $1`, [vId]);
  await getDb().query(
    `UPDATE prototypes SET published_version_id = $1,
       draft_version_id = CASE WHEN draft_version_id = $1 THEN NULL ELSE draft_version_id END
     WHERE id = $2`,
    [vId, prototypeId]
  );
  return { version, status: 'published' };
}

// The storage filename the share link should serve = the published version's file.
async function resolvePublishedFile(prototypeId) {
  const { rows } = await getDb().query(
    `SELECT v.filename FROM prototypes p
     JOIN prototype_versions v ON v.id = p.published_version_id
     WHERE p.id = $1`,
    [prototypeId]
  );
  return rows[0] ? rows[0].filename : null;
}

// The version number a comment made "now" should be stamped with = published version.
async function publishedVersionId(prototypeId) {
  const { rows } = await getDb().query('SELECT published_version_id FROM prototypes WHERE id = $1', [prototypeId]);
  return rows[0] ? rows[0].published_version_id : null;
}

module.exports = { latestVersion, createDraft, publish, resolvePublishedFile, publishedVersionId };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL="postgresql://postgres:postgres@localhost:5433/postgres" npx jest tests/versions.test.js -i`
Expected: PASS (schema block 5 + version service 4 = 9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/versions.js tests/versions.test.js
git commit -m "feat(versions): add version service (create draft, publish, resolve file)"
```

---

## Task 5: `/api/v1` router — list + feedback endpoints

**Files:**
- Create: `src/routes/apiV1.js`
- Modify: `src/server.js` (mount router)
- Test: `tests/feedback-api.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/feedback-api.test.js`:

```javascript
// tests/feedback-api.test.js
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();

const hasDb = !!process.env.DATABASE_URL;

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

let app, userId, otherUserId, protoId, rawToken, otherToken, v1Id;

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
    ({ raw: rawToken } = await tokens.createToken(userId, 't'));
    ({ raw: otherToken } = await tokens.createToken(otherUserId, 't'));

    protoId = nanoid(12);
    await getDb().query(
      'INSERT INTO prototypes (id,name,filename,share_token,created_at,owner_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [protoId, 'FB', `${protoId}.html`, nanoid(12), new Date().toISOString(), userId]);
    await initDb(); // backfill v1
    ({ rows: [{ id: v1Id }] } = await getDb().query(
      'SELECT id FROM prototype_versions WHERE prototype_id = $1', [protoId]));

    // one element comment (stamped v1) + one reply + one explanation
    const cId = nanoid(12);
    await getDb().query(
      `INSERT INTO comments (id,prototype_id,email,type,element_selector,element_label,comment,page_url,created_at,tag,version_id)
       VALUES ($1,$2,$3,'element',$4,$5,$6,$7,$8,'bug',$9)`,
      [cId, protoId, 'alice@sap.com', '.cart', 'Cart', 'broken', '/cart', new Date().toISOString(), v1Id]);
    await getDb().query(
      `INSERT INTO comments (id,prototype_id,email,type,comment,created_at,parent_id)
       VALUES ($1,$2,$3,'reply',$4,$5,$6)`,
      [nanoid(12), protoId, 'bob@sap.com', 'confirmed', new Date().toISOString(), cId]);
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
    expect(res.body.comments).toHaveLength(1);
    expect(res.body.comments[0].tag).toBe('bug');
    expect(res.body.comments[0].madeAgainstVersion).toBe(1);
    expect(res.body.comments[0].replies).toHaveLength(1);
    expect(res.body.explanations[0].body).toBe('recomputes on change');
  });

  test('cross-tenant feedback returns 404', async () => {
    const res = await request(app).get(`/api/v1/prototypes/${protoId}/feedback`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL="postgresql://postgres:postgres@localhost:5433/postgres" npx jest tests/feedback-api.test.js -i`
Expected: FAIL — `Cannot find module '../src/routes/apiV1'`.

- [ ] **Step 3: Write `src/routes/apiV1.js` (list + feedback only for now)**

```javascript
// src/routes/apiV1.js
// Machine-facing REST surface. Bearer-authenticated (apiTokenAuth sets req.userId),
// owner-scoped like the admin routes (a prototype that isn't yours → 404).
const express = require('express');
const { getDb } = require('../db');
const apiTokenAuth = require('../middleware/apiTokenAuth');

const router = express.Router();
router.use(apiTokenAuth);

// Fetch a prototype only if owned by the caller — mirrors admin getOwnedPrototype.
async function getOwned(id, ownerId, columns = '*') {
  const { rows } = await getDb().query(
    `SELECT ${columns} FROM prototypes WHERE id = $1 AND owner_id = $2`, [id, ownerId]);
  return rows[0] || null;
}

// GET /api/v1/prototypes — list the caller's prototypes with version pointers.
router.get('/prototypes', async (req, res) => {
  try {
    const { rows } = await getDb().query(`
      SELECT p.id, p.name, p.share_token,
        pub.version AS published_version,
        dr.version  AS draft_version
      FROM prototypes p
      LEFT JOIN prototype_versions pub ON pub.id = p.published_version_id
      LEFT JOIN prototype_versions dr  ON dr.id  = p.draft_version_id
      WHERE p.owner_id = $1 ORDER BY p.created_at DESC`, [req.userId]);
    res.json(rows.map(r => ({
      id: r.id, name: r.name,
      shareLink: `${require('../config').baseUrl}/p/${r.share_token}`,
      publishedVersion: r.published_version,
      draftVersion: r.draft_version,
    })));
  } catch (err) {
    console.error('GET /api/v1/prototypes error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/v1/prototypes/:id/feedback — comments (+replies) + explanations.
router.get('/prototypes/:id/feedback', async (req, res) => {
  try {
    const proto = await getOwned(req.params.id, req.userId, 'id, name, published_version_id, draft_version_id');
    if (!proto) return res.status(404).json({ error: 'Not found.' });

    // version number lookup so comments report madeAgainstVersion as an int
    const { rows: vNums } = await getDb().query(
      'SELECT id, version FROM prototype_versions WHERE prototype_id = $1', [proto.id]);
    const versionOf = Object.fromEntries(vNums.map(v => [v.id, v.version]));
    const pubVer = versionOf[proto.published_version_id] || null;
    const draftVer = versionOf[proto.draft_version_id] || null;

    const { rows } = await getDb().query(
      `SELECT id, email, type, element_selector, element_label, comment, page_url,
              created_at, tag, x_pct, y_pct, parent_id, version_id
       FROM comments WHERE prototype_id = $1 ORDER BY created_at ASC`, [proto.id]);

    const replyMap = {};
    rows.filter(r => r.parent_id).forEach(r => {
      (replyMap[r.parent_id] ||= []).push(
        { email: r.email, comment: r.comment, createdAt: r.created_at });
    });
    const comments = rows.filter(r => !r.parent_id).map(r => ({
      id: r.id, type: r.type, tag: r.tag, comment: r.comment, email: r.email,
      element: r.element_selector ? { selector: r.element_selector, label: r.element_label } : null,
      pageUrl: r.page_url, createdAt: r.created_at,
      madeAgainstVersion: versionOf[r.version_id] || 1,
      resolved: false, // Phase 3 fills this
      replies: replyMap[r.id] || [],
    }));

    const { rows: expl } = await getDb().query(
      `SELECT element_selector, page_url, body FROM explanations
       WHERE prototype_id = $1 ORDER BY created_at ASC`, [proto.id]);

    res.json({
      prototype: { id: proto.id, name: proto.name, publishedVersion: pubVer, draftVersion: draftVer },
      comments,
      explanations: expl.map(e => ({ elementSelector: e.element_selector, pageUrl: e.page_url, body: e.body })),
    });
  } catch (err) {
    console.error('GET /api/v1/feedback error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
```

- [ ] **Step 4: Mount the router in `src/server.js`**

After the line `app.use('/admin', adminRouter);` add:

```javascript
const apiV1Router = require('./routes/apiV1');
app.use('/api/v1', apiV1Router);
```

(Place the `require` with the other route requires at the top for consistency, and the `app.use` alongside the others.)

- [ ] **Step 5: Run test to verify it passes**

Run: `DATABASE_URL="postgresql://postgres:postgres@localhost:5433/postgres" npx jest tests/feedback-api.test.js -i`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/routes/apiV1.js src/server.js tests/feedback-api.test.js
git commit -m "feat(api-v1): add token-auth prototype list + feedback endpoints"
```

---

## Task 6: `/api/v1` — versions list, source, push-draft (with conflict guard), publish

**Files:**
- Modify: `src/routes/apiV1.js`
- Test: `tests/conflict.test.js` + extend `tests/versions.test.js` via routes

- [ ] **Step 1: Write the failing test**

Create `tests/conflict.test.js`:

```javascript
// tests/conflict.test.js
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();

const hasDb = !!process.env.DATABASE_URL;

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

let app, userId, protoId, rawToken;

(hasDb ? describe : describe.skip)('versions endpoints', () => {
  beforeAll(async () => {
    await initDb();
    app = express();
    app.use(express.json());
    app.use('/api/v1', apiV1Router);

    userId = nanoid(12);
    await getDb().query('INSERT INTO users (id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)',
      [userId, `cf-${userId}@sap.com`, 'x', new Date().toISOString()]);
    ({ raw: rawToken } = await tokens.createToken(userId, 't'));

    protoId = nanoid(12);
    await getDb().query(
      'INSERT INTO prototypes (id,name,filename,share_token,created_at,owner_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [protoId, 'CF', `${protoId}.html`, nanoid(12), new Date().toISOString(), userId]);
    await initDb(); // backfill v1 + publish it
    // seed the v1 file so /source can return it
    const storage = require('../src/services/storage');
    await storage.putPrototype(`${protoId}.html`, '<html>v1</html>');
  });
  afterAll(async () => { await closeDb(); });

  const auth = () => ({ Authorization: `Bearer ${rawToken}` });

  test('GET /source returns the published HTML', async () => {
    const res = await request(app).get(`/api/v1/prototypes/${protoId}/source`).set(auth());
    expect(res.status).toBe(200);
    expect(res.text).toContain('v1');
  });

  test('push with correct baseVersion creates a draft (v2)', async () => {
    const res = await request(app).post(`/api/v1/prototypes/${protoId}/versions`).set(auth())
      .field('baseVersion', '1').field('note', 'fix')
      .attach('file', Buffer.from('<html>v2</html>'), 'edit.html');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ version: 2, status: 'draft' });
  });

  test('share link still serves v1 (draft is not published)', async () => {
    const res = await request(app).get(`/api/v1/prototypes/${protoId}/source`).set(auth());
    expect(res.text).toContain('v1'); // unchanged
  });

  test('stale push (baseVersion=1 again, latest is now 2) returns 409', async () => {
    const res = await request(app).post(`/api/v1/prototypes/${protoId}/versions`).set(auth())
      .field('baseVersion', '1')
      .attach('file', Buffer.from('<html>v3</html>'), 'edit.html');
    expect(res.status).toBe(409);
    expect(res.body.currentVersion).toBe(2);
  });

  test('publish v2 makes /source serve v2', async () => {
    const pub = await request(app).post(`/api/v1/prototypes/${protoId}/publish`).set(auth())
      .send({ version: 2 });
    expect(pub.status).toBe(200);
    const res = await request(app).get(`/api/v1/prototypes/${protoId}/source`).set(auth());
    expect(res.text).toContain('v2');
  });

  test('publishing an already-published version returns 409', async () => {
    const res = await request(app).post(`/api/v1/prototypes/${protoId}/publish`).set(auth())
      .send({ version: 2 });
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL="postgresql://postgres:postgres@localhost:5433/postgres" npx jest tests/conflict.test.js -i`
Expected: FAIL — routes `/source`, `/versions`, `/publish` return 404 (not defined yet).

- [ ] **Step 3: Add the endpoints to `src/routes/apiV1.js`**

Add these imports at the top (after the existing requires):

```javascript
const multer = require('multer');
const { nanoid } = require('nanoid');
const storage = require('../services/storage');
const versions = require('../services/versions');

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => cb(null, file.originalname.endsWith('.html')),
});
```

Then add these routes before `module.exports = router;`:

```javascript
// GET /prototypes/:id/versions — history newest-first.
router.get('/prototypes/:id/versions', async (req, res) => {
  try {
    if (!await getOwned(req.params.id, req.userId, 'id')) return res.status(404).json({ error: 'Not found.' });
    const { rows } = await getDb().query(
      `SELECT version, status, note, created_at FROM prototype_versions
       WHERE prototype_id = $1 ORDER BY version DESC`, [req.params.id]);
    res.json(rows.map(r => ({ version: r.version, status: r.status, note: r.note, createdAt: r.created_at })));
  } catch (err) {
    console.error('GET /versions error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /prototypes/:id/source — published HTML, or ?version=N for a specific one.
router.get('/prototypes/:id/source', async (req, res) => {
  try {
    if (!await getOwned(req.params.id, req.userId, 'id')) return res.status(404).json({ error: 'Not found.' });
    let filename;
    if (req.query.version) {
      const { rows } = await getDb().query(
        'SELECT filename FROM prototype_versions WHERE prototype_id = $1 AND version = $2',
        [req.params.id, parseInt(req.query.version, 10)]);
      filename = rows[0] && rows[0].filename;
    } else {
      filename = await versions.resolvePublishedFile(req.params.id);
    }
    if (!filename) return res.status(404).json({ error: 'Version not found.' });
    const raw = await storage.getPrototype(filename);
    if (raw === null) return res.status(404).json({ error: 'File not found.' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(raw);
  } catch (err) {
    console.error('GET /source error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /prototypes/:id/versions — upload HTML as a DRAFT. Conflict-guarded.
router.post('/prototypes/:id/versions', upload.single('file'), async (req, res) => {
  try {
    if (!await getOwned(req.params.id, req.userId, 'id')) return res.status(404).json({ error: 'Not found.' });
    if (!req.file) return res.status(400).json({ error: 'Only .html files are accepted.' });

    const latest = await versions.latestVersion(req.params.id);
    const base = parseInt(req.body.baseVersion, 10);
    if (!Number.isNaN(base) && base !== latest) {
      return res.status(409).json({ error: 'Prototype changed since you pulled.', currentVersion: latest });
    }

    const filename = `${nanoid(12)}.html`;
    await storage.putPrototype(filename, req.file.buffer);
    const v = await versions.createDraft(req.params.id, filename, req.body.note);
    res.status(201).json(v);
  } catch (err) {
    console.error('POST /versions error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /prototypes/:id/publish — promote a draft (defaults to latest).
router.post('/prototypes/:id/publish', async (req, res) => {
  try {
    if (!await getOwned(req.params.id, req.userId, 'id')) return res.status(404).json({ error: 'Not found.' });
    const version = req.body.version ? parseInt(req.body.version, 10) : await versions.latestVersion(req.params.id);
    const result = await versions.publish(req.params.id, version);
    res.json(result);
  } catch (err) {
    if (err.code === 'CONFLICT') return res.status(409).json({ error: err.message });
    console.error('POST /publish error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL="postgresql://postgres:postgres@localhost:5433/postgres" npx jest tests/conflict.test.js -i`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/routes/apiV1.js tests/conflict.test.js
git commit -m "feat(api-v1): add versions list, source, push-draft (conflict-guarded), publish"
```

---

## Task 7: Delivery + comment stamping use the published version

**Files:**
- Modify: `src/routes/delivery.js:56-70` (the `/:shareToken/view` handler)
- Modify: `src/routes/api.js` (comment insert stamps `version_id`)
- Test: extend `tests/delivery.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/delivery.test.js` inside its main `describe` block (match the file's existing setup for `protoId`, `app`, and the customer session agent — reuse whatever helper it already defines to establish an allowed session). Add:

```javascript
  test('view serves the published version file, not prototypes.filename', async () => {
    // Arrange: give the prototype a v2 published version with distinct content.
    const versions = require('../src/services/versions');
    const storage = require('../src/services/storage');
    await initDb(); // ensure v1 backfilled
    const v2file = `${protoId}-pub.html`;
    await storage.putPrototype(v2file, '<html>PUBLISHED-V2</html>');
    const v = await versions.createDraft(protoId, v2file, 'v2');
    await versions.publish(protoId, v.version);

    // Act: fetch the reviewer view (agent is an authorised session from setup).
    const res = await agent.get(`/p/${shareToken}/view`);

    // Assert: the injected HTML is based on the published v2 file.
    expect(res.status).toBe(200);
    expect(res.text).toContain('PUBLISHED-V2');
  });
```

> If `tests/delivery.test.js` does not already expose `agent`, `shareToken`, and `protoId` at the describe scope, add them to its `beforeAll` following the same pattern used elsewhere in that file (create prototype with `owner_id`, add the reviewer email to `allowlist`, `agent.post('/p/:token/enter')`). Reuse the in-memory `jest.mock('../src/services/storage')` block already present in the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL="postgresql://postgres:postgres@localhost:5433/postgres" npx jest tests/delivery.test.js -t "published version" -i`
Expected: FAIL — view still serves the old `proto.filename` content, not `PUBLISHED-V2`.

- [ ] **Step 3: Update `src/routes/delivery.js`**

In the `/:shareToken/view` handler, add the versions import at the top of the file (with the other requires):

```javascript
const versions = require('../services/versions');
```

Replace the file-resolution line. Change:

```javascript
  const raw = await storage.getPrototype(proto.filename);
```

to:

```javascript
  // Serve the published version's file (falls back to the legacy filename for
  // any prototype not yet backfilled — defensive; backfill should cover all).
  const publishedFile = await versions.resolvePublishedFile(proto.id);
  const raw = await storage.getPrototype(publishedFile || proto.filename);
```

- [ ] **Step 4: Stamp `version_id` on public comment inserts in `src/routes/api.js`**

In the `POST /comments` handler, add the versions import at the top:

```javascript
const versions = require('../services/versions');
```

In the top-level (non-reply) comment insert branch, compute the published version id and include it. Before the `await getDb().query(` that inserts the full element/general comment, add:

```javascript
    const versionId = await versions.publishedVersionId(prototypeId);
```

Then change that INSERT to also write `version_id`. Update the column list and values — append `, version_id` to the columns, `,$15` to the placeholders, and `versionId` to the params array:

```javascript
    await getDb().query(
      `INSERT INTO comments
        (id, prototype_id, email, type, element_selector, element_label, element_tag,
         breadcrumb, comment, page_url, created_at, tag, x_pct, y_pct, version_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id, prototypeId, commentEmail, type,
        element?.selector || null,
        element?.label    || null,
        element?.tagName  || null,
        breadcrumb ? JSON.stringify(breadcrumb) : null,
        comment.trim(),
        pageUrl || null,
        new Date().toISOString(),
        VALID_TAGS.includes(tag) ? tag : null,
        typeof xPct === 'number' ? xPct : null,
        typeof yPct === 'number' ? yPct : null,
        versionId,
      ]
    );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `DATABASE_URL="postgresql://postgres:postgres@localhost:5433/postgres" npx jest tests/delivery.test.js tests/api.test.js -i`
Expected: PASS (existing delivery/api tests still green + the new published-version test).

- [ ] **Step 6: Commit**

```bash
git add src/routes/delivery.js src/routes/api.js tests/delivery.test.js
git commit -m "feat(delivery): serve published version; stamp version_id on new comments"
```

---

## Task 8: Admin token-management endpoints

**Files:**
- Modify: `src/routes/admin.js` (add generate/list/revoke routes)
- Test: extend `tests/tokens.test.js` with route-level tests through the admin router

- [ ] **Step 1: Write the failing test**

Create a new file `tests/admin-tokens.test.js` (keeps the admin session setup isolated from the service-level `tokens.test.js`):

```javascript
// tests/admin-tokens.test.js
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();

const hasDb = !!process.env.DATABASE_URL;
jest.resetModules();
const { initDb, closeDb } = require('../src/db');
const { nanoid } = require('nanoid');
const request = require('supertest');
const express = require('express');
const session = require('express-session');
const adminRouter = require('../src/routes/admin');

let app;
const email = `tok-admin-${nanoid(8)}@sap.com`.toLowerCase();
const password = 'password123';

(hasDb ? describe : describe.skip)('admin token management', () => {
  beforeAll(async () => {
    await initDb();
    app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    app.use('/admin', adminRouter);
    await request(app).post('/admin/signup').send(`email=${email}&password=${password}&confirm=${password}`);
  });
  afterAll(async () => { await closeDb(); });

  test('generate → list → revoke lifecycle', async () => {
    const agent = request.agent(app);
    await agent.post('/admin/login').send(`email=${email}&password=${password}`);

    const gen = await agent.post('/admin/tokens').send('name=laptop');
    expect(gen.status).toBe(201);
    expect(gen.body.token).toBeTruthy();      // raw shown once
    const tokenId = gen.body.id;

    const list = await agent.get('/admin/tokens');
    expect(list.status).toBe(200);
    expect(list.body.some(t => t.id === tokenId)).toBe(true);
    expect(JSON.stringify(list.body)).not.toContain(gen.body.token); // secret never re-listed

    const del = await agent.delete(`/admin/tokens/${tokenId}`);
    expect(del.status).toBe(200);
    const list2 = await agent.get('/admin/tokens');
    expect(list2.body.some(t => t.id === tokenId)).toBe(false);
  });

  test('token endpoints require admin session', async () => {
    expect((await request(app).get('/admin/tokens')).status).toBe(302);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL="postgresql://postgres:postgres@localhost:5433/postgres" npx jest tests/admin-tokens.test.js -i`
Expected: FAIL — `/admin/tokens` routes return 404 (not defined).

- [ ] **Step 3: Add routes to `src/routes/admin.js`**

Add the import near the top (with the other requires):

```javascript
const apiTokens = require('../services/tokens');
```

Add these routes (anywhere among the other `adminAuth`-guarded routes, e.g. after the `/upload` route):

```javascript
// --- API token management (machine access for local-AI integration) ---
router.post('/tokens', adminAuth, async (req, res) => {
  const { id, raw } = await apiTokens.createToken(req.session.userId, (req.body.name || 'token').slice(0, 60));
  // The raw secret is returned exactly once and never stored in plaintext.
  res.status(201).json({ id, token: raw });
});

router.get('/tokens', adminAuth, async (req, res) => {
  res.json(await apiTokens.listTokens(req.session.userId));
});

router.delete('/tokens/:tokenId', adminAuth, async (req, res) => {
  await apiTokens.revokeToken(req.params.tokenId, req.session.userId);
  res.json({ ok: true });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL="postgresql://postgres:postgres@localhost:5433/postgres" npx jest tests/admin-tokens.test.js -i`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.js tests/admin-tokens.test.js
git commit -m "feat(admin): API token generate/list/revoke endpoints"
```

---

## Task 9: Document env + full suite green

**Files:**
- Modify: `.env.example`
- Test: full suite

- [ ] **Step 1: Add `PROTOSHARE_TOKEN` note to `.env.example`**

Append:

```bash

# Local-AI integration (Phase 2 MCP client uses this; generate it in the admin
# "API Tokens" panel). Server-side needs no new env — tokens live in the DB.
# PROTOSHARE_TOKEN=paste-a-generated-token-here
```

- [ ] **Step 2: Run the full suite**

Run: `DATABASE_URL="postgresql://postgres:postgres@localhost:5433/postgres" npm test`
Expected: All new suites pass. Pre-existing `inject.test.js` still shows its 2 known failures (documented, unrelated). Everything else green.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(env): document PROTOSHARE_TOKEN for local-AI integration"
```

---

## Self-Review

**Spec coverage (Phase 1 scope of `2026-07-29-local-ai-integration-design.md`):**
- §1 `api_tokens`, `prototype_versions`, prototype pointers, `comments.version_id`, v1 backfill → Task 1 ✓
- §1 token hashing (shown once) → Task 2 ✓
- §2 `apiTokenAuth` bearer middleware → Task 3 ✓
- §2 version lifecycle (next number, draft, publish, resolve-published) → Task 4 ✓
- §2 `GET /prototypes`, `GET …/feedback` (replies nested, explanations, madeAgainstVersion, cross-tenant 404) → Task 5 ✓
- §2 `GET …/versions`, `GET …/source` (+?version), `POST …/versions` draft + conflict 409, `POST …/publish` + 409 → Task 6 ✓
- §2 delivery serves published version; comment `version_id` stamping → Task 7 ✓
- §1/§5 token management UI endpoints (generate once / list / revoke) → Task 8 ✓ (backend; HTML panel is Phase 3 polish per spec §5)
- §6 error table (401/404/400/409/500) → covered across Tasks 3,5,6 ✓
- §8 all five test suites → tokens, versions, feedback-api, conflict, admin-tokens ✓
- Out of scope (analytics, branching, multi-file, notifications, auto-publish) → not implemented ✓

**Placeholder scan:** No TBD/TODO; every code step contains complete code. Task 7 Step 1 has a conditional note about reusing `tests/delivery.test.js` setup — this is guidance for adapting to that file's existing structure, not a placeholder for missing code; the test body itself is complete.

**Type/name consistency:** `createDraft`, `publish`, `latestVersion`, `resolvePublishedFile`, `publishedVersionId` (versions.js) used identically in routes and tests. `createToken`/`resolveToken`/`listTokens`/`revokeToken` (tokens.js) consistent across middleware, admin routes, and tests. `getOwned` in apiV1.js mirrors admin's `getOwnedPrototype`. Column names (`published_version_id`, `draft_version_id`, `version_id`, `token_hash`, `last_used_at`) consistent between schema (Task 1) and all consumers.

**Note on the MCP layer:** Phase 2 (MCP server + `.protoshare.json` manifest) and Phase 3 (comment resolution workflow + token HTML panel) are deliberately separate plans — each ships working software on its own, per the spec's build order.
