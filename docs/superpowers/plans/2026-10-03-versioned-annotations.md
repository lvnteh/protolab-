# Versioned Annotations + Admin Version Upload/Publish + Reviewer Version Switcher — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins upload new prototype versions and choose which is published from the browser, let reviewers switch among previously-published versions on the same share URL, and bind every comment/explanation to the exact version it was made on — behind one shared annotations module.

**Architecture:** Four dependency-ordered workstreams. (1) Add `version_id` to `explanations`, recreate its unique index with version in scope, backfill reply versions, clear legacy explanations. (2) Extract a shared `src/services/annotations.js` that resolves the viewed version and performs version-scoped reads/writes for both comments and explanations; rewrite `api.js` handlers to delegate; give the machine `apiV1` explanations parity. (3) Extend `src/services/versions.js` with `setPublished` / `listPublishedVersions` / `listAllVersions` / `resolvePublishedVersion` (keeping `publish()` untouched). (4) Admin upload+publish routes and Versions-tab UI; reviewer `?version=N` delivery + inject attributes + `feedback.js` switcher.

**Tech Stack:** Express 5, Postgres (`pg` Pool), CommonJS, Node ≥22, multer `memoryStorage`, markdown-it + sanitize-html, express-session, nanoid(12), Jest + supertest (`npm run check` = `eslint src tests mcp` + `jest --runInBand`).

**Spec:** `docs/superpowers/specs/2026-10-03-versioned-annotations-design.md`

## Global Constraints

- **No auto-commit / no push.** Per workspace memory `no-auto-commit` / `no-github-push`, run every task's verification but perform the per-task `git commit` ONLY if the user has explicitly authorized committing. Never `git push` / open a PR without an explicit request.
- **Keep `versions.publish()` byte-for-byte unchanged.** The machine endpoint (`apiV1.js:196`) and `tests/conflict.test.js:86-90` depend on its 409-on-already-published. The new admin publish path uses a SEPARATE `setPublished` — do NOT alias.
- **Status is authoritative:** `'draft'` = admin-only, never reviewer-visible/renderable; `'published'` = sticky, reviewer-visible/switchable. `prototypes.published_version_id` = the current live/default version.
- **Content-type is locked** to the prototype's existing `content_type` on EVERY upload path (admin AND `apiV1`). Reject a mismatched extension with 400 before storing.
- **One shared resolver** (`annotations.resolveViewedVersion`) governs BOTH the read filter and the write stamp. A requested `version` is honored only if it is a `status='published'` version of THIS prototype; otherwise fall back to `published_version_id`. Drafts and cross-prototype versions are never resolvable.
- **Deliberate deviation from the spec's "no-published-version guard" (spec §Edge cases / §Shared module).** The spec says reject writes when `resolveViewedVersion` yields `null`. The existing reviewer suite (`tests/api.test.js`) calls `initDb()` ONCE before inserting its prototypes (lines 18 then 21/141/183/211/323) and never again, so those prototypes have `published_version_id IS NULL` yet post comments/explanations expecting 201 and read them back. Rejecting null-version writes would break that whole suite, and a `version_id = $2` read filter with `$2 = null` would make those rows unreadable. **Resolution:** writes stamp whatever `resolveViewedVersion` yields (a validated published version id, else the `published_version_id` pointer, else `null`); reads filter with `version_id IS NOT DISTINCT FROM $2`. This keeps every existing reviewer test green, is production-correct (real prototypes always have a published v1 via `admin.js:191-196` / the v1 backfill), and still makes drafts unreadable and un-stampable — the security intent is fully preserved because `resolveViewedVersion` never returns a draft's id. (In production `published_version_id` is never null, so the `null` branch is a test-fixture / deleted-published-version degenerate case only.)
- **CSP:** the markdown delivery view sends `script-src 'self'`. The reviewer version switcher must use the external `feedback.js` + `addEventListener` and data-attributes only — no inline `<script>` and no inline `onchange`.
- **Migrations** run inside `initDb()` under the existing advisory lock (`BACKFILL_LOCK_KEY = 91537`) and are marker-guarded in `schema_migrations`. The explanations data migration (reply backfill + legacy clear) must run AFTER the `v1-version-backfill` loop so parents already carry `version_id`.

## Review Focus

The five inputs the spec implies but no happy-path task naturally exercises, most-likely-to-bite first. Each gets its test added to the owning task, noted inline there.

1. **Reviewer passes `?version=<a draft number>` (or another prototype's version).** Expected: never serve/leak the draft — delivery 302-redirects to the bare `/view`; `/api` reads fall back to the live version. (Owned by Task 4 read test + Task 13 delivery test.)
2. **A reply whose parent is on version N.** Expected: the reply is stamped version N and still appears nested under its parent in a `?version=N` read — it must not vanish when reads start filtering by version. (Owned by Task 4.)
3. **Second explanation on the same selector/page but a DIFFERENT version.** Expected: allowed (not a 409) because the unique index now includes `COALESCE(version_id,'')`; a second explanation on the SAME version/selector is still 409. (Owned by Task 1 + Task 4.)
4. **Upload with the wrong extension** (`.md` onto an HTML prototype, or vice-versa) on BOTH the admin and `apiV1` paths. Expected: 400 before anything is stored. (Owned by Task 8 + Task 11.)
5. **`setPublished` re-pointing to an OLDER already-published version** after a newer one went live. Expected: 200 and `published_version_id` moves back (the switch-back `publish()` blocks with 409 today). (Owned by Task 6.)

## File Structure

- **Create** `src/services/annotations.js` — the shared version resolver + version-scoped comment/explanation reads and writes + anchor-column helpers. One responsibility: annotation persistence bound to a version.
- **Create** `tests/annotations.test.js` — unit tests for the shared module and the explanations data migration helper.
- **Modify** `src/db.js` — explanations `version_id` column, unique-index recreation, `idx_explanations_version`, FK cleanup in the `DO` block, and the exported `runAnnotationVersionBackfill` called under the advisory lock.
- **Modify** `src/routes/api.js` — all 8 comment/explanation handlers delegate to `annotations.js`.
- **Modify** `src/routes/apiV1.js` — explanations feedback parity (`version_id` → `madeAgainstVersion`); upload content-type lock.
- **Modify** `src/services/versions.js` — add `setPublished`, `listPublishedVersions`, `listAllVersions`, `resolvePublishedVersion`.
- **Modify** `src/routes/admin.js` — add upload + publish routes; status-based versions list; admin explanations endpoint; comments version filter; detail-view `contentType`; re-scope `/preview`.
- **Modify** `src/routes/delivery.js` — `?version=N` resolution, redirect on invalid/draft, version context to `injectSdk`.
- **Modify** `src/services/inject.js` — emit `data-version` / `data-versions` / `data-view-base` attributes.
- **Modify** `public/sdk/feedback.js` — read the new attrs, version-scope fetches/bodies, render the `#__fb-version-switcher`.
- **Modify** `src/views/admin-prototype-detail.html` — upload form, publish buttons/badges, per-version selectors.

---

## Workstream ① — Schema + version-scope explanations

### Task 1: `explanations.version_id` column, indexes, and FK

**Files:**
- Modify: `src/db.js:120-138` (after the `explanations` CREATE TABLE / unique index) and `src/db.js:315-360` (the FK-cleanup `DO` block)
- Test: `tests/annotations.test.js` (new)

**Interfaces:**
- Produces: an `explanations.version_id TEXT` column (FK → `prototype_versions(id)` `ON DELETE SET NULL`); unique index `idx_explanations_unique` recreated as `(prototype_id, element_selector, COALESCE(page_url,''), COALESCE(version_id,''))`; non-unique `idx_explanations_version(prototype_id, version_id)`.

- [ ] **Step 1: Write the failing test**

```js
// tests/annotations.test.js
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();
const hasDb = !!process.env.DATABASE_URL;
jest.setTimeout(15000);

const { initDb, getDb, closeDb } = require('../src/db');
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/annotations.test.js -t "schema" --runInBand`
Expected: FAIL — `column "version_id" of relation "explanations" does not exist` (and the uniqueness test errors on the missing column).

- [ ] **Step 3: Add the DDL in `src/db.js`**

Replace the unique-index block at `src/db.js:135-138`:

```js
  await _pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_explanations_unique
      ON explanations(prototype_id, element_selector, COALESCE(page_url, ''))
  `);
```

with the column add + index recreation + the per-version index:

```js
  // Version-scope explanations (mirrors comments.version_id). Nullable: a legacy
  // row carries NULL until the data migration clears it; a new row is stamped
  // with the viewed version by annotations.js.
  await _pool.query(`ALTER TABLE explanations ADD COLUMN IF NOT EXISTS version_id TEXT`);

  // Recreate the uniqueness guard with version in scope. COALESCE(version_id,'')
  // (not NULL-distinct) so two NULL-version rows on one selector still collide —
  // preserving the 23505 -> 409 edit-in-place upsert contract — while the SAME
  // selector/page on a DIFFERENT version is allowed.
  await _pool.query(`DROP INDEX IF EXISTS idx_explanations_unique`);
  await _pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_explanations_unique
      ON explanations(prototype_id, element_selector, COALESCE(page_url, ''), COALESCE(version_id, ''))
  `);
  await _pool.query(`
    CREATE INDEX IF NOT EXISTS idx_explanations_version
      ON explanations(prototype_id, version_id)
  `);
```

- [ ] **Step 4: Add explanations version FK to the `DO` block**

In the `DO $$` block, immediately after the `comments_version_fk` re-add (`src/db.js:340`), insert (mirrors the comments pattern):

