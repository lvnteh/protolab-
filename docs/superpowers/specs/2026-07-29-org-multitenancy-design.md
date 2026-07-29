# Organization Multi-Tenancy — Design

**Date:** 2026-07-29
**Status:** Approved (design decisions locked via product Q&A 2026-07-29)

## Goal

Move the tenancy boundary from the individual **user** (`prototypes.owner_id`) to
an **organization**. Users belong to one or more orgs; a prototype belongs to an
org; access is decided by the caller's membership + role in that org — not by
personal ownership.

## Locked decisions

| Decision | Choice | Notes |
|----------|--------|-------|
| Membership | **Multi-org** | A user can belong to N orgs via `org_memberships`. Session holds an `activeOrgId`. |
| Org creation | **Admin-provisioned (now)** | Orgs + memberships are created by a super-admin seed/CLI. Self-serve signup-creates-org is a *future* plan: `docs/superpowers/plans/2026-07-29-future-self-serve-org-signup.md`. |
| Roles (now) | **admin + viewer** | `admin` = full control of prototypes + org (members, tokens, settings). `viewer` = read org prototypes/feedback/analytics + add comments; cannot create/edit/delete/publish prototypes or manage the org. Owner/Member split is a *future* plan: `docs/superpowers/plans/2026-07-29-future-owner-member-roles.md`. |
| Migration | **All existing data → one shared org** | A single `Default Organization` is created; every existing prototype gets its `org_id`; every existing user becomes an `admin` member. |

## Terminology — two distinct "viewer"-like actors

To avoid confusion, the system now has two unrelated read/comment actors:

1. **Share-link reviewer** (unchanged) — accountless, gated by `allowlist` +
   email session (`req.session.customerEmail` / `prototypeId`). Views a single
   shared prototype and leaves feedback via the injected SDK. **Not** an org
   member. Untouched by this work except that the P0 fix already scopes their
   `/api` calls to their one prototype.
2. **Org `viewer`** (new) — a real account (`users` row) that is a member of an
   org with role `viewer`. Sees *all* of that org's prototypes in the admin UI
   read-only, and may add comments. This is an internal-collaborator role.

## Data model

### New tables

```sql
CREATE TABLE organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE org_memberships (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('admin','viewer')),
  created_at  TEXT NOT NULL,
  UNIQUE (org_id, user_id)              -- one membership per (org,user)
);
CREATE INDEX idx_memberships_user ON org_memberships(user_id);
CREATE INDEX idx_memberships_org  ON org_memberships(org_id);
```

### Altered tables

```sql
-- The tenant boundary. Nullable at first (existing rows), backfilled by
-- migration, enforced in code (mirrors the existing owner_id pattern).
ALTER TABLE prototypes ADD COLUMN org_id TEXT REFERENCES organizations(id);
CREATE INDEX idx_prototypes_org ON prototypes(org_id, created_at DESC);

-- Also index owner_id (was unindexed — table-scan on every admin list).
CREATE INDEX idx_prototypes_owner ON prototypes(owner_id);

-- api_tokens gain an org scope: a token acts within one org.
ALTER TABLE api_tokens ADD COLUMN org_id TEXT REFERENCES organizations(id);
```

**Why org_id lives only on `prototypes` (and `api_tokens`), not on comments /
explanations / access_log / nav_events:** those tables already FK to
`prototypes(id)` and inherit tenancy transitively. Scoping them by joining to
`prototypes.org_id` keeps a single source of truth and avoids denormalization
drift. Indexes on `comments(prototype_id)` etc. are added for scale (see below).

### Scale indexes (previously missing — full-table-scan risk)

```sql
CREATE INDEX idx_comments_prototype   ON comments(prototype_id);
CREATE INDEX idx_access_log_prototype ON access_log(prototype_id);
```

## Migration (idempotent, advisory-locked, marker-guarded)

Runs inside `initDb()`, guarded like the existing v1 backfill:

1. `INSERT` a single `Default Organization` if the marker
   `org-multitenancy-v1` is absent.
2. Add **every** existing user as an `admin` member of it (ON CONFLICT DO NOTHING).
3. `UPDATE prototypes SET org_id = <default> WHERE org_id IS NULL`.
4. `UPDATE api_tokens SET org_id = <default> WHERE org_id IS NULL`.
5. Record marker `org-multitenancy-v1` in `schema_migrations`.

