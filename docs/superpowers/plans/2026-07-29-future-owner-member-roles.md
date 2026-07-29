# FUTURE: Split roles into Owner / Admin / Member

> **Status:** Deferred. Captured 2026-07-29 at product request while implementing
> the initial `admin` + `viewer` role model (see
> `docs/superpowers/specs/2026-07-29-org-multitenancy-design.md`).

**Goal:** Refine the org role model from two roles (`admin`, `viewer`) into a
richer hierarchy so that org-level governance (billing, deleting the org,
transferring ownership) is separated from day-to-day prototype management.

## Target role hierarchy

| Role | Prototypes | Members / tokens / settings | Billing / delete org / transfer |
|------|-----------|------------------------------|----------------------------------|
| **owner** | full | full | **yes** (exclusive) |
| **admin** | full | full | no |
| **member** | create/edit/manage own + org prototypes | no | no |
| **viewer** | read + comment only | no | no |

- `owner` is the current `admin` **plus** exclusive org-lifecycle powers. Every
  org must have exactly one owner (or at least one; decide on transfer semantics).
- `admin` becomes "manages people and prototypes but can't kill the org."
- `member` is new: full prototype CRUD but no people/settings management. This is
  the role most day-to-day creators should have once orgs have many people.
- `viewer` unchanged (read + comment).

## Prerequisite

The base org model with `admin`/`viewer` (this sprint) must be shipped. This plan
*widens* the `role` CHECK constraint and refines the authorization helpers.

---

## Task 1: Widen the role enum + migrate

**Files:** `src/db.js`, `tests/tenancy.test.js`

- [ ] **Step 1:** Widen the CHECK constraint (atomic drop + add, like the existing
  `comments_type_check` pattern):

```sql
DO $$ BEGIN
  ALTER TABLE org_memberships DROP CONSTRAINT IF EXISTS org_memberships_role_check;
  ALTER TABLE org_memberships ADD CONSTRAINT org_memberships_role_check
    CHECK (role IN ('owner','admin','member','viewer'));
END $$;
```

- [ ] **Step 2:** Migration (marker `org-roles-owner-member-v1`): for each org
  with no `owner`, promote the earliest-created `admin` to `owner`. Leave other
  admins as `admin`.
- [ ] **Step 3:** Test: legacy org gets exactly one owner (the first admin);
  idempotent on re-run.

---

## Task 2: Refine authorization helpers

**Files:** `src/services/orgs.js`

- [ ] Replace the binary `requireAdmin` with capability checks:
  - `canManageOrg(role)` → `owner`, `admin`
  - `canManagePrototypes(role)` → `owner`, `admin`, `member`
  - `canDeleteOrg(role)` → `owner` only
  - `canComment(role)` → all roles
- [ ] Update each route's guard to the capability it needs (see table above).
- [ ] Tests per capability × role matrix (16 cells).

---

## Task 3: Org-lifecycle routes (owner-only)

- [ ] `DELETE /admin/org` — owner-only; cascades (org_memberships, and decide
  prototype fate: block if prototypes exist, or cascade with confirmation).
- [ ] `POST /admin/org/transfer` — owner designates another admin as new owner
  (atomic: demote self to admin, promote target to owner).
- [ ] Billing hooks (if/when billing exists) gated on `owner`.
- [ ] Tests: only owner can delete/transfer; transfer preserves exactly-one-owner.

---

## Task 4: Members UI role controls

- [ ] Role dropdown in the members page supports all four roles.
- [ ] Guards: can't remove/demote the last owner; only owner can grant `owner`.
- [ ] Tests for the guard rails.

## Notes / open questions
- Exactly-one-owner vs. multiple owners? (Recommend exactly one for clarity;
  transfer rather than multi-owner.)
- What happens to a `member`'s prototypes if they're removed from the org?
  (Reassign to org / owner, don't orphan.)
- Whether `member` can invite `viewer`s (probably not — keep invites admin+).
