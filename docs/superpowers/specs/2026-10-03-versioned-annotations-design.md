# Versioned Annotations + Admin Version Upload/Publish + Reviewer Version Switcher

**Date:** 2026-10-03
**Status:** Design — approved for planning
**Project:** proto-share (Express 5 + Postgres, CommonJS, Node 22)

## Purpose

Today a prototype can hold multiple versions, but a new version can only be
uploaded through the machine-facing REST API — the admin web UI can only create
brand-new prototypes, and reviewers only ever see the single published version.
This feature closes that gap:

1. **Upload a new version from the admin Versions tab** (for both HTML and
   markdown prototypes), as a numbered draft on top of the version list.
2. **Explicitly choose which version is published** (live), including switching
   back to an older previously-published version.
3. **Let reviewers switch among previously-published versions** on the same share
   URL to see how a prototype evolved — drafts are never reviewer-visible.
4. **Keep comments and explanations per version**, each version starting clean —
   no annotation is ever inherited or re-mapped across versions.

Delivering (4) correctly requires first **unifying comments and explanations**
behind one shared mechanism, because explanations are not version-scoped today.

### Who it is for / success criteria

- **Admins** (prototype owners) can iterate a prototype through versions and
  control what reviewers see, from the browser, without the API.
- **Reviewers** always land on the live version at the unchanged share URL, and
  can browse earlier published versions, each with its own feedback.
- Success = a version can be uploaded, selected as live, and reviewed — with
  comments/explanations that stay bound to the exact version they were made on.

## Locked decisions

| # | Decision |
|---|----------|
| 1 | **Unify first.** One shared logic module (`src/services/annotations.js`); keep the two tables; add `version_id` to `explanations`. Both kinds become version-scoped. Threading/resolve stay comment-only; upsert/edit-in-place stay explanation-only. |
| 2 | Each upload = a **new permanent numbered `draft`**, appended on top. **Multiple drafts coexist** (full linear history). Content-type **locked** to the prototype's existing type. |
| 3 | **Publishing is the only go-live path** (no admin preview). Admin selects which version is published; selecting may re-point to any already-published version. |
| 4 | `status` is authoritative: `'draft'` = admin-only, never reviewer-visible; `'published'` = **sticky** = reviewer-visible/switchable. `prototypes.published_version_id` = the current live/default version. |
| 5 | Reviewer version switcher serves a chosen **published** version via `?version=N` on the **same share URL**; default = current live version; each version loads **its own** comments + explanations. |
| 6 | **Anchors are version-exact** (selectors, x/y, text ranges) and break when content changes; annotations are **never inherited or re-mapped** across versions. |
| 7 | **Legacy data: Option A — CLEAR.** Existing prototype-scoped explanations (no `version_id`) are deleted by the migration; every version starts clean. (Destructive, accepted.) |

## Operational constraints

- **No auto-commit / no push.** This spec is written but not committed unless the
  user asks (per workspace memory `no-auto-commit` / `no-github-push`).
- Follow existing patterns: multer upload (`admin.js:174`), the `versions`
  service, `FBAnchor` anchoring (`public/sdk/anchor.js`), `orgs.requireAdmin`
  guard, the existing `23505 → 409 CONFLICT` concurrency handling.
- Migrations run in `initDb()` under the existing advisory lock
  (`BACKFILL_LOCK_KEY`), marker-guarded in `schema_migrations`.

---

## Workstream ① — Unify + version-scope annotations (prerequisite)

### Schema (`src/db.js`, inside `initDb()`)

1. `ALTER TABLE explanations ADD COLUMN IF NOT EXISTS version_id TEXT REFERENCES prototype_versions(id)`
   — mirrors `comments.version_id` (`db.js:223`).
2. Drop and recreate the unique index with version in scope, using
   `COALESCE(version_id,'')` so NULL rows de-dupe deterministically and the
   `23505 → 409` upsert contract (`api.js:234-235`) is preserved:
   `UNIQUE(prototype_id, element_selector, COALESCE(page_url,''), COALESCE(version_id,''))`.
   *(COALESCE, not bare `version_id` NULL-distinct — resolves the designer
   disagreement the critic flagged; NULL-distinct would let two NULL-version rows
   on the same selector both insert, breaking edit-in-place.)*
3. `CREATE INDEX idx_explanations_version ON explanations(prototype_id, version_id)`.
4. In the section-L FK-cleanup `DO` block: add
   `UPDATE explanations SET version_id = NULL WHERE version_id IS NOT NULL AND version_id NOT IN (SELECT id FROM prototype_versions)`
   then add the FK constraint `ON DELETE SET NULL` (mirrors `db.js:337-340`).