Existing single-user semantics are preserved: each old user is an admin of the
one shared org and still sees the prototypes they created (plus everyone else's
in that org — which is the intended "one shared org" behavior).

## Authorization model

Session gains `req.session.activeOrgId`, set at login/signup to the user's first
membership (most-recently-created if several). A future org-switcher can update
it; for now each user typically has one.

New helper module `src/services/orgs.js`:

- `membership(userId, orgId)` → `{ role } | null`
- `activeMembership(req)` → resolves `req.session.userId` + `req.session.activeOrgId`
- `requireOrg(req)` middleware → 401 if no `userId`, 403 if no membership in
  `activeOrgId`; sets `req.orgId` + `req.orgRole`.
- `requireAdmin(req)` → `requireOrg` + 403 unless `role === 'admin'`.

Prototype access changes from **owner-scoped** to **org-scoped**:

```
getOwnedPrototype(id, ownerId)   →   getOrgPrototype(id, orgId)
  SELECT ... WHERE id = $1 AND org_id = $2
```

- **Read** routes (list, detail, feedback, versions, analytics, preview): allowed
  for any member (`admin` or `viewer`) of the prototype's org.
- **Write** routes (upload, settings, delete, publish, push draft, token mgmt,
  comment delete): `admin` only.
- **Comment create** (org viewer leaving feedback): allowed for `viewer` too.

`apiV1.js` (token surface): a token now carries `org_id`; `getOwned` becomes
org-scoped (`WHERE id = $1 AND org_id = $2`) using the token's org. Tokens are
minted `admin`-equivalent within their org (machine automation = full control),
so no per-token role for now.

## Route-by-route changes (summary)

| Route | Old scope | New scope | Role |
|-------|-----------|-----------|------|
| GET /admin/prototypes | owner_id | org_id | member |
| POST /admin/prototypes (upload) | owner_id set | org_id set | admin |
| GET /admin/prototypes/:id (+ detail, preview, versions, comments list, access-log, funnels) | getOwnedPrototype | getOrgPrototype | member |
| POST /admin/prototypes/:id/settings | getOwnedPrototype | getOrgPrototype | admin |
| DELETE /admin/prototypes/:id | getOwnedPrototype | getOrgPrototype | admin |
| DELETE …/comments(/:cid) | getOwnedPrototype | getOrgPrototype | admin |
| POST /admin/tokens, DELETE /admin/tokens/:id | user_id | org_id (+ user_id) | admin |
| GET /api/v1/* | owner_id | token.org_id | (machine) |

The reviewer-facing `/api/*` routes keep the P0 session/owner logic, but the
"admin who owns it" branch of `authorizedForPrototype` changes from
`owner_id = userId` to "userId is a member of the prototype's org."

## Error handling

- No membership in active org → **403** (not 404): the user is authenticated but
  lacks access. (Cross-*org* prototype access via `getOrgPrototype` still returns
  **404** — an org's prototypes shouldn't reveal the existence of another org's.)
- Viewer attempting a write → **403** with `{ error: 'Requires admin role.' }`.

## Testing

- **Migration test**: seed legacy users + prototypes, run initDb twice, assert one
  default org, all users admins, all prototypes + tokens carry org_id, marker set,
  second run is a no-op.
- **Org isolation test**: two orgs, user in org A cannot see/mutate org B's
  prototypes (404), and vice-versa.
- **Role test**: viewer can GET prototypes + POST a comment; viewer gets 403 on
  upload/settings/delete/publish/token routes; admin succeeds on all.
- **Session test**: activeOrgId set at login; multi-membership picks the newest.
- Extend existing admin/tenancy/apiV1 suites to seed org + membership.

## Out of scope (future plans, files written now)

- **Self-serve org creation on signup** →
  `docs/superpowers/plans/2026-07-29-future-self-serve-org-signup.md`
- **Owner/Member role split** (Owner = billing/delete-org above Admin; Member =
  create/manage prototypes but not org) →
  `docs/superpowers/plans/2026-07-29-future-owner-member-roles.md`
- Org-switcher UI, invitations/email, per-token roles, billing.