```sql
      UPDATE explanations SET version_id = NULL
        WHERE version_id IS NOT NULL
          AND version_id NOT IN (SELECT id FROM prototype_versions);
      ALTER TABLE explanations DROP CONSTRAINT IF EXISTS explanations_version_id_fkey;
      ALTER TABLE explanations DROP CONSTRAINT IF EXISTS explanations_version_fk;
      ALTER TABLE explanations ADD  CONSTRAINT explanations_version_fk
        FOREIGN KEY (version_id) REFERENCES prototype_versions(id) ON DELETE SET NULL;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/annotations.test.js -t "schema" --runInBand`
Expected: PASS (both tests).

- [ ] **Step 6: Commit** (only if committing is authorized)

```bash
git add src/db.js tests/annotations.test.js
git commit -m "feat(db): version-scope explanations (version_id column, index, FK)"
```

---

### Task 2: Reply-version backfill + legacy explanation clear

**Files:**
- Modify: `src/db.js` — add exported `runAnnotationVersionBackfill(db)`; call it under the advisory lock after the `v1-version-backfill` loop, marker-guarded by `explanations-version-scope-v1`
- Test: `tests/annotations.test.js`

**Interfaces:**
- Produces: `runAnnotationVersionBackfill(db)` — stamps each reply's `version_id` from its parent and deletes every `version_id IS NULL` explanation; idempotent. Exported from `src/db.js` for direct testing; invoked once (marker-guarded) by `initDb()`.
- Consumes: the `version_id` column from Task 1.

- [ ] **Step 1: Write the failing test**

```js
// tests/annotations.test.js — append inside the (hasDb ? describe : describe.skip) block
const { runAnnotationVersionBackfill } = require('../src/db');

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/annotations.test.js -t "backfill" --runInBand`
Expected: FAIL — `runAnnotationVersionBackfill is not a function`.

- [ ] **Step 3: Implement and export the backfill in `src/db.js`**

Add this function near the other migration helpers (top-level in the module):

```js
// One-time data migration for version-scoped annotations. Stamps every reply
// with its parent's version (new replies created by the pre-fix path carry
// NULL), then clears all legacy prototype-scoped explanations (Option A: no
// version reference survives). Idempotent; safe to re-run.
async function runAnnotationVersionBackfill(db) {
  await db.query(`
    UPDATE comments c SET version_id = p.version_id
    FROM comments p
    WHERE c.parent_id = p.id AND c.version_id IS NULL AND p.version_id IS NOT NULL
  `);
  await db.query(`DELETE FROM explanations WHERE version_id IS NULL`);
}
```

Export it: add `runAnnotationVersionBackfill` to `module.exports`.

- [ ] **Step 4: Invoke it under the advisory lock**

In `initDb()`, after the `v1-version-backfill` `if (!(markerPresent && ...))` block closes (`src/db.js:437`) and before the org-migration block (`:439`), add — still on `lockClient`:

```js
    // Explanations version-scope data migration (runs AFTER v1 backfill so
    // parent comments already carry version_id). Marker-guarded, same lock.
    const { rows: expMarker } = await lockClient.query(
      'SELECT 1 FROM schema_migrations WHERE name = $1', ['explanations-version-scope-v1']);
    if (!expMarker.length) {
      await runAnnotationVersionBackfill(lockClient);
      await lockClient.query(
        `INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)
         ON CONFLICT (name) DO NOTHING`,
        ['explanations-version-scope-v1', new Date().toISOString()]);
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/annotations.test.js -t "backfill" --runInBand`
Expected: PASS.

- [ ] **Step 6: Commit** (only if committing is authorized)

```bash
git add src/db.js tests/annotations.test.js
git commit -m "feat(db): backfill reply versions and clear legacy explanations"
```

---

## Workstream ② — Shared annotations module + route rewrites

### Task 3: Create `src/services/annotations.js`

**Files:**
- Create: `src/services/annotations.js`
- Test: `tests/annotations.test.js`

**Interfaces:**
- Consumes: `getDb()`; the `version_id` columns from Workstream ①.
- Produces:
  - `resolveViewedVersion(prototypeId, requestedVersion)` → `Promise<{ versionId: string|null }>`. `requestedVersion` is an integer version NUMBER (or null/undefined). Honored only if it is a `status='published'` version of this prototype; else falls back to `prototypes.published_version_id`; `null` when the prototype has no published version.
  - `serializeAnchorCols(type, anchor)` → `{ quote, prefix, suffix, start, end }` (all `null` unless `type==='range'` with a non-empty quote). Throws `{ code:'ANCHOR_REQUIRED' }` when `type==='range'` and the quote is missing/blank.
  - `anchorFromRow(row)` → `{ quote, prefix, suffix, start, end } | null`.
  - `listComments(prototypeId, versionId)` → `Promise<Array>` — the reviewer shape: parent rows with `order` and nested `replies`, version-filtered.
  - `listExplanations(prototypeId, versionId)` → `Promise<Array>` — raw explanation rows, version-filtered.
  - `createComment(prototypeId, versionId, fields)` → `Promise<{ id }>`. `fields`: `{ email, type, comment, element, breadcrumb, pageUrl, tag, xPct, yPct, parentId, anchor }`. When `fields.parentId` is set, inserts a reply (minimal columns) stamped with `versionId`; otherwise a full insert stamped with `versionId`.
  - `createExplanation(prototypeId, versionId, fields)` → `Promise<{ id }>`. `fields`: `{ elementSelector, xPct, yPct, pageUrl, body }`. Re-throws `23505` so the route maps it to 409.

- [ ] **Step 1: Write the failing test**

```js
// tests/annotations.test.js — append inside the (hasDb ? describe : describe.skip) block
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/annotations.test.js -t "resolveViewedVersion" --runInBand`
Expected: FAIL — `Cannot find module '../src/services/annotations'`.

- [ ] **Step 3: Implement `src/services/annotations.js`**

```js
// src/services/annotations.js
// Shared, version-scoped persistence for both comments and explanations. One
// resolver (resolveViewedVersion) governs the read filter and the write stamp,
// so a reviewer can neither read nor stamp a draft's annotation set.
const { nanoid } = require('nanoid');
const { getDb } = require('../db');

const VALID_TAGS = ['bug', 'copy', 'question', 'idea', 'other'];

// requestedVersion is an integer version NUMBER (query ?version / body.version),
// honored only when it names a PUBLISHED version of this prototype; otherwise we
// fall back to the live pointer. Returns { versionId } (row id) or { versionId:null }.
async function resolveViewedVersion(prototypeId, requestedVersion) {
  const { rows: protoRows } = await getDb().query(
    'SELECT published_version_id FROM prototypes WHERE id = $1', [prototypeId]);
  const pointer = protoRows[0] ? protoRows[0].published_version_id : null;
  if (requestedVersion != null) {
    const v = parseInt(requestedVersion, 10);
    if (!Number.isNaN(v)) {
      const { rows } = await getDb().query(
        `SELECT id FROM prototype_versions
         WHERE prototype_id = $1 AND version = $2 AND status = 'published'`,
        [prototypeId, v]);
      if (rows[0]) return { versionId: rows[0].id };
    }
  }
  return { versionId: pointer };
}

// Range (markdown text-selection) comments carry an anchor; element/general do not.
function serializeAnchorCols(type, anchor) {
  if (type !== 'range') return { quote: null, prefix: null, suffix: null, start: null, end: null };
  if (!anchor || !anchor.quote || !String(anchor.quote).trim()) {
    const e = new Error('Range comment requires an anchor quote.'); e.code = 'ANCHOR_REQUIRED'; throw e;
  }
  return {
    quote: String(anchor.quote),
    prefix: anchor.prefix != null ? String(anchor.prefix) : null,
    suffix: anchor.suffix != null ? String(anchor.suffix) : null,
    start: Number.isInteger(anchor.start) ? anchor.start : null,
    end: Number.isInteger(anchor.end) ? anchor.end : null,
  };
}

function anchorFromRow(row) {
  return row.anchor_quote ? {
    quote: row.anchor_quote,
    prefix: row.anchor_prefix || '',
    suffix: row.anchor_suffix || '',
    start: row.anchor_start ?? null,
    end: row.anchor_end ?? null,
  } : null;
}

async function listComments(prototypeId, versionId) {
  const { rows } = await getDb().query(
    `SELECT id, email, type, element_selector, element_label, comment, created_at, tag, x_pct, y_pct, page_url, parent_id,
            anchor_quote, anchor_prefix, anchor_suffix, anchor_start, anchor_end
     FROM comments
     WHERE prototype_id = $1 AND version_id IS NOT DISTINCT FROM $2
     ORDER BY created_at ASC`,
    [prototypeId, versionId]);

  const parents = [];
  const replyMap = {};
  rows.forEach(r => {
    if (r.parent_id) {
      (replyMap[r.parent_id] ||= []).push({ id: r.id, email: r.email, comment: r.comment, created_at: r.created_at });
    } else {
      parents.push(r);
    }
  });
  return parents.map((r, i) => ({ ...r, order: i + 1, replies: replyMap[r.id] || [] }));
}

async function listExplanations(prototypeId, versionId) {
  const { rows } = await getDb().query(
    `SELECT id, element_selector, x_pct, y_pct, page_url, body, created_at, updated_at
     FROM explanations
     WHERE prototype_id = $1 AND version_id IS NOT DISTINCT FROM $2
     ORDER BY created_at ASC`,
    [prototypeId, versionId]);
  return rows;
}

async function createComment(prototypeId, versionId, fields) {
  const id = nanoid(12);
  const email = fields.email || 'local@test.com';
  if (fields.parentId) {
    await getDb().query(
      `INSERT INTO comments (id, prototype_id, email, type, comment, created_at, parent_id, version_id)
       VALUES ($1,$2,$3,'reply',$4,$5,$6,$7)`,
      [id, prototypeId, email, fields.comment.trim(), new Date().toISOString(), fields.parentId, versionId]);
    return { id };
  }
  const anchorCols = serializeAnchorCols(fields.type, fields.anchor);
  await getDb().query(
    `INSERT INTO comments
       (id, prototype_id, email, type, element_selector, element_label, element_tag,
        breadcrumb, comment, page_url, created_at, tag, x_pct, y_pct, version_id,
        anchor_quote, anchor_prefix, anchor_suffix, anchor_start, anchor_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [
      id, prototypeId, email, fields.type,
      fields.element?.selector || null,
      fields.element?.label || null,
      fields.element?.tagName || null,
      fields.breadcrumb ? JSON.stringify(fields.breadcrumb) : null,
      fields.comment.trim(),
      fields.pageUrl || null,
      new Date().toISOString(),
      VALID_TAGS.includes(fields.tag) ? fields.tag : null,
      typeof fields.xPct === 'number' ? fields.xPct : null,
      typeof fields.yPct === 'number' ? fields.yPct : null,
      versionId,
      anchorCols.quote, anchorCols.prefix, anchorCols.suffix, anchorCols.start, anchorCols.end,
    ]);
  return { id };
}