**Ordering is load-bearing:** DDL (column + indexes) runs before the section-L FK
re-add; the data migration (below) runs **after** the `v1-version-backfill` block,
inside the same advisory lock.

### Legacy data migration — Option A (CLEAR)

```sql
DELETE FROM explanations WHERE version_id IS NULL;
```

Record marker `explanations-version-scope-v1`. Guard the re-run probe with the
marker so a second boot is a no-op. (Comments were already backfilled to v1 at
`db.js:418-421`; after this, every pre-existing prototype-scoped explanation is
gone and all future explanations are version-stamped.)

### Shared module (`src/services/annotations.js`, new)

Exports:

- `resolveViewedVersion(req, prototypeId)` → `{ versionId }` — **the single
  resolver used by BOTH read and write paths.** Validates a requested
  `version` (query/body) is a `status='published'` version **of this prototype**;
  otherwise falls back to `prototypes.published_version_id`. Drafts and
  cross-prototype versions are rejected → a reviewer can never read or stamp a
  draft (decision 4). Returns `null` versionId only when the prototype has no
  published version.
- `listComments(prototypeId, versionId)` / `listExplanations(prototypeId, versionId)`
  — reads filtered by version (`version_id = $2`). Replaces the current
  prototype-id-only reads (`api.js:132-144`, `api.js:201-213`).
- `createComment(prototypeId, versionId, fields)` / `createExplanation(...)` —
  shared inserts that stamp `version_id`. **The reply branch (`api.js:75-80`)
  now stamps the parent's version** (fixes the NULL-reply bug below). Explanation
  insert preserves the `23505 → 409` upsert signal.
- `updateComment/deleteComment`, `updateExplanation/deleteExplanation` — thin,
  unchanged semantics.
- `serializeAnchorCols(type, anchor)` / `anchorFromRow(row)` — lift the inline
  range-anchor logic (`api.js:87-99`, `apiV1.js:86-92`).

**No-published-version guard:** when `resolveViewedVersion` yields `null`
versionId, create* rejects (400/409) rather than writing an invisible NULL-version
row.

### Route rewrites (`src/routes/api.js`)

All 8 comment/explanation handlers delegate to `annotations.js`:

- `POST /comments` (`:55`) → `resolveViewedVersion` + `createComment` (removes the
  inline anchor block and the direct `publishedVersionId` stamp at `:101`).
- `GET /comments/:prototypeId` (`:132`) → `listComments(prototypeId, versionId)`,
  resolving the viewed version from `?version`; keeps the parent/reply shaping.
- `POST /explanations` (`:215`) → now stamps `version_id` (fixes the missing-stamp
  bug) via `resolveViewedVersion` + `createExplanation`.
- `GET /explanations/:prototypeId` (`:201`) → `listExplanations(...)`,
  version-filtered, accepts `?version=N`.
- `PATCH`/`DELETE` for both keep `authorizeResource` (`api.js:43`) unchanged.

### Reply backfill (critical — prevents data loss)

Existing replies (`api.js:75-80`) carry `NULL version_id`. Once reads filter by
version, those replies vanish from their threads. The migration must backfill:

```sql
UPDATE comments c SET version_id = p.version_id
FROM comments p
WHERE c.parent_id = p.id AND c.version_id IS NULL AND p.version_id IS NOT NULL;
```

Land this **before** `GET /api/comments` starts filtering by version.

### Machine reader parity (`src/routes/apiV1.js`)

`GET /prototypes/:id/feedback` (`:56`) keeps returning all versions, but the
explanations query (`:100-102`) must select `version_id` and surface
`madeAgainstVersion` per explanation (parity with comments' `madeAgainstVersion`
at `apiV1.js:94`), and use `annotations.anchorFromRow` for comment anchors.

---

## Workstream ② — Version / publish service (`src/services/versions.js`)

No DDL. Reinterprets existing columns: `status` is authoritative; `draft_version_id`
degrades to "newest draft" convenience and must **not** drive admin/reviewer lists.

**Add (keep existing functions intact):**

- `setPublished(prototypeId, version)` → `{ version, status:'published', promoted, publishedVersionId }`.
  - Not found → throw `{code:'CONFLICT'}` ("Version not found.").
  - `status==='draft'` → promote (flip to published, set `published_version_id`,
    clear `draft_version_id` only if it equaled this row); `promoted=true`.
  - `status==='published'` → **re-point only** `published_version_id` (status
    stays sticky); `promoted=false`; idempotent no-op if already current.
  - Wrap in `BEGIN/COMMIT` with `SELECT 1 FROM prototypes WHERE id=$1 FOR UPDATE`
    to serialize concurrent publishes.
