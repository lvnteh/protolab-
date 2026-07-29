# Local-AI ↔ Deployed-Prototype Integration

**Date:** 2026-07-29
**Status:** Approved — Phase 1 (REST + versioning), Phase 2 (MCP + manifest), and Phase 3 (comment resolution + token/version UI) all shipped.

---

## Summary

A local development agent (Claude Code running in the prototype's repo) can, over the public internet, **pull** the feedback a deployed prototype has received — comments, replies, and the author's own element explanations — improve the prototype's HTML locally, and **push** the updated HTML back as a new version. Pushes land as **drafts**; the public share link keeps serving the last **published** version until the author explicitly publishes. The prototype's identity and share link never change across versions, so reviewers always use the same URL and old comments stay attached.

The system is three layers, each independently shippable:

1. **REST** — token-authenticated `/api/v1/*` endpoints on the deployed app. The single source of truth; the only layer that touches the DB and storage.
2. **MCP** — a local stdio MCP server (ships in this repo, runs on the developer's machine) that wraps the REST layer so the agent gets native tools instead of curl calls.
3. **Local manifest** — a tracked `.protoshare.json` mapping local HTML file → prototype id, plus the last-pulled/last-pushed version, acting like a "git remote" for the link.

Analytics (nav/funnel/access logs) are explicitly **out of scope** for the feedback payload.

---

## 1. Database

Two new tables, three added columns, one backfill. All applied via idempotent `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in `initDb()`, matching the existing multi-tenancy and threaded-replies migration pattern (safe on every Railway/Supabase restart).

### New table: `api_tokens`

```sql
CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,            -- bcrypt hash of the raw token
  name         TEXT NOT NULL,            -- human label, e.g. "laptop-dev"
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
```

- The raw token is shown **once** at generation and never stored — only its bcrypt hash. Mirrors the `password_hash` handling in `users`.
- A token maps to exactly one `user_id`; all `/api/v1` ownership scoping reuses this id via the existing `owner_id` filtering.
- Revocation = deleting the row.

### New table: `prototype_versions`

```sql
CREATE TABLE IF NOT EXISTS prototype_versions (
  id            TEXT PRIMARY KEY,
  prototype_id  TEXT NOT NULL REFERENCES prototypes(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,        -- 1,2,3… monotonic per prototype
  filename      TEXT NOT NULL,           -- storage key (e.g. "<versionId>.html")
  status        TEXT NOT NULL CHECK (status IN ('draft','published')),
  note          TEXT,                    -- optional push message
  created_at    TEXT NOT NULL,
  UNIQUE (prototype_id, version)
);
CREATE INDEX IF NOT EXISTS idx_versions_proto ON prototype_versions(prototype_id, version);
```

### Added columns: `prototypes`

```sql
ALTER TABLE prototypes ADD COLUMN IF NOT EXISTS published_version_id TEXT REFERENCES prototype_versions(id);
ALTER TABLE prototypes ADD COLUMN IF NOT EXISTS draft_version_id     TEXT REFERENCES prototype_versions(id);
```

- `published_version_id` — the version the share link (`/p/:token`) serves. Never advanced by a push; only by publish.
- `draft_version_id` — the latest unpublished push (nullable; cleared or advanced on each push, set to the published row on publish).

### Added column: `comments`

```sql
ALTER TABLE comments ADD COLUMN IF NOT EXISTS version_id TEXT REFERENCES prototype_versions(id);
```

- Stamped at comment-insert time with the prototype's **currently published** `version_id`, so the agent can distinguish fresh feedback (on the live version) from feedback already addressed in a later version.

### Backfill (in `initDb()`, after the tables exist)

For every prototype with no version rows: create a `prototype_versions` row `version = 1`, `status = 'published'`, `filename = prototypes.filename` (the existing file), and set `published_version_id` to it. This turns the current single-file model into "version 1, published" with no data movement — the storage key is unchanged. Existing comments have `version_id = NULL` (treated as "against v1") until stamped going forward; a one-time `UPDATE comments SET version_id = <v1 id> WHERE prototype_id = … AND version_id IS NULL` sets them explicitly.

`prototypes.filename` is retained (points at the v1 file) for backward compatibility but is no longer the delivery source of truth — `published_version_id → filename` is.

---

## 2. REST API (Layer 1)

All routes are under `/api/v1`, authenticated with `Authorization: Bearer <token>`, and owner-scoped: the token resolves to a `user_id`, every query filters by `owner_id`, and a prototype that isn't yours returns `404` (reusing the existing cross-tenant-as-404 guarantee). Errors use the existing `{ "error": "..." }` JSON envelope.

### Auth middleware: `apiTokenAuth`

New middleware (sibling to `adminAuth`). Extracts the bearer token, looks up all of the caller's candidate token rows, `bcrypt.compare`s against each `token_hash`, and on match sets `req.userId` and updates `last_used_at`. No match → `401`. This is the machine-facing equivalent of the session-cookie `adminAuth`; the two never mix.

### `GET /api/v1/prototypes`

Lists the caller's prototypes.

```json
[
  { "id": "aB3x…", "name": "Checkout flow", "shareLink": "https://…/p/tok…",
    "publishedVersion": 2, "draftVersion": 3 }
]
```

### `GET /api/v1/prototypes/:id/feedback`

The pull payload — one request returns everything the agent needs.

```jsonc
{
  "prototype": { "id": "aB3x…", "name": "Checkout flow",
                 "publishedVersion": 2, "draftVersion": 3 },
  "comments": [
    {
      "id": "c1", "type": "element", "tag": "bug",
      "comment": "Total doesn't update when qty changes",
      "email": "alice@sap.com",
      "element": { "selector": ".cart-total", "label": "Order total" },
      "pageUrl": "/cart", "createdAt": "2026-07-20T…",
      "madeAgainstVersion": 2,          // derived from comments.version_id
      "resolved": false,                // see §5 (Phase 3); false pre-Phase-3
      "replies": [
        { "email": "bob@sap.com", "comment": "Confirmed", "createdAt": "…" }
      ]
    }
  ],
  "explanations": [
    { "elementSelector": ".cart-total", "pageUrl": "/cart",
      "body": "Recomputes from line items on qty change" }
  ]
}
```

`madeAgainstVersion` is the `version` integer for the comment's `version_id` (or 1 when null). Explanations are included whole so the agent understands intended behaviour of an element before changing it.

### `GET /api/v1/prototypes/:id/versions`

Version history: `[{ version, status, note, createdAt }]`, newest first, with which is published/draft.

### `GET /api/v1/prototypes/:id/source`

Returns the current **published** HTML as `text/html`. Optional `?version=N` returns that specific version's HTML (owner-scoped). Used by the agent to pull the live copy down to edit when the local file is stale.

### `POST /api/v1/prototypes/:id/versions`  → creates a DRAFT

- Body: `multipart/form-data` with the `.html` file (reuses the existing multer `memoryStorage` + `.html` `fileFilter`) and an optional `note`, plus a `baseVersion` integer (the version the edit was based on — for conflict detection).
- Behaviour: allocates the next `version` number, writes the file to storage under a new key (`<versionId>.html`) via `storage.putPrototype`, inserts a `prototype_versions` row with `status = 'draft'`, sets `prototypes.draft_version_id`. **Does not touch `published_version_id`** — reviewers are unaffected.
- **Conflict guard:** if `baseVersion` is not the current latest version, respond `409 Conflict` with `{ error, currentVersion }` so the agent can `GET …/source` to re-sync before retrying.
- Response: `201 { "version": 3, "status": "draft" }`.

### `POST /api/v1/prototypes/:id/publish`  → promotes a draft

- Body: `{ "version": N }` (defaults to the latest draft).
- Sets `published_version_id` to that version's row, flips its `status` to `'published'`, clears `draft_version_id` if it pointed there. The share link now serves it.
- Errors: `409` if the version doesn't exist or is already published.

No changes to the existing session-cookie `/admin/*` or public `/api/*` routes — this is an additive, parallel surface.

### Delivery path change

`/p/:token` (delivery.js) and the admin preview resolve the file via `published_version_id → prototype_versions.filename` instead of `prototypes.filename`. One-line change per read site; drafts are never served publicly.

---

## 3. MCP server (Layer 2)

A stdio MCP server shipped in this repo (e.g. `mcp/protoshare-server.js`), run locally by the developer and registered with Claude Code. It is a **thin client** — no business logic; every rule lives in Layer 1. It reads the remote base URL from `.protoshare.json` and the token from the environment (`PROTOSHARE_TOKEN` in a git-ignored `.env`).

Tools:

| Tool | Wraps | Purpose |
|------|-------|---------|
| `protoshare_list()` | `GET /prototypes` | List the developer's prototypes |
| `protoshare_pull(file_or_id)` | `GET …/feedback` | Feedback payload; resolves file→id via manifest |
| `protoshare_source(file_or_id, version?)` | `GET …/source` | Pull live HTML down to edit |
| `protoshare_push(file, note?)` | `POST …/versions` | Upload local file as a draft (sends `baseVersion` from manifest) |
| `protoshare_publish(file_or_id, version?)` | `POST …/publish` | Promote a draft to live |
| `protoshare_status(file_or_id)` | `GET …/versions` | Local (manifest) vs remote version summary |

After a successful pull/push the server updates the manifest's `lastPulled`/`lastPushed` for that file.

---

## 4. Local manifest (Layer 3)

A tracked file at repo root:

```jsonc
{
  "remote": "https://protolab.up.railway.app",
  "prototypes": {
    "checkout.html": { "id": "aB3x…", "lastPulled": 2, "lastPushed": 3 }
  }
}
```

- Maps local HTML file → prototype id and records last-pulled/last-pushed versions (the `baseVersion` source for conflict detection).
- The token is **never** in the manifest — it lives in `.env` (git-ignored). The manifest is safe to commit.

---

## 5. Comment resolution (Phase 3)

To make "address the feedback" an iterative loop rather than a one-shot dump, comments gain resolution state:

```sql
ALTER TABLE comments ADD COLUMN IF NOT EXISTS resolved_at   TEXT;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS resolved_in_version INTEGER;
```

- New endpoint `POST /api/v1/prototypes/:id/comments/:commentId/resolve` (owner-scoped) sets `resolved_at` and `resolved_in_version` to the version that addressed it.
- The feedback payload's `resolved` boolean derives from `resolved_at`. Before Phase 3 ships, `resolved` is always `false`.
- After pushing a fix, the agent marks the addressed comments resolved-in-vN, so the next `protoshare_pull` surfaces only genuinely open feedback.

---

## 6. Error handling

| Condition | Status |
|-----------|--------|
| Missing / malformed / revoked bearer token | `401` |
| Token valid but prototype not owned by caller | `404` (cross-tenant-as-404) |
| Push non-`.html` or oversized file | `400` (multer `fileFilter`) |
| Push whose `baseVersion` ≠ current latest (stale) | `409` + `currentVersion` |
| Publish a nonexistent / already-published version | `409` |
| Any handler exception | `500` + `{ error }` (matches existing routes) |

---

## 7. Files changed / added

| File | Change |
|------|--------|
| `src/db.js` | New `api_tokens`, `prototype_versions` tables; `published_version_id`/`draft_version_id` on `prototypes`; `version_id` on `comments`; v1 backfill |
| `src/middleware/apiTokenAuth.js` | **New** — bearer-token auth resolving to `user_id`, updates `last_used_at` |
| `src/routes/apiV1.js` | **New** — all `/api/v1/*` endpoints (list, feedback, versions, source, push-draft, publish) |
| `src/routes/admin.js` | Token-management endpoints (generate/list/revoke); comment insert stamps `version_id` |
| `src/routes/delivery.js` | Resolve file via `published_version_id` not `prototypes.filename` |
| `src/routes/api.js` | Public comment insert stamps `version_id` (published version) |
| `src/server.js` | Mount `/api/v1` router |
| `src/views/admin-prototype-detail.html` | "API Tokens" panel (generate once / list / revoke); version history display |
| `mcp/protoshare-server.js` | **New** — stdio MCP server wrapping Layer 1 |
| `.protoshare.json` | **New** — local manifest (tracked); token stays in `.env` |
| `.env.example` | Document `PROTOSHARE_TOKEN` |
| `docs/spec/protolab-specification.md` | Add API-v1, versioning, and token sections |

---

## 8. Testing

Extends the existing `supertest` + Jest setup; DB-backed suites stay `hasDb`-gated and mock `src/services/storage` with the in-memory Map pattern already in `tenancy.test.js`.

| Suite | Covers |
|-------|--------|
| `tests/apitoken.test.js` | Generate → authenticate → revoke; revoked token → 401; wrong-user token can't reach another's prototype (404) |
| `tests/versions.test.js` | Push creates a draft; publish promotes; share link serves published not draft; v1 backfill from legacy `filename` |
| `tests/feedback-api.test.js` | Payload shape; owner-scoping (cross-tenant → 404); `madeAgainstVersion` correctness; explanations included |
| `tests/conflict.test.js` | Stale `baseVersion` push → 409 with `currentVersion` |
| `tests/mcp.test.js` | MCP tools call the right endpoints (REST layer mocked) |

---

## 9. Build order

- **Phase 1 — REST + versioning.** Tokens, `/api/v1/*`, draft/publish, delivery via published version, v1 backfill. The full loop works via curl. Ships value alone.
- **Phase 2 — MCP + manifest.** Local MCP server and `.protoshare.json`. The loop works by just asking the agent ("pull the feedback and fix the bugs").
- **Phase 3 — Feedback workflow.** Comment resolution + token-management UI polish. Turns "fetch comments" into an iterative, converging loop.

---

## 10. Out of scope

- Analytics (nav events, funnel, access log) in the feedback payload — pull is comments + replies + explanations only.
- Branching/merging of versions — history is linear (v1 → v2 → v3).
- Multi-file prototypes — one HTML document per prototype (unchanged).
- Real-time push notifications — the agent pulls on demand.
- Auto-publish on push — every push is a draft; publish is always explicit.