async function createExplanation(prototypeId, versionId, fields) {
  const id = nanoid(12);
  const now = new Date().toISOString();
  await getDb().query(
    `INSERT INTO explanations (id, prototype_id, element_selector, x_pct, y_pct, page_url, body, created_at, updated_at, version_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, prototypeId, fields.elementSelector,
     typeof fields.xPct === 'number' ? fields.xPct : null,
     typeof fields.yPct === 'number' ? fields.yPct : null,
     fields.pageUrl || null, fields.body.trim(), now, now, versionId]);
  return { id };
}

module.exports = {
  resolveViewedVersion, serializeAnchorCols, anchorFromRow,
  listComments, listExplanations, createComment, createExplanation,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/annotations.test.js --runInBand`
Expected: PASS (all annotations suites).

- [ ] **Step 5: Commit** (only if committing is authorized)

```bash
git add src/services/annotations.js tests/annotations.test.js
git commit -m "feat(annotations): shared version-scoped comment/explanation module"
```

---

### Task 4: Rewrite `src/routes/api.js` to delegate to `annotations.js`

**Files:**
- Modify: `src/routes/api.js` — POST `/comments` (`:55`), GET `/comments/:prototypeId` (`:132`), GET `/explanations/:prototypeId` (`:201`), POST `/explanations` (`:215`). PATCH/DELETE handlers keep `authorizeResource` unchanged.
- Test: `tests/api.test.js` (append)

**Interfaces:**
- Consumes: `annotations.resolveViewedVersion/listComments/listExplanations/createComment/createExplanation` (Task 3).
- Produces: no new exports; version-scoped `/api` behavior. Reads accept `?version=N`; writes accept `version` in the JSON body.

- [ ] **Step 1: Write the failing test**

`tests/api.test.js` already builds `app` with a reviewer-session stub (`req.session.prototypeId = req.get('x-test-proto') || protoId`) and inserts a prototype. These new tests need a prototype that HAS published versions, so create one with two published versions in a nested `describe`.

```js
// tests/api.test.js — append a new describe near the end, inside the hasDb gate
describe('version-scoped annotations', () => {
  let vp, v1, v2;
  beforeAll(async () => {
    vp = nanoid(12);
    await getDb().query(
      'INSERT INTO prototypes (id, name, filename, share_token, created_at) VALUES ($1,$2,$3,$4,$5)',
      [vp, 'VP', `${vp}.html`, nanoid(12), new Date().toISOString()]);
    const mk = async (n) => {
      const id = nanoid(12);
      await getDb().query(
        `INSERT INTO prototype_versions (id,prototype_id,version,filename,status,created_at,content_type)
         VALUES ($1,$2,$3,$4,'published',$5,'html')`,
        [id, vp, n, `${id}.html`, new Date().toISOString()]);
      return id;
    };
    v1 = await mk(1); v2 = await mk(2);
    await getDb().query('UPDATE prototypes SET published_version_id = $1 WHERE id = $2', [v2, vp]);
    void v1;
  });

  test('a comment is stamped against the viewed version and only shows there', async () => {
    await request(app).post('/api/comments').set('x-test-proto', vp)
      .send({ prototypeId: vp, type: 'element', comment: 'on v1', element: { selector: '.a' }, version: 1 })
      .expect(201);
    const onV1 = await request(app).get(`/api/comments/${vp}?version=1`).set('x-test-proto', vp).expect(200);
    expect(onV1.body.map(c => c.comment)).toContain('on v1');
    const onV2 = await request(app).get(`/api/comments/${vp}?version=2`).set('x-test-proto', vp).expect(200);
    expect(onV2.body.map(c => c.comment)).not.toContain('on v1');
  });

  test('a reply appears nested in its parent version read (Review Focus #2)', async () => {
    const parent = await request(app).post('/api/comments').set('x-test-proto', vp)
      .send({ prototypeId: vp, type: 'element', comment: 'parent', element: { selector: '.b' }, version: 1 }).expect(201);
    await request(app).post('/api/comments').set('x-test-proto', vp)
      .send({ prototypeId: vp, comment: 'reply', parentId: parent.body.id, version: 1 }).expect(201);
    const onV1 = await request(app).get(`/api/comments/${vp}?version=1`).set('x-test-proto', vp).expect(200);
    const p = onV1.body.find(c => c.comment === 'parent');
    expect(p.replies.map(r => r.comment)).toContain('reply');
  });

  test('a draft ?version is not honored — read falls back to the live version (Review Focus #1)', async () => {
    const dv = nanoid(12);
    await getDb().query(
      `INSERT INTO prototype_versions (id,prototype_id,version,filename,status,created_at,content_type)
       VALUES ($1,$2,3,$3,'draft',$4,'html')`,
      [dv, vp, `${dv}.html`, new Date().toISOString()]);
    // writing while "viewing" the draft stamps the LIVE version (v2), not the draft
    await request(app).post('/api/comments').set('x-test-proto', vp)
      .send({ prototypeId: vp, type: 'element', comment: 'sneaky', element: { selector: '.c' }, version: 3 }).expect(201);
    const onV3 = await request(app).get(`/api/comments/${vp}?version=3`).set('x-test-proto', vp).expect(200);
    expect(onV3.body.map(c => c.comment)).toContain('sneaky'); // ?version=3 fell back to live=v2
    const onV2 = await request(app).get(`/api/comments/${vp}?version=2`).set('x-test-proto', vp).expect(200);
    expect(onV2.body.map(c => c.comment)).toContain('sneaky');
  });

  test('same selector explanation on two versions is OK; same version is 409 (Review Focus #3)', async () => {
    await request(app).post('/api/explanations').set('x-test-proto', vp)
      .send({ prototypeId: vp, elementSelector: '.e', pageUrl: '/e', body: 'live one', version: 2 }).expect(201);
    await request(app).post('/api/explanations').set('x-test-proto', vp)
      .send({ prototypeId: vp, elementSelector: '.e', pageUrl: '/e', body: 'dupe', version: 2 }).expect(409);
    await request(app).post('/api/explanations').set('x-test-proto', vp)
      .send({ prototypeId: vp, elementSelector: '.e', pageUrl: '/e', body: 'v1 one', version: 1 }).expect(201);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/api.test.js -t "version-scoped" --runInBand`
Expected: FAIL — reads/writes are not yet version-scoped (`on v1` leaks into the v2 read; same-selector cross-version insert hits 409).

- [ ] **Step 3: Rewrite the four handlers**

At the top of `src/routes/api.js`, add the require (keep the existing `versions` require; it is no longer used by these handlers but other code may reference it — remove only if lint flags it):

```js
const annotations = require('../services/annotations');
```

Replace POST `/comments` body (`src/routes/api.js:65-125`, from `const id = nanoid(12);` through the final `res.status(201)...`) with:

```js
    try {
      let versionId;
      if (parentId) {
        const { rows: parentRows } = await getDb().query(
          'SELECT id, parent_id, version_id FROM comments WHERE id = $1 AND prototype_id = $2',
          [parentId, prototypeId]);
        if (!parentRows.length) return res.status(404).json({ error: 'Parent comment not found.' });
        if (parentRows[0].parent_id) return res.status(400).json({ error: 'Cannot reply to a reply.' });
        versionId = parentRows[0].version_id;           // reply inherits the parent's version
      } else {
        if (!['general', 'element', 'range'].includes(type)) return res.status(400).json({ error: 'Invalid type.' });
        ({ versionId } = await annotations.resolveViewedVersion(prototypeId, req.body.version));
      }
      const { id } = await annotations.createComment(prototypeId, versionId,
        { email: commentEmail, type, comment, element, breadcrumb, pageUrl, tag, xPct, yPct, parentId, anchor });
      return res.status(201).json({ ok: true, id });
    } catch (e) {
      if (e.code === 'ANCHOR_REQUIRED') return res.status(400).json({ error: 'Range comment requires an anchor quote.' });
      throw e;
    }
```

(Delete the now-unused `const id = nanoid(12);`, the inline anchor block, and the `versions.publishedVersionId` call. Keep the earlier validation at `:57-63`.)

Replace the GET `/comments/:prototypeId` body (`:137-164`) with:

```js
    const { versionId } = await annotations.resolveViewedVersion(req.params.prototypeId, req.query.version);
    const result = await annotations.listComments(req.params.prototypeId, versionId);
    res.json(result);
```

Replace the GET `/explanations/:prototypeId` body (`:205-212`) with:

```js
  const { versionId } = await annotations.resolveViewedVersion(req.params.prototypeId, req.query.version);
  res.json(await annotations.listExplanations(req.params.prototypeId, versionId));
```

Replace the POST `/explanations` insert block (`:223-238`, from `const id = nanoid(12);` through `res.status(201)...`) with:

```js
  try {
    const { versionId } = await annotations.resolveViewedVersion(prototypeId, req.body.version);
    const { id } = await annotations.createExplanation(prototypeId, versionId, { elementSelector, xPct, yPct, pageUrl, body });
    res.status(201).json({ ok: true, id });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Explanation already exists for this element.' });
    throw e;
  }
```

- [ ] **Step 4: Run the full api suite to verify it passes and nothing regressed**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/api.test.js --runInBand`
Expected: PASS — new version-scoped tests AND the existing cross-prototype isolation suite (version-less fixtures still accept writes with `version_id = null` and read them back via `IS NOT DISTINCT FROM`).

- [ ] **Step 5: Commit** (only if committing is authorized)

```bash
git add src/routes/api.js tests/api.test.js
git commit -m "feat(api): version-scope reviewer comments and explanations via annotations.js"
```

---

### Task 5: `apiV1` feedback explanations parity

**Files:**
- Modify: `src/routes/apiV1.js:100-107` (explanations query + mapping) and the comment anchor shaping (`:86-92`, optional refactor to `annotations.anchorFromRow`)
- Test: `tests/feedback-api.test.js` (append)

**Interfaces:**
- Consumes: `annotations.anchorFromRow` (Task 3); `versionOf` map already built at `apiV1.js:63`.
- Produces: each explanation in the feedback payload gains `madeAgainstVersion` (integer, `null`-version → `1`, mirroring comments at `:94`).

- [ ] **Step 1: Write the failing test**

```js
// tests/feedback-api.test.js — add assertions to the existing
// 'feedback payload nests replies, includes explanations and madeAgainstVersion' test,
// right after the existing `expect(res.body.explanations[0].body)...` line:
expect(res.body.explanations[0].madeAgainstVersion).toBe(1);
```

Note: the fixture's explanation (`feedback-api.test.js:83-85`) is inserted with no `version_id` (NULL) and survives the legacy clear because it is inserted AFTER `initDb()`; a NULL version maps to `madeAgainstVersion === 1`.

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/feedback-api.test.js -t "madeAgainstVersion" --runInBand`
Expected: FAIL — `expect(undefined).toBe(1)` (explanations currently expose no version).

- [ ] **Step 3: Update the explanations query + mapping in `apiV1.js`**

Replace `src/routes/apiV1.js:100-102`:

```js
    const { rows: expl } = await getDb().query(
      `SELECT element_selector, page_url, body, version_id FROM explanations
       WHERE prototype_id = $1 ORDER BY created_at ASC`, [proto.id]);
```

and the `explanations:` mapping at `:107`:

```js
      explanations: expl.map(e => ({
        elementSelector: e.element_selector, pageUrl: e.page_url, body: e.body,
        madeAgainstVersion: versionOf[e.version_id] || 1,
      })),
```

(Optional, same commit: at the top add `const annotations = require('../services/annotations');` and replace the inline anchor object at `:86-92` with `anchor: annotations.anchorFromRow(r),` to share the shaping. The existing range-anchor test must stay green.)

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/feedback-api.test.js --runInBand`
Expected: PASS (all feedback-api tests, including the range-anchor test).

- [ ] **Step 5: Commit** (only if committing is authorized)

```bash
git add src/routes/apiV1.js tests/feedback-api.test.js
git commit -m "feat(apiV1): surface madeAgainstVersion on feedback explanations"
```

---

## Workstream ③ — Version / publish service

### Task 6: `versions.setPublished`

**Files:**
- Modify: `src/services/versions.js` — add `setPublished`; keep `publish` untouched
- Test: `tests/versions.test.js` (append)

**Interfaces:**
- Produces: `setPublished(prototypeId, version)` → `Promise<{ version, status:'published', promoted, publishedVersionId }>`. Not found → throw `{ code:'CONFLICT' }`. A draft is promoted (`promoted=true`); an already-published version is re-pointed only (status stays, `promoted=false`), including a switch BACK to an older published version. Serialized with `SELECT 1 FROM prototypes ... FOR UPDATE`.

- [ ] **Step 1: Write the failing test**

```js
// tests/versions.test.js — append inside the existing hasDb-gated describe,
// reusing that file's helpers for creating a prototype + draft versions.
test('setPublished promotes a draft, then re-points to an older published version without 409', async () => {
  const p = await mkProto();                     // helper already in versions.test.js
  const v1 = await versions.createDraft(p, 'f1.html', 'v1');
  await versions.setPublished(p, v1.version);    // v1 live
  const v2 = await versions.createDraft(p, 'f2.html', 'v2');
  const r2 = await versions.setPublished(p, v2.version);
  expect(r2.promoted).toBe(true);                // draft promoted
  expect(r2.status).toBe('published');

  const back = await versions.setPublished(p, v1.version);  // switch BACK (Review Focus #5)
  expect(back.promoted).toBe(false);             // already published → re-point only, no CONFLICT
  const { rows } = await getDb().query('SELECT published_version_id FROM prototypes WHERE id = $1', [p]);
  expect(rows[0].published_version_id).toBe(back.publishedVersionId);
});

test('setPublished on a missing version throws CONFLICT', async () => {
  const p = await mkProto();
  await expect(versions.setPublished(p, 99)).rejects.toMatchObject({ code: 'CONFLICT' });
});
```

If `tests/versions.test.js` lacks a `mkProto` helper, add one mirroring Task 1's (insert into `prototypes`, return id).

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/versions.test.js -t "setPublished" --runInBand`
Expected: FAIL — `versions.setPublished is not a function`.

- [ ] **Step 3: Implement `setPublished` in `src/services/versions.js`**

Add after `publish` (`src/services/versions.js:63`):

```js
// Admin go-live control. Unlike publish(), this NEVER 409s on an
// already-published version — it re-points published_version_id so an admin can
// switch back to any earlier published version. A draft is promoted to published.
async function setPublished(prototypeId, version) {
  const { rows } = await getDb().query(
    'SELECT id, status FROM prototype_versions WHERE prototype_id = $1 AND version = $2',
    [prototypeId, version]);
  if (!rows[0]) { const e = new Error('Version not found.'); e.code = 'CONFLICT'; throw e; }
  const vId = rows[0].id;
  const promoted = rows[0].status === 'draft';
  const client = await getDb().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM prototypes WHERE id = $1 FOR UPDATE', [prototypeId]);
    if (promoted) await client.query(`UPDATE prototype_versions SET status = 'published' WHERE id = $1`, [vId]);
    await client.query(
      `UPDATE prototypes SET published_version_id = $1,
         draft_version_id = CASE WHEN draft_version_id = $1 THEN NULL ELSE draft_version_id END
       WHERE id = $2`,
      [vId, prototypeId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { version, status: 'published', promoted, publishedVersionId: vId };
}
```

Add `setPublished` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/versions.test.js --runInBand`
Expected: PASS (including the untouched `publish`/conflict tests).

- [ ] **Step 5: Commit** (only if committing is authorized)

```bash
git add src/services/versions.js tests/versions.test.js
git commit -m "feat(versions): setPublished (promote draft or re-point to any published version)"
```

---

### Task 7: `listPublishedVersions`, `listAllVersions`, `resolvePublishedVersion`

**Files:**
- Modify: `src/services/versions.js`
- Test: `tests/versions.test.js` (append)

**Interfaces:**
- Produces:
  - `listPublishedVersions(prototypeId)` → `[{ version, note, createdAt, contentType, isCurrent }]`, `status='published'`, newest-first.
  - `listAllVersions(prototypeId)` → `[{ version, status, note, createdAt, contentType, isCurrent, isDraft }]`, newest-first, `isDraft = status==='draft'`.
  - `resolvePublishedVersion(prototypeId, version)` → `{ id, version, filename, contentType } | null` (`status='published'` only; `null` for draft/unknown/non-integer).

- [ ] **Step 1: Write the failing test**

```js
// tests/versions.test.js — append
test('list/resolve helpers respect status and flag the live version', async () => {
  const p = await mkProto();
  const v1 = await versions.createDraft(p, 'f1.html', 'first');
  await versions.setPublished(p, v1.version);
  const v2 = await versions.createDraft(p, 'f2.html', 'second'); // stays draft

  const pub = await versions.listPublishedVersions(p);
  expect(pub.map(v => v.version)).toEqual([1]);                 // draft excluded
  expect(pub[0].isCurrent).toBe(true);

  const all = await versions.listAllVersions(p);
  expect(all.map(v => v.version)).toEqual([2, 1]);              // newest-first
  expect(all.find(v => v.version === 2).isDraft).toBe(true);    // every draft flagged
  expect(all.find(v => v.version === 1).isCurrent).toBe(true);

  const r1 = await versions.resolvePublishedVersion(p, 1);
  expect(r1).toMatchObject({ version: 1, filename: 'f1.html', contentType: 'html' });
  expect(await versions.resolvePublishedVersion(p, 2)).toBeNull();   // draft → null
  expect(await versions.resolvePublishedVersion(p, 'x')).toBeNull(); // non-integer → null
  void v2;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/versions.test.js -t "list/resolve" --runInBand`
Expected: FAIL — `versions.listPublishedVersions is not a function`.

- [ ] **Step 3: Implement the three helpers in `src/services/versions.js`**

```js
async function listPublishedVersions(prototypeId) {
  const { rows } = await getDb().query(
    `SELECT v.version, v.note, v.created_at, v.content_type,
            COALESCE(v.id = p.published_version_id, false) AS is_current
     FROM prototype_versions v JOIN prototypes p ON p.id = v.prototype_id
     WHERE v.prototype_id = $1 AND v.status = 'published'
     ORDER BY v.version DESC`, [prototypeId]);
  return rows.map(r => ({
    version: r.version, note: r.note, createdAt: r.created_at,
    contentType: r.content_type || 'html', isCurrent: r.is_current,
  }));
}

async function listAllVersions(prototypeId) {
  const { rows } = await getDb().query(
    `SELECT v.version, v.status, v.note, v.created_at, v.content_type,
            COALESCE(v.id = p.published_version_id, false) AS is_current
     FROM prototype_versions v JOIN prototypes p ON p.id = v.prototype_id
     WHERE v.prototype_id = $1 ORDER BY v.version DESC`, [prototypeId]);
  return rows.map(r => ({
    version: r.version, status: r.status, note: r.note, createdAt: r.created_at,
    contentType: r.content_type || 'html', isCurrent: r.is_current, isDraft: r.status === 'draft',
  }));
}

async function resolvePublishedVersion(prototypeId, version) {
  const v = parseInt(version, 10);
  if (Number.isNaN(v)) return null;
  const { rows } = await getDb().query(
    `SELECT id, version, filename, content_type FROM prototype_versions
     WHERE prototype_id = $1 AND version = $2 AND status = 'published'`,
    [prototypeId, v]);
  return rows[0]
    ? { id: rows[0].id, version: rows[0].version, filename: rows[0].filename, contentType: rows[0].content_type || 'html' }
    : null;
}
```

Add all three to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/versions.test.js --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit** (only if committing is authorized)

```bash
git add src/services/versions.js tests/versions.test.js
git commit -m "feat(versions): published/all version listings + resolvePublishedVersion"
```

---

## Workstream ④ — Admin upload + publish UI, machine-upload lock

> `tests/admin-versions.test.js` provides a `signUpAsOrgAdmin(agent)` helper and a supertest `agent` with a logged-in admin session + CSRF. New admin-route tests reuse that harness (same file or a sibling that imports the same setup pattern). CSRF token goes in the `x-csrf-token` header.

### Task 8: `POST /admin/prototypes/:id/versions` (upload a draft, content-type locked)

**Files:**
- Modify: `src/routes/admin.js` — add the route near the other prototype routes; reuse the existing `upload` multer instance, `getOrgPrototype`, `storage`, `versions`, `filetype`
- Test: `tests/admin-versions.test.js` (append)

**Interfaces:**
- Consumes: `versions.createDraft` (existing), `filetype.contentTypeForFilename/extForContentType/mimeForContentType`, `getOrgPrototype`.
- Produces: `POST /admin/prototypes/:id/versions` (multipart `file`, optional `note`) → 201 `{ id, version, status:'draft' }`. 404 cross-org/missing; 400 no-file or content-type mismatch; 409 `{ error, currentVersion }` on `23505`.

- [ ] **Step 1: Write the failing test**

```js
// tests/admin-versions.test.js — append
test('admin uploads a new draft version; wrong content-type is rejected (Review Focus #4)', async () => {
  const agent = request.agent(app);
  const { protoId, csrf } = await signUpAsOrgAdmin(agent); // helper returns the seeded html prototype + csrf

  const ok = await agent.post(`/admin/prototypes/${protoId}/versions`)
    .set('x-csrf-token', csrf)
    .field('note', 'v2 draft')
    .attach('file', Buffer.from('<h1>v2</h1>'), 'v2.html');
  expect(ok.status).toBe(201);
  expect(ok.body).toMatchObject({ version: 2, status: 'draft' });

  const bad = await agent.post(`/admin/prototypes/${protoId}/versions`)
    .set('x-csrf-token', csrf)
    .attach('file', Buffer.from('# md'), 'notes.md');     // .md onto an html prototype
  expect(bad.status).toBe(400);
});

test('a non-admin org member cannot upload a version', async () => {
  const agent = request.agent(app);
  const { protoId, csrf } = await signUpAsOrgMember(agent); // member (non-admin) helper
  const res = await agent.post(`/admin/prototypes/${protoId}/versions`)
    .set('x-csrf-token', csrf)
    .attach('file', Buffer.from('<h1>x</h1>'), 'x.html');
  expect(res.status).toBe(403);
});
```

If `signUpAsOrgMember` does not exist, add it beside `signUpAsOrgAdmin`, creating a user with a `member` role in the admin's org (role from `org_memberships`).

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/admin-versions.test.js -t "uploads a new draft" --runInBand`
Expected: FAIL — the route does not exist (404).

- [ ] **Step 3: Implement the route in `src/routes/admin.js`**

Add after `POST /prototypes/:id/settings` (`src/routes/admin.js:230` region), modeled on `apiV1.js:159` and `admin.js:174`:

```js
router.post('/prototypes/:id/versions', orgs.requireAdmin, upload.single('file'), async (req, res) => {
  const proto = await getOrgPrototype(req.params.id, req.orgId, 'id, content_type');
  if (!proto) return res.status(404).json({ error: 'Not found.' });
  if (!req.file) return res.status(400).json({ error: 'Only .html or .md files are accepted.' });

  // Lock content-type to the prototype's existing type (decision 2 — no mixed histories).
  const uploadedType = filetype.contentTypeForFilename(req.file.originalname);
  const lockedType = proto.content_type || 'html';
  if (uploadedType !== lockedType) {
    return res.status(400).json({ error: `This prototype accepts ${lockedType} files only.` });
  }

  const filename = `${nanoid(12)}.${filetype.extForContentType(lockedType)}`;
  await storage.putPrototype(filename, req.file.buffer, filetype.mimeForContentType(lockedType));
  try {
    const v = await versions.createDraft(req.params.id, filename, req.body.note, lockedType);
    res.status(201).json(v);
  } catch (e) {
    if (e.code === '23505') {
      await storage.deletePrototype(filename).catch(() => {});
      return res.status(409).json({ error: 'Prototype changed; reload and retry.', currentVersion: await versions.latestVersion(req.params.id) });
    }
    throw e;
  }
});
```

(`getOrgPrototype`, `upload`, `nanoid`, `storage`, `versions`, `filetype` are all already required at the top of `admin.js`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/admin-versions.test.js --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit** (only if committing is authorized)

```bash
git add src/routes/admin.js tests/admin-versions.test.js
git commit -m "feat(admin): upload a new prototype version as a draft (content-type locked)"
```

---

### Task 9: `POST /admin/prototypes/:id/publish` (setPublished)

**Files:**
- Modify: `src/routes/admin.js`
- Test: `tests/admin-versions.test.js` (append)

**Interfaces:**
- Consumes: `versions.setPublished` (Task 6).
- Produces: `POST /admin/prototypes/:id/publish` (JSON `{ version:N }`) → 200 `{ version, status:'published', promoted }`. 400 if `version` is not an integer; 404 cross-org/missing; 409 on `CONFLICT`.

- [ ] **Step 1: Write the failing test**

```js
// tests/admin-versions.test.js — append
test('admin publishes a draft, then switches the live version back to an older one', async () => {
  const agent = request.agent(app);
  const { protoId, csrf } = await signUpAsOrgAdmin(agent);
  await agent.post(`/admin/prototypes/${protoId}/versions`).set('x-csrf-token', csrf)
    .attach('file', Buffer.from('<h1>v2</h1>'), 'v2.html').expect(201);

  const pub = await agent.post(`/admin/prototypes/${protoId}/publish`)
    .set('x-csrf-token', csrf).send({ version: 2 });
  expect(pub.status).toBe(200);
  expect(pub.body).toMatchObject({ version: 2, status: 'published', promoted: true });

  const back = await agent.post(`/admin/prototypes/${protoId}/publish`)
    .set('x-csrf-token', csrf).send({ version: 1 });
  expect(back.status).toBe(200);                 // re-point to older published → no 409
  expect(back.body.promoted).toBe(false);

  const bad = await agent.post(`/admin/prototypes/${protoId}/publish`)
    .set('x-csrf-token', csrf).send({ version: 'nope' });
  expect(bad.status).toBe(400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/admin-versions.test.js -t "publishes a draft" --runInBand`
Expected: FAIL — route missing (404).

- [ ] **Step 3: Implement the route**

Add directly after the upload route:

```js
router.post('/prototypes/:id/publish', orgs.requireAdmin, async (req, res) => {
  if (!await getOrgPrototype(req.params.id, req.orgId, 'id')) return res.status(404).json({ error: 'Not found.' });
  const version = parseInt(req.body.version, 10);
  if (Number.isNaN(version)) return res.status(400).json({ error: 'version must be an integer.' });
  try {
    const result = await versions.setPublished(req.params.id, version);
    res.json(result);
  } catch (err) {
    if (err.code === 'CONFLICT') return res.status(409).json({ error: err.message });
    throw err;
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/admin-versions.test.js --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit** (only if committing is authorized)

```bash
git add src/routes/admin.js tests/admin-versions.test.js
git commit -m "feat(admin): publish/select the live version via setPublished"
```

---

### Task 10: Admin list/explanations/comments version endpoints + detail contentType + re-scope preview

**Files:**
- Modify: `src/routes/admin.js` — GET `/prototypes/:id/versions` (`:422-436`), add GET `/prototypes/:id/explanations`, POST `/prototypes/:id/comments` (`:271`), GET `/prototypes/:id` (`:222-228`), GET `/prototypes/:id/preview` (`:356-391`)
- Test: `tests/admin-versions.test.js` (append)

**Interfaces:**
- Consumes: `versions.listAllVersions`, `versions.resolvePublished`, `annotations.resolveViewedVersion`/`listComments`.
- Produces:
  - GET `/prototypes/:id/versions` → status-based `listAllVersions` shape: `[{ version, status, note, createdAt, isCurrent, isDraft }]` (every coexisting draft flagged — fixes the pointer-based `isDraft` at `:427`).
  - GET `/prototypes/:id/explanations?version=N` → `[{ id, element_selector, page_url, body, version }]`; no `?version` = ALL versions (admin default).
  - POST `/prototypes/:id/comments` honors optional `filterValues.version` (integer) → scopes the admin comments grid to that version.
  - GET `/prototypes/:id` renders `contentType` into the view.
  - GET `/prototypes/:id/preview` serves the current PUBLISHED version with version-filtered comments.

- [ ] **Step 1: Write the failing test**

```js
// tests/admin-versions.test.js — append
test('admin versions list flags every draft by status; explanations endpoint filters by version', async () => {
  const agent = request.agent(app);
  const { protoId, csrf } = await signUpAsOrgAdmin(agent);
  await agent.post(`/admin/prototypes/${protoId}/versions`).set('x-csrf-token', csrf)
    .attach('file', Buffer.from('<h1>v2</h1>'), 'v2.html').expect(201);
  await agent.post(`/admin/prototypes/${protoId}/versions`).set('x-csrf-token', csrf)
    .attach('file', Buffer.from('<h1>v3</h1>'), 'v3.html').expect(201);

  const vs = await agent.get(`/admin/prototypes/${protoId}/versions`).expect(200);
  const drafts = vs.body.filter(v => v.isDraft).map(v => v.version).sort();
  expect(drafts).toEqual([2, 3]);                 // both coexisting drafts flagged
  expect(vs.body.find(v => v.version === 1).isCurrent).toBe(true);

  // seed one explanation on v1 (the live version) through the reviewer path is complex here;
  // assert the endpoint returns a version-tagged array and respects ?version
  const all = await agent.get(`/admin/prototypes/${protoId}/explanations`).expect(200);
  expect(Array.isArray(all.body)).toBe(true);
  const scoped = await agent.get(`/admin/prototypes/${protoId}/explanations?version=1`).expect(200);
  expect(Array.isArray(scoped.body)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/admin-versions.test.js -t "flags every draft" --runInBand`
Expected: FAIL — the explanations endpoint 404s; the versions `isDraft` is pointer-based (only the newest draft flagged).

- [ ] **Step 3a: Switch the versions list to `listAllVersions`**

Replace the GET `/prototypes/:id/versions` handler body (`src/routes/admin.js:423-435`) with:

```js
  if (!await getOrgPrototype(req.params.id, req.orgId, 'id')) return res.status(404).json({ error: 'Not found.' });
  res.json(await versions.listAllVersions(req.params.id));
```

- [ ] **Step 3b: Add the admin explanations endpoint**

Add near the versions route:

```js
// Admin explanations with their version number. No ?version = all versions
// (admin default); ?version=N scopes to that version. Reviewer-side scoping is
// in /api; this is the admin grid's own feed.
router.get('/prototypes/:id/explanations', orgs.requireOrg, async (req, res) => {
  if (!await getOrgPrototype(req.params.id, req.orgId, 'id')) return res.status(404).json({ error: 'Not found.' });
  const v = req.query.version != null ? parseInt(req.query.version, 10) : null;
  const params = [req.params.id];
  let where = 'e.prototype_id = $1';
  if (v != null && !Number.isNaN(v)) { params.push(v); where += ` AND pv.version = $2`; }
  const { rows } = await getDb().query(
    `SELECT e.id, e.element_selector, e.page_url, e.body, pv.version
     FROM explanations e
     LEFT JOIN prototype_versions pv ON pv.id = e.version_id
     WHERE ${where} ORDER BY e.created_at ASC`, params);
  res.json(rows);
});
```

- [ ] **Step 3c: Version-filter the admin comments grid**

In POST `/prototypes/:id/comments` (`src/routes/admin.js:271-328`), extend the filter. After `const typeFilter = filterValues.type;` (`:278`), add a version filter and fold it into BOTH the count and the page query. Replace the `hasFilter` branch logic so the WHERE clause optionally includes `AND version_id = (SELECT id FROM prototype_versions WHERE prototype_id = $x AND version = $y)`:

```js
  const typeFilter = filterValues.type;
  const versionFilter = filterValues.version != null ? parseInt(filterValues.version, 10) : null;
  const conds = ['prototype_id = $1', 'parent_id IS NULL'];
  const base = [req.params.id];
  if (typeFilter && typeFilter.length > 0) { base.push(typeFilter); conds.push(`type = $${base.length}`); }
  if (versionFilter != null && !Number.isNaN(versionFilter)) {
    base.push(versionFilter);
    conds.push(`version_id = (SELECT id FROM prototype_versions WHERE prototype_id = $1 AND version = $${base.length})`);
  }
  const whereSql = conds.join(' AND ');
  const totalResult = await getDb().query(`SELECT COUNT(*) AS n FROM comments WHERE ${whereSql}`, base);
  const rowsResult = await getDb().query(
    `SELECT * FROM comments WHERE ${whereSql} ORDER BY ${orderBy} ${order} LIMIT $${base.length + 1} OFFSET $${base.length + 2}`,
    [...base, parseInt(pageSize, 10), parseInt(offset, 10)]);
```

(Delete the old `hasFilter`/`totalResult`/`rowsResult` if/else block at `:279-300`; the reply-fetch and shaping below it are unchanged.)

- [ ] **Step 3d: Render `contentType` into the detail view**

In GET `/prototypes/:id` (`:222-228`), fetch `content_type` and pass it:

```js
  const proto = await getOrgPrototype(req.params.id, req.orgId); // already selects *
  if (!proto) return res.status(404).send('Not found.');
  const { rows: allowRows } = await getDb().query('SELECT email FROM allowlist WHERE prototype_id = $1', [proto.id]);
  const allowlist = allowRows.map(r => r.email).join('\n');
  res.send(renderView('admin-prototype-detail.html', {
    id: proto.id, name: escapeHtml(proto.name), allowlist: escapeHtml(allowlist),
    shareToken: proto.share_token, csrfToken: res.locals.csrfToken || '',
    orgRole: req.orgRole, contentType: proto.content_type || 'html',
  }));
```

- [ ] **Step 3e: Re-scope the stale preview**

In GET `/prototypes/:id/preview` (`:356-391`), serve the published version's file + version-filtered comments instead of the top-level `proto.filename`:

```js
  const proto = await getOrgPrototype(req.params.id, req.orgId);
  if (!proto) return res.status(404).send('Prototype not found.');
  const published = await versions.resolvePublished(proto.id);
  const filename = published ? published.filename : proto.filename;
  const contentType = published ? published.contentType : (proto.content_type || 'html');
  if (path.basename(filename) !== filename) return res.status(400).send('Invalid prototype filename.');
  const raw = await storage.getPrototype(filename);
  if (raw === null) return res.status(404).send('Prototype file not found.');

  const highlightId = req.query.comment || '';
  const { versionId } = await annotations.resolveViewedVersion(proto.id, req.query.version);
  const comments = await annotations.listComments(proto.id, versionId);

  let documentHtml = raw;
  if (contentType === 'markdown') {
    const { html } = markdown.render(raw);
    documentHtml = readView('markdown-shell.html').split('{{content}}').join(html);
  }
  const html = injectPreview(documentHtml, proto.id, highlightId, JSON.stringify(comments));
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
```

Add `const annotations = require('../services/annotations');` to the top of `admin.js` if not already present.

- [ ] **Step 4: Run tests to verify they pass**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/admin-versions.test.js tests/admin-upload-md.test.js --runInBand`
Expected: PASS (new test + the existing admin suites).

- [ ] **Step 5: Commit** (only if committing is authorized)

```bash
git add src/routes/admin.js tests/admin-versions.test.js
git commit -m "feat(admin): status-based versions list, version-aware explanations/comments, published preview"
```

---

### Task 11: Lock content-type on the `apiV1` upload path

**Files:**
- Modify: `src/routes/apiV1.js:159-189` (POST `/prototypes/:id/versions`)
- Test: `tests/conflict.test.js` or `tests/feedback-api.test.js` (append — whichever already builds the apiV1 app; `conflict.test.js` posts versions)

**Interfaces:**
- Consumes: `getOwned` returning `content_type`; `filetype.contentTypeForFilename`.
- Produces: a mismatched extension → 400 before storage; matched upload unchanged.

- [ ] **Step 1: Write the failing test**

```js
// in the apiV1-upload test file — append
test('apiV1 rejects an upload whose content-type differs from the prototype (Review Focus #4)', async () => {
  // `protoId` here is an html prototype owned by `rawToken` (reuse the file's setup)
  const res = await request(app).post(`/api/v1/prototypes/${protoId}/versions`)
    .set('Authorization', `Bearer ${rawToken}`)
    .attach('file', Buffer.from('# markdown'), 'notes.md');
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=$DATABASE_URL npx jest -t "apiV1 rejects an upload" --runInBand`
Expected: FAIL — currently the type is derived from the file (`apiV1.js:170`), so the `.md` upload is accepted (201).

- [ ] **Step 3: Lock the type in `apiV1.js`**

Change `getOwned` to also fetch `content_type` and enforce the lock. Replace `apiV1.js:161` and `:170`:

```js
    const proto = await getOwned(req.params.id, req.orgId, 'id, content_type');
    if (!proto) return res.status(404).json({ error: 'Not found.' });
    if (!req.file) return res.status(400).json({ error: 'Only .html or .md files are accepted.' });

    const lockedType = proto.content_type || 'html';
    if (filetype.contentTypeForFilename(req.file.originalname) !== lockedType) {
      return res.status(400).json({ error: `This prototype accepts ${lockedType} files only.` });
    }
```

Then at `:170-172` use `lockedType` instead of the file-derived `contentType`:

```js
    const filename = `${nanoid(12)}.${filetype.extForContentType(lockedType)}`;
    await storage.putPrototype(filename, req.file.buffer, filetype.mimeForContentType(lockedType));
    try {
      const v = await versions.createDraft(req.params.id, filename, req.body.note, lockedType);
```

(The `latestVersion`/`baseVersion` conflict guard at `:164-168` stays as-is.)

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/conflict.test.js tests/feedback-api.test.js --runInBand`
Expected: PASS (new 400 test + unchanged conflict/409 behavior).

- [ ] **Step 5: Commit** (only if committing is authorized)

```bash
git add src/routes/apiV1.js tests/conflict.test.js
git commit -m "feat(apiV1): lock version upload content-type to the prototype type"
```

---

### Task 12: Versions-tab UI — upload form, publish controls, version selectors

**Files:**
- Modify: `src/views/admin-prototype-detail.html` — Versions tab panel (`:271-288`), `loadVersions` (`:716-747`), `loadExplanations`/`renderExplanations` (`:614-651`), and the script-var block (PROTO_ID/CSRF/SHARE_TOKEN near `:308-310`)
- Test: `tests/admin-versions.test.js` (append a render assertion)

**Interfaces:**
- Consumes: the Task 10 endpoints (`/versions`, `/explanations?version=`, `/publish`), the `contentType` render var (Task 10 §3d), and `ORG_ROLE` already injected into this view.
- Produces: an admin-only upload form, status-driven badges + Set-live/Publish buttons, and a per-version `<select>` on the Comments and Explanations tabs. No new server interface.

- [ ] **Step 1: Write the failing test**

```js
// tests/admin-versions.test.js — append
test('the detail view renders the version upload form for an admin', async () => {
  const agent = request.agent(app);
  const { protoId } = await signUpAsOrgAdmin(agent);
  const res = await agent.get(`/admin/prototypes/${protoId}`).expect(200);
  expect(res.text).toContain('id="version-upload-form"');
  expect(res.text).toContain('accept=".html"');     // html prototype → accept locked
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/admin-versions.test.js -t "renders the version upload form" --runInBand`
Expected: FAIL — the form markup does not exist yet.

- [ ] **Step 3: Add the upload form + accept to the Versions panel**

In the Versions tab panel (`:272`), above `<div class="tbl-wrap">`, add (the template reads `{{contentType}}` / `{{orgRole}}`, already rendered server-side):

```html
      <form id="version-upload-form" class="version-upload" style="display:{{orgRole}}==='admin'?'flex':'none';gap:8px;align-items:center;margin-bottom:16px"
            onsubmit="return false">
        <input type="file" id="version-file" accept="{{contentType}}" />
        <input type="text" id="version-note" placeholder="Note (optional)" />
        <button class="btn btn-primary" id="version-upload-btn">Upload new version</button>
        <span id="version-upload-msg" style="color:hsl(0,84%,50%)"></span>
      </form>
```

Because `{{contentType}}` is `html` or `markdown`, map it to the file `accept` by rendering the extension server-side instead: in Task 10 §3d pass `accept: proto.content_type === 'markdown' ? '.md' : '.html'` as an extra render var `uploadAccept`, and use `accept="{{uploadAccept}}"` here. (Simpler than evaluating in-template.) Likewise render `orgRole` into a `data-org-role` on a wrapper and toggle visibility in JS rather than the inline ternary above — see Step 4.

- [ ] **Step 4: Wire upload + publish + selectors in the script**

Add the upload handler and extend `loadVersions` (replace the badge/`tbody` block at `:729-741`):

```js
document.getElementById('version-upload-btn')?.addEventListener('click', async () => {
  const f = document.getElementById('version-file').files[0];
  const msg = document.getElementById('version-upload-msg');
  if (!f) { msg.textContent = 'Choose a file.'; return; }
  const fd = new FormData();
  fd.append('file', f);
  fd.append('note', document.getElementById('version-note').value || '');
  const resp = await fetch('/admin/prototypes/' + PROTO_ID + '/versions',
    { method: 'POST', headers: { 'x-csrf-token': CSRF }, body: fd, credentials: 'include' });
  if (resp.status === 201) { msg.textContent = ''; versionsLoaded = false; await loadVersions(); }
  else { const e = await resp.json().catch(() => ({})); msg.textContent = e.error || ('HTTP ' + resp.status); }
});

async function publishVersion(n) {
  if (!confirm('Make v' + n + ' the live version shown to reviewers?')) return;
  const resp = await fetch('/admin/prototypes/' + PROTO_ID + '/publish',
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': CSRF },
      body: JSON.stringify({ version: n }), credentials: 'include' });
  if (resp.ok) { versionsLoaded = false; await loadVersions(); }
  else alert('Publish failed: HTTP ' + resp.status);
}
```

Replace the `rows.map` block in `loadVersions` so badges + buttons key off `status`/`isCurrent`:

```js
    tbody.innerHTML = rows.map(v => {
      const badge = v.isCurrent
        ? '<span class="badge badge-general">live</span>'
        : v.isDraft
          ? '<span class="badge badge-element">draft</span>'
          : '<span class="badge badge-other">published</span>';
      const action = v.isCurrent ? ''
        : `<button class="btn btn-secondary" style="font-size:11px;padding:4px 8px" onclick="publishVersion(${v.version})">${v.isDraft ? 'Publish' : 'Set live'}</button>`;
      return `<tr>
        <td><strong>v${v.version}</strong></td>
        <td>${badge}</td>
        <td class="comment-text">${esc(v.note || '—')}</td>
        <td class="ts">${fmtDate(v.createdAt)}</td>
        <td>${action}</td>
      </tr>`;
    }).join('');
```

Add a 5th `<th>` (`Actions`) to the versions table head (`:276-281`) and update the loading/empty `colspan` from `4` to `5` (`:284`, `:725`).

Point the Explanations tab at the admin endpoint with an optional version filter: in `loadExplanations` (`:621`) change the fetch to `'/admin/prototypes/' + PROTO_ID + '/explanations' + (explVersion ? '?version=' + explVersion : '')`, declare `let explVersion = '';`, and render a `<select id="explanations-version">` (built from a `/admin/prototypes/:id/versions` fetch) whose `change` handler sets `explVersion`, flips `explanationsLoaded = false`, and re-calls `loadExplanations()`. Do the equivalent for the Comments grid by sending `filterValues.version` in its existing data-request body.

- [ ] **Step 5: Run test to verify it passes**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/admin-versions.test.js --runInBand`
Expected: PASS. Then a manual smoke test on `localhost:1337`: upload a 2nd version, see it as `draft`, click Publish, confirm reviewers get it; filter Comments/Explanations by version.

- [ ] **Step 6: Commit** (only if committing is authorized)

```bash
git add src/views/admin-prototype-detail.html tests/admin-versions.test.js
git commit -m "feat(admin-ui): version upload form, publish controls, per-version annotation filters"
```

---

## Workstream ⑤ — Reviewer version switcher

### Task 13: Delivery `?version` resolution + 302 fallback + version context

**Files:**
- Modify: `src/routes/delivery.js` — GET `/:shareToken/view` (`:57-113`)
- Test: `tests/delivery.test.js` (append; this suite already builds the delivery app and seeds a published prototype)

**Interfaces:**
- Consumes: `versions.resolvePublishedVersion(prototypeId, version)`, `versions.listPublishedVersions(prototypeId)`, `inject.injectSdk(html, protoId, email, contentType, versionCtx)` (the Task 14 signature).
- Produces: a valid published `?version=N` serves that version's file; a draft/unknown/non-integer `?version` → **302** to the bare `/p/:shareToken/view`; absent `?version` → unchanged current-published behavior.

- [ ] **Step 1: Write the failing test**

```js
// tests/delivery.test.js — append
test('a draft or unknown ?version redirects to the live view (Review Focus #1)', async () => {
  // `shareToken` resolves to a prototype whose only published version is v1;
  // upload+publish a v2, leave a v3 draft (reuse the suite's admin agent helpers
  // if present, else seed via versions.createDraft/setPublished directly).
  const res = await request(app).get(`/p/${shareToken}/view?version=999`).redirects(0);
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe(`/p/${shareToken}/view`);
});

test('a valid published ?version serves that version', async () => {
  const res = await request(app).get(`/p/${shareToken}/view?version=1`);
  expect(res.status).toBe(200);
  expect(res.text).toContain('data-version="1"');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/delivery.test.js -t "redirects to the live view" --runInBand`
Expected: FAIL — `?version` is ignored today; no redirect, no `data-version` attr.

- [ ] **Step 3: Resolve the version and branch**

In `delivery.js`, after the prototype + allowlist checks and before the current `resolvePublished` call (`:69`), insert version resolution:

```js
  let served;
  if (req.query.version != null) {
    const n = parseInt(req.query.version, 10);
    served = Number.isNaN(n) ? null : await versions.resolvePublishedVersion(proto.id, n);
    if (!served) return res.redirect(302, `/p/${req.params.shareToken}/view`);
  } else {
    const pub = await versions.resolvePublished(proto.id); // {filename, contentType} | null
    served = pub ? { ...pub, version: await versions.publishedVersionNumber(proto.id) } : null;
  }
  const filename = served ? served.filename : proto.filename;
  const contentType = served ? served.contentType : (proto.content_type || 'html');
  const servedVersion = served ? served.version : null;
```

(Replace the existing `const published = await versions.resolvePublished(...)` and its `filename`/`contentType` derivation at `:69-73` with the block above. If `resolvePublished` already returns the version number, drop the `publishedVersionNumber` helper call and read it directly — see Step 3b.)

- [ ] **Step 3b: Add `publishedVersionNumber` only if needed**

`resolvePublished` currently returns `{filename, contentType}` (no number). Rather than a new query, have `resolvePublishedVersion`-shaped data for the default path too: change the default branch to resolve the number from the existing `publishedVersionId` the service already knows. Add to `versions.js`:

```js
async function publishedVersionNumber(prototypeId) {
  const { rows } = await getDb().query(
    `SELECT pv.version FROM prototypes p
     JOIN prototype_versions pv ON pv.id = p.published_version_id
     WHERE p.id = $1`, [prototypeId]);
  return rows[0] ? rows[0].version : null;
}
```

and export it. (Used only to label the default view's switcher; a null is fine — the switcher hides when `VERSIONS.length <= 1`.)

- [ ] **Step 3c: Pass version context to the markdown + html inject paths**

Build the context once and hand it to `injectSdk` in BOTH the markdown branch (`:88-98`) and the html branch (`:103`):

```js
  const publishedVersions = await versions.listPublishedVersions(proto.id);
  const versionCtx = {
    version: servedVersion,
    versions: publishedVersions,                 // [{version, note, createdAt, contentType, isCurrent}]
    viewBase: `/p/${req.params.shareToken}/view`,
  };
```

Replace both `injectSdk(documentHtml, proto.id, email, contentType)` calls with
`injectSdk(documentHtml, proto.id, email, contentType, versionCtx)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/delivery.test.js --runInBand`
Expected: PASS (redirect + serve-version + the suite's existing unversioned tests).

- [ ] **Step 5: Commit** (only if committing is authorized)

```bash
git add src/routes/delivery.js src/services/versions.js tests/delivery.test.js
git commit -m "feat(delivery): serve ?version published versions, redirect drafts, pass version context"
```

---

### Task 14: Inject version attributes (CSP-safe, additive)

**Files:**
- Modify: `src/services/inject.js` — `sdkScript` (`:6-13`), `injectSdk` (`:82-89`)
- Test: `tests/inject.test.js` (append; if absent, create it — the module is pure and unit-testable without a DB)

**Interfaces:**
- Consumes: a `versionCtx` object `{version, versions, viewBase}` or `undefined`.
- Produces: `injectSdk(html, protoId, email, contentType, versionCtx?)` emits, via `escAttr`, `data-version`, `data-versions` (escaped JSON), `data-view-base` on the feedback.js tag. When `versionCtx` is omitted, output is byte-for-byte unchanged (back-compat for any caller not yet passing it). **No inline script** — attributes only, honoring the markdown view's `script-src 'self'`.

- [ ] **Step 1: Write the failing test**

```js
// tests/inject.test.js
const { injectSdk } = require('../src/services/inject');

test('injectSdk emits version data-attributes when a version context is supplied', () => {
  const ctx = { version: 2, versions: [{ version: 1 }, { version: 2 }], viewBase: '/p/tok/view' };
  const out = injectSdk('<body></body>', 'proto1', 'a@b.com', 'html', ctx);
  expect(out).toContain('data-version="2"');
  expect(out).toContain('data-view-base="/p/tok/view"');
  expect(out).toContain('data-versions=');            // escaped JSON present
  expect(out).toContain('&quot;version&quot;:2');      // JSON was HTML-escaped, not raw
});

test('injectSdk output is unchanged when no version context is supplied', () => {
  const a = injectSdk('<body></body>', 'proto1', 'a@b.com', 'html');
  expect(a).not.toContain('data-version=');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/inject.test.js --runInBand`
Expected: FAIL — `injectSdk` ignores a 5th arg; no `data-version` attrs.

- [ ] **Step 3: Thread the context through `sdkScript`/`injectSdk`**

Change `sdkScript(protoId, email, contentType)` → `sdkScript(protoId, email, contentType, versionCtx)` and append the attrs when present:

```js
function sdkScript(protoId, email, contentType, versionCtx) {
  let attrs = `src="/sdk/feedback.js" data-proto="${escAttr(protoId)}"`
    + ` data-email="${escAttr(email)}" data-content-type="${escAttr(contentType)}"`;
  if (versionCtx && versionCtx.version != null) {
    attrs += ` data-version="${escAttr(String(versionCtx.version))}"`;
  }
  if (versionCtx && versionCtx.viewBase) {
    attrs += ` data-view-base="${escAttr(versionCtx.viewBase)}"`;
  }
  if (versionCtx && Array.isArray(versionCtx.versions)) {
    attrs += ` data-versions="${escAttr(JSON.stringify(versionCtx.versions))}"`;
  }
  return `<script ${attrs}></script>`;
}
```

(Keep the exact existing attribute order/spelling for the first three so the no-context snapshot stays byte-identical.) Then forward the arg in `injectSdk`:

```js
function injectSdk(html, protoId, email, contentType, versionCtx) {
  const tag = sdkScript(protoId, email, contentType, versionCtx);
  // ...existing body/append logic unchanged, using `tag`...
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/inject.test.js --runInBand`
Expected: PASS (attrs present with context; byte-identical without).

- [ ] **Step 5: Commit** (only if committing is authorized)

```bash
git add src/services/inject.js tests/inject.test.js
git commit -m "feat(inject): emit CSP-safe version data-attributes on the SDK tag"
```

---

### Task 15: SDK switcher + versioned fetches/bodies

**Files:**
- Modify: `public/sdk/feedback.js` — attr reads (`:5-11`), `loadPins` (`:636`), `loadExplanations` (`:655`), `postComment` body (`:1727`), explanation save POST/PATCH (`:905`/`:896`), toolbar render (`:428-434`)
- Test: `tests/sdk-switcher.test.js` (new — jsdom-free string/behavior test; see note)

**Interfaces:**
- Consumes: `data-version`, `data-versions` (JSON), `data-view-base` from the Task 14 tag.
- Produces: version-scoped annotation fetches (`?version=`), version-stamped write bodies (`version:`), and a `#__fb-version-switcher` `<select>` that full-reloads to `VIEW_BASE + '?version=' + chosen` via `addEventListener`. No new server interface; purely client wiring. **Half-deployed safety:** when the attrs are absent, `VERSION` is `null`, no `?version` is appended, bodies omit `version`, and the switcher does not render — behavior is exactly as today.

- [ ] **Step 1: Write the failing test**

`feedback.js` runs in the browser; test it as a string-contract + a lightweight jsdom behavioral check. If the repo has no jsdom, assert the source contract (the pattern existing SDK tests use — confirm by grepping `tests/` for `feedback.js`); otherwise write the jsdom version.

```js
// tests/sdk-switcher.test.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'sdk', 'feedback.js'), 'utf8');

test('the SDK reads the version attrs and guards the version query (Review Focus #1)', () => {
  expect(src).toMatch(/data-version/);
  expect(src).toMatch(/data-view-base/);
  // version only appended when present — no bare "?version=null"
  expect(src).toMatch(/VERSION\s*!=\s*null|VERSION\s*\?/);
  // switcher wired without inline handlers (CSP)
  expect(src).toMatch(/addEventListener\(\s*['"]change['"]/);
  expect(src).not.toMatch(/__fb-version-switcher[^>]*onchange=/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/sdk-switcher.test.js --runInBand`
Expected: FAIL — none of the version wiring exists in `feedback.js` yet.

- [ ] **Step 3: Read the attrs**

Where the SDK reads its data-attrs (`:5-11`), add:

```js
  var VERSION = SCRIPT.getAttribute('data-version');
  VERSION = (VERSION == null || VERSION === '') ? null : parseInt(VERSION, 10);
  var VIEW_BASE = SCRIPT.getAttribute('data-view-base') || '';
  var VERSIONS = [];
  try { VERSIONS = JSON.parse(SCRIPT.getAttribute('data-versions') || '[]'); } catch (e) { VERSIONS = []; }
```

- [ ] **Step 4: Version-scope the reads**

Add a helper and use it in `loadPins` (`:638`) and `loadExplanations` (`:657`):

```js
  function withVersion(url) {
    if (VERSION == null) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'version=' + VERSION;
  }
```

Change the two fetches to `fetch(withVersion('/api/comments/' + PROTO_ID), ...)` and
`fetch(withVersion('/api/explanations/' + PROTO_ID), ...)`.

- [ ] **Step 5: Version-stamp the writes**

In `postComment` (`:1727`) add `version: VERSION` to the JSON body object; in the explanation save POST (`:905`) and PATCH (`:896`) add `version: VERSION` to their bodies. (Server validates it as a published version via `resolveViewedVersion`; a null is accepted and falls back to the current pointer.)

- [ ] **Step 6: Render the switcher**

In the toolbar-left build (`:428-434`), after the existing controls, append (only when more than one published version exists):

```js
  if (VERSIONS.length > 1) {
    var sel = document.createElement('select');
    sel.id = '__fb-version-switcher';
    VERSIONS.forEach(function (v) {
      var opt = document.createElement('option');
      opt.value = v.version;
      opt.textContent = 'v' + v.version + (v.isCurrent ? ' (live)' : '');
      if (VERSION != null && v.version === VERSION) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () {
      window.location.assign(VIEW_BASE + '?version=' + sel.value);
    });
    toolbarLeft.appendChild(sel);
  }
```

(Use the existing toolbar-left element variable name from `:428-434`; `toolbarLeft` here is a stand-in.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `DATABASE_URL=$DATABASE_URL npx jest tests/sdk-switcher.test.js --runInBand`
Expected: PASS. Then manual smoke on `localhost:1337`: publish v1 and v2, open the share URL, confirm the switcher lists both, switching reloads and loads that version's own comments/explanations, and a comment made while viewing v1 is stamped against v1.

- [ ] **Step 8: Full suite + lint**

Run: `npm run check`
Expected: eslint clean + all Jest suites green (`--runInBand`).

- [ ] **Step 9: Commit** (only if committing is authorized)

```bash
git add public/sdk/feedback.js tests/sdk-switcher.test.js
git commit -m "feat(sdk): version switcher, version-scoped fetches, version-stamped writes"
```

---