- `listPublishedVersions(prototypeId)` → `[{ version, note, createdAt, contentType, isCurrent }]`,
  `WHERE status='published'`, newest-first. The reviewer switcher's option list.
- `listAllVersions(prototypeId)` → `[{ version, status, note, createdAt, contentType, isCurrent, isDraft }]`,
  newest-first. `isDraft = status==='draft'` (status-based — flags **all**
  coexisting drafts, unlike the pointer-based `admin.js:427`).
- `resolvePublishedVersion(prototypeId, version)` → `{ id, version, filename, contentType } | null`,
  `WHERE status='published'`. Returns `null` for a draft/unknown/cross-prototype
  version. Guarantees drafts are never reviewer-renderable.

**Keep `publish()` unchanged** — the machine/CLI endpoint (`apiV1.js:196`) and
`tests/conflict.test.js:86-90` rely on its 409-on-already-published. Only the new
admin publish route calls `setPublished`. *(This resolves the alias-vs-separate
contradiction the critic found: do NOT alias `publish` to `setPublished`.)*

`resolved_in_version` is untouched by publish operations.

---

## Workstream ③ — Admin upload + publish UI

### Routes (`src/routes/admin.js`, both `orgs.requireAdmin` + CSRF)

- **`POST /admin/prototypes/:id/versions`** — `upload.single('file')`, modeled on
  `apiV1.js:159` / `admin.js:174`:
  - Load proto for its `content_type` (404 on miss/cross-org).
  - 400 if no file.
  - **Lock content-type:** compute `filetype.contentTypeForFilename(originalname)`;
    400 if it ≠ `proto.content_type`.
  - Store under a locked extension; `versions.createDraft(id, filename, note, proto.content_type)`.
  - `23505` → best-effort delete the stored file, 409 `{error, currentVersion}`.
  - 201 `{ id, version, status:'draft' }`.
- **`POST /admin/prototypes/:id/publish`** — JSON `{version:N}`; `parseInt`, 400 if
  NaN; `versions.setPublished(id, version)`; `CONFLICT` → 409; else 200
  `{ version, status:'published' }`.
- `GET /prototypes/:id` (`:224`) renderView vars: inject `contentType` (for the
  file-input `accept`) alongside the existing `orgRole`.
- `POST /prototypes/:id/comments` (`:271`) honors an optional `filterValues.version`.

### View (`src/views/admin-prototype-detail.html`, Versions tab `:271-288`)

- Admin-only upload form (rendered when `orgRole==='admin'`): file input with
  `accept` locked to the prototype's type, optional note, "Upload new version"
  button → `fetch` FormData with `x-csrf-token` (no explicit Content-Type);
  on 201 reload the versions list; on 400/409 show inline error.
- `loadVersions` (`:716-745`) renders badges off `status` (not the unreliable
  `isDraft` pointer): **live** (current) / Published (set-live button) / Draft
  (publish button). Buttons call `publishVersion(n)` → `POST .../publish`, with a
  confirm step (set-live is instantly visible to reviewers).
- Comments **and** Explanations tabs gain a per-version `<select>` (All versions +
  one per version) so version-scoping doesn't silently hide older annotations.
  Ship both; the explanations filter depends on `?version=N` from ① landing.

### Also lock the machine upload path

`apiV1.js:159` currently derives `content_type` from the uploaded file. Add the
same content-type lock there, or mixed-type histories leak in out-of-band
(decision 2 must hold globally).

---

## Workstream ④ — Reviewer version switcher

### Delivery (`src/routes/delivery.js`, `GET /p/:shareToken/view` `:57-113`)

- Parse `?version=N`. Absent → current behavior (`resolvePublished`, `:69`).
  Present → `versions.resolvePublishedVersion(proto.id, N)`:
  - Valid published version of this prototype → serve its `{filename, contentType}`
    (drives the raw read, the markdown/CSP branch, and `injectSdk`).
  - `null` (draft/unknown/other prototype/non-integer) → **302 redirect** to the
    bare `/p/:shareToken/view` (clean fallback, preserves "same share URL").
- Fetch `listPublishedVersions(proto.id)` and pass the version context to `injectSdk`.

### Inject (`src/services/inject.js`)

Extend `sdkScript`/`injectSdk` to emit (via `escAttr`) on the feedback.js tag:
`data-version-id`, `data-version` (integer), `data-versions`
(escaped JSON of published versions), `data-view-base` (the `/p/:shareToken/view`
path). **No inline script** — attributes only, to stay within the markdown view's
`script-src 'self'` CSP. When no version context is supplied, behavior is
byte-for-byte as today (attrs absent → unversioned fetches).

### SDK (`public/sdk/feedback.js`)

- Read `VERSION`, `VERSIONS`, `VIEW_BASE` from the new attrs.
- Append `?version=VERSION` to `loadPins` (`:638`) and `loadExplanations` (`:657`)
  so each served version loads its own annotation set.
- Include `version:VERSION` in `postComment` (`:1727`) and the explanation save
  (`:905`) bodies so an annotation made while viewing an older version is stamped
  against the **viewed** version (validated server-side as published).
- Render a `#__fb-version-switcher` `<select>` in `#__fb-toolbar-left`, preselected
  to `VERSION`, wired via `addEventListener` (not inline `onchange`) to
  `location.assign(VIEW_BASE + '?version=' + chosen)`. Build the URL from
  `data-view-base` (server-authoritative), never from mutable `location.search`.
  Hide/disable when `VERSIONS.length <= 1`. **Switching is a full reload** (the
  document and its anchors differ per version).

### Stale admin preview route

`GET /admin/prototypes/:id/preview` (`admin.js:356-391`) serves the legacy
top-level file + prototype-id-only comments, contradicting decision 3 and showing
stale content. **Re-scope it to the current published version with
version-filtered comments** (preferred) — or remove it. To be confirmed in planning
if removal is preferred.

---

## Cross-cutting correctness contracts

- **One shared resolver** (`resolveViewedVersion`) enforces `status='published'` +
  prototype match for **both** the write-stamp and the `?version` read — a crafted
  `version` param can neither read nor seed a draft's annotation set.
- **Write-stamp and read-filter must land together.** If `GET` filters by version
  before `POST` stops stamping the current pointer, annotations on switched
  versions mis-file and never reappear.
- **Half-deployed SDK** sends no `version` → server falls back to the current
  published version (unchanged behavior). The switcher is purely additive.

## Edge cases

- Switch back to an older published version after a newer one went live →
  `setPublished` re-points; 200 (not 409).
- Multiple coexisting drafts → all show `status='draft'`; `draft_version_id`
  (newest only) is not used for rendering.
- `published_version_id IS NULL` (published version deleted via SET NULL, or
  draft-only prototype) → `resolvePublished` returns null; delivery falls back to
  `proto.filename`; annotation writes are rejected (no-published-version guard).
- Wrong content-type upload (`.md` onto an html prototype) → 400 before storage.
- Reviewer requests `?version=<draft>` → rejected → redirect to live.
- `resolve_in_version` is cross-version by nature; reviewer `GET /api/comments`
  does not select `resolved_at`, so only machine/admin surfaces see resolve state —
  acceptable, no reconciliation needed.

## Risks

- Dropping/recreating `idx_explanations_unique` is two non-atomic statements; runs
  at boot before traffic — acceptable, note it.
- `setPublished` re-point is live-traffic-visible with no undo → confirm modal in
  the admin UI.
- multer `memoryStorage` buffers the whole upload (existing exposure, unchanged).
- `access_log` has no version column → version-level view analytics is **out of
  scope**; noted for later.

## Sequencing (merge order)

1. Schema: `explanations.version_id` + indexes + FK cleanup; reply backfill;
   legacy clear migration (Option A). *(All in `db.js` under the advisory lock.)*
2. `annotations.js` + `api.js` rewrite (reads filter by version; writes stamp
   viewed version); `apiV1` explanations parity.
3. `versions.setPublished` + `listPublishedVersions` + `listAllVersions` +
   `resolvePublishedVersion`.
4. Admin routes + Versions-tab UI + version selectors; machine-upload content-type
   lock.
5. `delivery.js` `?version` + `inject.js` attributes + `feedback.js` switcher.

## Testing

- `versions.test.js`: `setPublished` promotes a draft; re-points to an older
  already-published version (the switch-back that `publish()` blocks today);
  `listPublishedVersions` excludes drafts; `listAllVersions` flags every draft.
- `conflict.test.js`: unchanged — `publish()` still 409s on already-published
  (machine contract preserved).
- New: content-type lock rejects a mismatched upload (admin **and** `apiV1`);
  reviewer `?version` rejects drafts; annotations read/write are version-scoped;
  reply backfill keeps existing threads intact; legacy explanations are cleared.
- `npm run check` (lint + jest, `--runInBand`) green.

## Out of scope

- Version deletion/renaming from the UI.
- Per-version view analytics (`access_log` version column).
- Any "unpublish" state (sticky `published` is intentional; no new status value).
- Merging the comments/explanations tables (decision 1 keeps them separate).
