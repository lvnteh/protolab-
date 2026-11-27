# ProtoLab improvement plan — multi-org accounts, access, and HTML isolation

> **Status** Draft for review, consolidated 2026-11-27. This document contains
> the proposed work and acceptance criteria. Application implementation has
> not started. Supersedes the deferred
> `2026-07-29-future-self-serve-org-signup.md` (which assumed signup auto-creates
> a *personal* org). Builds on the shipped base in
> `docs/superpowers/specs/2026-07-29-org-multitenancy-design.md`. The richer
> owner/admin/member/viewer hierarchy in
> `2026-07-29-future-owner-member-roles.md` stays deferred — we keep the two-role
> `admin`/`viewer` model for this phase.

## Application scope

This is the single review plan for ProtoLab organizations, prototype assets,
memberships, invitations, browser sessions, feedback permissions, API/MCP
credentials, and HTML execution isolation. The GitHub-based Docs application
is separate and excluded from this work.

The [HTML sandboxing workstream](#html-prototype-sandboxing) is included here
in full and can ship independently of the organization changes. It also
affects existing single-org installations.

## How to review this plan

The product decisions below capture the requested behavior. The capability
matrix, canonical org URLs, service design, and task breakdown are proposed
implementation details for review. Tasks 0–6 cover org and access behavior,
Tasks 7–8 cover completion checks, and Tasks S1–S4 cover HTML isolation.
Recorded issues distinguish confirmed deferrals from proposed follow-up work.

The audit found gaps beyond org creation and invitations, including feedback
authorization, share-link access, stale sessions, viewer controls, upload CSRF,
and executable HTML. These are included below. Migration remains a small
one-time EMS bootstrap appropriate for the existing test data.

## Goal

Turn ProtoLab into a multi-tenant SaaS where the **org is the account**. A person
has one login that can span many orgs. Growth is self-serve (create an org) and
invite-driven (per-email, single-use invites into a specific org).

## Product decisions (confirmed 2026-11-27)

1. **One user account, many orgs.** One `users` row and N `org_memberships`.
   Each page identifies its organization. `session.activeOrgId` supplies a
   default landing preference. The functional audit below proposes explicit
   org URLs so users can work in several orgs in separate tabs.
2. **Domain allowlist stays global.** `config.allowedEmailDomains`
   (`sap.com`, `emarsys.com`) gates signup, org creation, invitation creation,
   and invitation acceptance, including acceptance by existing users. Email
   ownership verification is a recorded issue deferred by product decision.
3. **Bare accounts allowed.** A user can exist with zero orgs and lands on a
   "create or join an org" home. This replaces the old auto-join-Default-Org
   behavior and makes the no-active-org state a designed first-class screen.
4. **Creator becomes admin.** Whoever creates an org is its `admin`.
5. **Invites are per-email, single-use.** Admin enters an email + role; system
   mints a token bound to (org, email, role). Acceptance matches the canonical
   account email loaded from `users`. The admin copies and shares the link.
   Joining requires an explicit confirmation submitted by POST.
6. **Invitees default to `viewer`.** Admin can promote `viewer`→`admin` and
   demote `admin`→`viewer`, remove members, revoke pending invites, and
   rename/delete the org.
7. **Consolidate existing ProtoLab assets into EMS.** A one-time migration
   creates an organization named `EMS`, moves every existing prototype and API
   token into it, and makes every existing user an EMS admin. Subsequent signups
   start with zero memberships.
8. **API tokens belong to their issuing user within an org.** Demotion or removal
   revokes that user's tokens in that org. Token authentication also checks
   their current admin membership.
9. **Seven-day invitations.** Admins can revoke or reissue invitations. Reissue
   generates a new token and retires the previous one.
10. **Same-org admins and viewers can use prototype share links.** Entering
    their own account email allows them to open any shared prototype owned by
    their org, including when logged out. No manual per-prototype allowlist
    entry is required. Membership in another org grants no inherited access.
    Email entry grants prototype-specific review access. Administrative powers
    require an authenticated account and its current role.
11. **Uploaded HTML must be sandboxed.** Isolate published HTML, direct raw
    URLs, and previews regardless of the number of organizations.

## Invariants (enforced everywhere)

- **Every live org has at least one admin.** Serialize membership changes and
  block demoting/removing the last admin. Org deletion removes the whole org.
- **Requests identify their intended org.** Resolve `req.orgId` from validated
  request context, check current membership, and scope resource lookups by it.
  Reads and writes use the same page-specific org. A mismatched or unauthorized
  mutation receives an error before any write or upload occurs.
- **Browser mutations require CSRF protection.** This includes login-only forms,
  org switching, invite acceptance, and management actions. GET/HEAD may render
  or redirect but cannot accept invitations or change memberships.
- **Transactions use one checked-out Postgres client.** All statements from
  BEGIN through COMMIT/ROLLBACK run on that client. Session changes follow a
  successful commit. Lock ordering is org first, then invitation/membership.
- **Privilege changes and invite transitions are serialized.** Management
  services lock the org row with `FOR UPDATE`, then recheck the actor's current
  admin role. Acceptance also locks its invitation before checking its state.
- **Removal applies to machine credentials.** Revoke tokens in the same
  transaction as demotion/removal. Later token requests fail authorization.
- **Share access follows current grants.** Effective allowed emails are the
  union of the prototype's explicit reviewer entries and current admin/viewer
  account emails in its owning org. Recheck this rule when serving protected
  content or feedback. Stored reviewer sessions cannot preserve revoked access.
- **Deletion cleanup survives retries.** Persist storage cleanup work in the
  same transaction that deletes the database records. Object deletion is
  idempotent and retryable after process restarts.

## Functional completion criteria proposed after code audit

These additions address everyday multi-org use while retaining the chosen
`admin`/`viewer` roles. Every action resolves a current actor, an organization or
reviewer grant, and a resource. The same capability rules apply through the
admin UI, member prototype view, feedback API, and machine API.

| Action | Signed-in org admin | Signed-in org viewer | Share-link reviewer |
|--------|-----------|------------|---------------------|
| Open published prototypes and read feedback | Within their org | Within their org | Granted prototype |
| Read org analytics | Within their org | Within their org | No |
| Browse version history | Org version history | Org version history | Published versions of granted prototype |
| Create comments and replies | Yes | Yes | Granted prototype |
| Edit/delete own comment within the existing five-minute window | Yes | Yes | Current reviewer identity |
| Moderate other people's comments by deleting them | Yes | No | No |
| Create/edit/delete explanations | Yes | No | No |
| Upload, rename, publish, or delete prototypes | Yes | No | No |
| Manage members, invitations, tokens, or org settings | Yes | No | No |

The five-minute ownership rule already appears in the feedback SDK. Enforce it
on the server. Identify account authors by user ID and derive their display
email from the account. Reviewer authorship follows the server-side reviewer
grant, subject to the recorded limitation that email ownership is unverified.
The share-link column also applies to logged-out org members entering their
email. An email match alone cannot establish an authenticated account actor.

Use `/admin/orgs/:orgId/...` as the canonical org-scoped browser route prefix.
Prototype and token routes use their existing suffixes under that prefix.
`/admin/home`, signup/login/logout, org creation/switching, and token-based
invitation confirmation are global account routes.

---

## Task 0 — Schema and one-time EMS migration

Files include `src/db.js`, `tests/orgs.test.js`, and `tests/tenancy.test.js`.

- [ ] Add `org_invitations` with the following schema.

```sql
CREATE TABLE IF NOT EXISTS org_invitations (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,                 -- trimmed and lowercased
  role        TEXT NOT NULL CONSTRAINT org_invitations_role_check CHECK (role IN ('admin','viewer')),
  token       TEXT NOT NULL UNIQUE,          -- nanoid(24)
  invited_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,                 -- canonical UTC, seven days after creation
  accepted_at TEXT,
  accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  revoked_at  TEXT,
  CONSTRAINT org_invitations_terminal_check
    CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_invites_org   ON org_invitations(org_id);
-- UNIQUE(token) already provides its lookup index.
-- An unconsumed expired invitation occupies this slot until retired/reissued.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invites_pending
  ON org_invitations(org_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
```

- [ ] Add the marker `org-ems-consolidation-v1`. Under the existing migration
  advisory lock, use a single transaction to create a fresh EMS org with an
  opaque ID, update **all** existing `prototypes.org_id` and `api_tokens.org_id`
  to that ID, insert an `admin` EMS membership for every existing user, and
  record the marker. Include assets already assigned to other orgs and assets
  with null `org_id`. Identify the created org by its ID throughout the migration.
- [ ] Preserve prototype IDs, share tokens, authorship, version/comment links,
  and storage keys while updating ownership scope. Existing user rows provide
  the identities for EMS memberships. Legacy organization records and other
  memberships remain available for their own application lifecycle.
- [ ] Existing application data is test data, confirmed on 2026-11-27. Run the
  one-time bootstrap at startup before accepting requests. On an empty
  installation, record the marker and let self-serve creation establish the
  first org. Keep migration handling proportionate to this fixture baseline.
- [ ] Replace the old `org-multitenancy-v1` fold execution with this bootstrap,
  including its `OR unassigned prototypes exist` trigger. Remove both per-boot
  self-heals, including env-admin membership restoration, and signup auto-join.
  Keep historical migration markers as history. Later boots use the EMS marker
  to skip consolidation even after EMS is renamed or deleted.
- [ ] After backfilling existing data, enforce non-null org IDs on prototypes
  and API tokens so future writes must supply an explicit tenant. Update direct
  SQL fixtures and the token service's nullable-org fallback accordingly.
- [ ] Add a durable storage cleanup table for Task 5. Store object kind/key,
  retry state, attempt count, and next-attempt time. Entries must outlive the org
  and prototype rows that caused their creation.
- [ ] Test that all existing assets/users land in EMS, including current
  viewers becoming admins. Verify empty startup, transaction rollback, and
  repeat startup after role changes or EMS rename/deletion. **Commit.**

---

## Task 1 — Org service, concurrency, and machine access

Files include `src/services/orgs.js`, `src/services/tokens.js`,
`src/middleware/apiTokenAuth.js`, and the org, tenancy, and API token tests.

Keep routes thin and implement the service operations below.

- [ ] `createOrg(userId, name)` inserts the org and the user's `admin` membership
  in one transaction and returns `{ orgId }`.
- [ ] `listUserOrgs(userId)` — `[{ orgId, name, role }]` ordered by created_at, for
  the switcher and home.
- [ ] `listMembers(orgId)` — members with role + email + created_at.
- [ ] `setRole(orgId, actorUserId, targetUserId, role)` and
  `removeMember(orgId, actorUserId, targetUserId)` lock the org row, recheck the
  actor's admin membership, and count remaining admins inside the transaction.
  Refuse loss of the last admin with `LastAdminError`. Revoke the target user's
  API tokens in this org when demoting or removing them.
- [ ] Token issuance participates in the same org-lock protocol and rechecks
  current admin membership inside its transaction. Concurrent demotion and
  issuance must leave zero usable tokens for the demoted member.
- [ ] `resolveToken` checks current membership and admin role as well as the
  token secret. Cover old tokens and tokens whose issuer has lost membership.
  Re-promotion or re-invitation requires issuing new credentials.
- [ ] `createInvite(orgId, email, role, actorUserId)` validates syntax, normalizes
  email, checks the domain and role, and refuses existing members. Under the
  org lock, retire an expired unconsumed invitation before inserting a new
  `nanoid(24)` token with seven-day expiry. A live pending invite returns an
  actionable already-invited result. The unique index is a final backstop.
- [ ] `reissueInvite(orgId, inviteId, actorUserId)` atomically revokes a live or
  expired unconsumed invite and creates its replacement with a fresh token and
  seven-day expiry. Recheck domain, role, and existing membership.
- [ ] `listInvites(orgId)` returns explicit pending, expired, accepted, and
  revoked states for the UI. Pending requires an expiry later than server time.
- [ ] `revokeInvite(orgId, inviteId, actorUserId)` uses the org/invitation locks.
  Repeating revocation is harmless. Accepted invitations are terminal.
- [ ] `acceptInvite(token, userId)` loads the canonical email from `users`.
  Resolve the invitation's org, lock the org and invitation, then re-read state,
  expiry, email, and domain before inserting membership and setting
  `accepted_at`/`accepted_by` in one transaction. Existing memberships retain
  their current role. Use database/server time consistently for expiry.
- [ ] An accepted token retried by its original accepting user succeeds only
  while that user still has membership. It returns the current membership and
  cannot restore a removed user or elevate their role. Other used-token cases
  return a typed error. Revoke-versus-accept and reissue-versus-accept have one
  committed winner, determined by lock order.
- [ ] Test simultaneous last-admin changes, actor demotion during management,
  accept/revoke/reissue races, token issuance/demotion races, rollback, and
  subsequent API/MCP denial after removal. **Commit.**

> **Deferred-role note** `setRole` supports `admin`/`viewer`. When the
> owner/member split (`2026-07-29-future-owner-member-roles.md`) is picked up, the
> "≥1 admin" invariant becomes "≥1 owner" and these guards widen. Keep the guard
> centralized in the service so there's one place to change.

---

## Task 2 — Self-serve org creation and session recovery

Files include `src/routes/admin.js`, `src/services/orgs.js`,
`src/views/admin-home.html` (new), the signup/login views, and tenancy tests.

- [ ] **Step 1** After the signup change in Task 0, new users have zero orgs. After
  signup/login, if the user has **0 memberships**, redirect to `/admin/home`
  (the create-or-join screen) instead of `/admin/prototypes`.
- [ ] **Step 2** Protect `GET /admin/home` with `requireLogin` so an org-less
  user can reach it. Render `admin-home.html` with the user's orgs, a
  "Create organization" form, and guidance for joining through an invite link.
- [ ] **Step 3** Protect `POST /admin/orgs` with `requireLogin`. Validate the name,
  check the account's canonical email domain, call `createOrg`, and redirect
  to the new org's canonical prototype-list URL after saving its preference.
- [ ] **Step 4** Rate-limit org creation (reuse `middleware/rateLimit.js`) to
  deter spam.
- [ ] **Step 5** On browser navigation with a missing/deleted/inaccessible
  active org, recover through `/admin/home` with remaining memberships and an
  explanatory message. Apply recovery to every affected session, including
  members removed by another admin. Mutation and JSON endpoints return typed
  403/409 responses before making changes. Scope navigation recovery to ProtoLab
  entry points when authorization helpers also serve another application.
- [ ] **Step 6** Signup creates a valid bare account even if an invitation
  subsequently expires or becomes invalid. Auth redirects to invite confirmation
  when an invite continuation exists. Account creation and accepting an
  invitation are separate user actions with their own transactions.
- [ ] **Step 7** Tests cover no-org signup/login, org creation, existing
  sessions after removal/deletion, and invalid invites after successful signup.
  EMS appears in every migrated user's home and switcher.
- [ ] Preserve a validated local return path across login for prototype deep
  links as well as invitations. Recheck membership before following it. Direct
  `/admin` access resolves an authenticated user's landing without asking them
  to log in again. Remember the last accessible org across logins using a stored,
  validated preference, with `/admin/home` as recovery.
- [ ] Regenerate the session on successful authentication/account changes,
  carrying forward the validated continuation. Clear the previous account's
  transient state and regenerate CSRF state. Old tabs receive actionable
  authentication errors if their identity or token is stale. **Commit.**

> Introduce a `requireLogin` guard (userId present, no org required) in
> `orgs.js`. Reuse/rename the existing `adminAuth.js` guard so the
> login-but-no-org routes (`/home`, `/orgs`, invite-accept, switch) share one gate.

---

## Task 3 — Org switcher and binding browser actions to an org

Files include `src/routes/admin.js`, `src/services/orgs.js`, the ProtoLab admin
shell views, and `tests/tenancy.test.js`.

- [ ] **Step 1** Protect `POST /admin/orgs/switch` with `requireLogin`. Validate
  body `orgId` through `orgs.membership`, set `session.activeOrgId`, save the session,
  and redirect to `/admin/orgs/:orgId/prototypes`. Other tabs keep their explicit
  URL context. A user who is admin in A and viewer in B gets each page's local role.
- [ ] **Step 2** Add a header dropdown listing `listUserOrgs(userId)` with the
  page's URL org marked and a "+ New organization" entry leading to `/admin/home`. Show
  the org ID as secondary context where names collide, including settings and
  deletion confirmation.
- [ ] **Step 3** Bind all reads, links, forms, and fetches to the canonical URL
  org. This includes tokens, comments, screenshots, analytics, versions, upload,
  settings, and membership pages. Validate URL/body/header org agreement and
  current role before side effects. Multipart fetches carry CSRF and org headers
  before parsing or storing files. Each page keeps its request context when a
  different tab changes the default landing preference.
- [ ] **Step 4** Redirect old read-only admin links to canonical URLs after
  checking resource membership. Old unscoped mutation routes require rendered
  `expectedOrgId` and reject a mismatch with their legacy session context.
  Convert the standalone `/admin/upload` multipart form to the same protected
  fetch flow used by the upload panel. API/MCP requests use the token's org.
- [ ] **Step 5** Test two simultaneous org tabs, including admin in A/viewer in
  B, async reads after switching, and uploads/invites/settings submitted from
  either tab. Test stale unscoped forms, mismatched context, direct links into
  another accessible org, and unauthorized org IDs. **Commit.**

---

## Task 4 — Invitation creation, confirmation, and recovery

Files include `src/routes/admin.js`, `src/views/admin-members.html` (new),
an invitation confirmation view, and `tests/invites.test.js` (new).

- [ ] **Step 1** Protect `POST /admin/orgs/:orgId/members/invite` with `requireAdmin`. Validate
  `{ email, role }` and expected org, call `createInvite`, and return the link
  `${config.baseUrl}/admin/invite/:token` (admin copies it). Surface domain-reject
  and already-member / already-invited errors inline.
- [ ] **Step 2** Add CSRF-protected POST routes for revocation and reissue
  under `/admin/orgs/:orgId/members/invite/:id`, with admin and org validation.
- [ ] **Step 3** Make `GET /admin/invite/:token` available to logged-out visitors
  as well as authenticated users.

  - For logged-out visitors, preserve an invitation continuation through
    signup/login and show the invitation's org and role.
  - For logged-in visitors, render the org, invited role, current account email,
    and a "Join organization" POST form. Validate and escape display data.
  - Wrong-email visitors can switch accounts while preserving the invitation
    route across logout. Expired/revoked/used states explain how to request a
    replacement or return home.

- [ ] **Step 4** `POST /admin/invite/:token/accept` uses `requireLogin` and
  CSRF protection. The token identifies its target org, allowing an org-less
  user to join. Call `acceptInvite(token, userId)` and set `activeOrgId` only
  after commit. Redirect to that org's canonical prototype list with feedback.
- [ ] **Step 5** Successful signup/login returns to the invitation GET page.
  Preserve only a validated same-application invitation path across logout and
  any session replacement. Clear continuations after completion or deliberate
  cancellation. Provide a way to return home after invalid invitation errors.
  Carry continuation on the relevant auth form/URL so two invitation tabs
  retain their own targets instead of overwriting a single session token.
- [ ] **Step 6** Tests run with CSRF enforcement enabled. GET/HEAD leave
  membership, token consumption, and active org intact. Test the full
  logged-out → signup/login → confirmation → POST flow, wrong-account logout
  and return, expiry/reissue, repeated POST, current domain checks, and tokens
  already accepted by a subsequently removed user. **Commit.**

---

## Task 5 — Members, settings, and complete org deletion

Files include `src/views/admin-members.html`, `src/routes/admin.js`,
`src/services/orgs.js`, storage cleanup support, and membership/deletion tests.

- [ ] **Step 1** Protect `GET /admin/orgs/:orgId/members` with `requireAdmin`. Render members
  (`listMembers`) with role controls, invitations with status/expiry and
  revoke/reissue actions, and the invite form. Gate the nav link on `orgRole`.
- [ ] **Step 2** Protect `POST /admin/orgs/:orgId/members/:userId/role` with `requireAdmin`
  and expected-org validation. Call `setRole` with the authenticated actor ID.
  Return 409 and an inline message for `LastAdminError`.
- [ ] **Step 3** Apply the same guards to `POST /admin/orgs/:orgId/members/:userId/remove`
  and call `removeMember` with the authenticated actor ID.
- [ ] **Step 4** Add `POST /admin/orgs/:orgId/rename` and `DELETE /admin/orgs/:orgId`. Both
  require admin, CSRF, and expected-org checks. Deletion requires typing the
  org's exact name. Send the confirmation text and validate it against the
  locked org row server-side. Show the org ID and affected resource counts.
- [ ] **Step 5** Implement deletion as a service transaction. Lock the org and
  recheck actor role/name. Inventory incoming foreign keys and restrict deletion
  to ProtoLab-owned resources. A shared org row with external application
  dependencies returns a conflict before deleting any data.
- [ ] **Step 6** Gather every prototype/version filename and screenshot key
  and enqueue deduplicated cleanup records. Explicitly delete the org's API
  tokens and prototypes before deleting the organization. The current
  `prototypes.org_id` and `api_tokens.org_id` foreign keys are restrictive.
  Existing prototype-child cascades remove versions, comments, explanations,
  allowlists, and telemetry. Org-owned memberships and invitations cascade.
- [ ] **Step 7** Coordinate prototype creation, version and feedback-screenshot
  writes, and token issuance with deletion through compatible org locks and a
  transaction-time org check. Failed uploads compensate their newly stored
  objects or enqueue cleanup. Deletion and a concurrent upload/comment must
  leave neither orphan files nor surviving assets attached to a deleted org.
- [ ] **Step 8** Drain committed cleanup records with a restart-safe runner,
  claiming work safely across instances and retrying failures with backoff.
  Missing objects count as success. After commit, move the actor to a remaining
  org or `/admin/home`. Other sessions recover through Task 2.
- [ ] **Step 9** Test role changes, last-admin protection, rename, populated
  deletion, wrong confirmation, stale tabs, API token invalidation, concurrent
  uploads, database rollback, storage failure/retry, restart recovery, and
  every affected member's subsequent navigation. **Commit.**

---

## Task 6 — Member viewing, same-org share access, and feedback permissions

Files include `src/db.js`, ProtoLab admin/delivery/feedback routes, `customerAuth`,
`annotations.js`, a shared access-resolution service, admin views, and the
feedback SDK.

### Member and share-link entry

- [ ] Implement an authenticated member prototype-view entry point under the
  canonical org URL. The list's "Open" action uses it. A member can view and
  comment with their account identity even when absent from the external
  reviewer allowlist. Reuse published-version resolution and the review shell,
  with HTML isolation supplied by Tasks S1–S4 below.
- [ ] Add one effective-reviewer-access resolver shared by entry, delivery,
  and feedback routes. An email qualifies when it has an explicit `allowlist`
  row for the prototype **or** matches the canonical `users.email` of a current
  `admin`/`viewer` membership in `prototype.org_id`. Normalize both sides by
  trimming and lowercasing. Resolve the owning org from the stored prototype.
- [ ] Derive org-member access dynamically. Do not copy member emails into
  every prototype's allowlist. The rule applies immediately to existing and new
  prototypes and to members joining later. Pending invitations, bare accounts,
  a shared email domain, and membership in another org grant no inherited access.
  The browser's selected org does not affect this decision.
- [ ] Update `POST /p/:shareToken/enter` to use that resolver. A same-org admin
  or viewer can open a link while logged out by entering their account email.
  Preserve the external-reviewer flow and published-version restrictions. The
  resulting session grants review access only to that prototype.
- [ ] Recheck effective access on `/view`, `/raw`, version/content requests,
  and every feedback read/write, including screenshot reads. Removing a member
  ends inherited access on the next protected request. Removing an explicit
  reviewer entry ends access if no membership-derived grant remains. An
  independent explicit entry can still allow a removed member to review.
  Changing `admin` ↔ `viewer` retains review access while changing account
  capabilities and revoking machine credentials where required.
- [ ] Explain the rule in prototype settings with separate inherited-org and
  editable explicit-reviewer sections. Show current org admins/viewers as
  automatically allowed. Deduplicate canonical emails in effective counts,
  including prototype-list counts. Label explicit-reviewer counts where shown.
  Removing an explicit entry must explain when inherited access still applies.
- [ ] Test both roles opening existing/new prototypes through a share link
  while logged out, new membership, mixed-case/whitespace email input, unrelated
  active org, cross-org denial, pending invitations, bare accounts, and explicit
  external reviewers. Cover membership/allowlist removal after entry, surviving
  independent grants, role changes, deduplicated counts, and preserved denial
  of unpublished versions.

### Authorization, identity, and UI

- [ ] Resolve a structured actor in the feedback API and enforce the capability
  matrix for every read/mutation. Current `authorizedForPrototype` returns a
  membership boolean and allows viewers to edit/delete others' comments and
  explanations. Apply role and ownership checks to these exact endpoints.
- [ ] Derive comment and navigation identity server-side. Add stable account
  author IDs and an author-kind distinction to new comments. Legacy comments
  with insufficient identity remain subject to admin moderation. Request-body
  email fields cannot establish authorship or editing rights.
- [ ] Keep account and reviewer identities distinct when both exist in a
  browser session. The member entry uses the authenticated account and current
  membership. The share entry uses its validated reviewer identity. Resolve
  one actor consistently for authorship and permissions, and offer an explicit
  member-view action when an authenticated member wants account capabilities.
  Never infer account authorship or privileges from a typed member email.
- [ ] A member-view request uses current membership. A reviewer-view request
  uses its prototype grant and the effective email-access rule above. Explain
  these independent grants in member-removal and reviewer-removal messages.
- [ ] Render permitted actions from the page's role. Cover upload, settings,
  publish, destructive actions, explanation edits, tokens, and member controls.
  Viewers get useful empty states and an accessible "Open" action. Label login
  for all users and show org name and current identity throughout member pages.
- [ ] Handle response status before changing UI state. Current comment and
  explanation delete handlers remove visible rows even on server failure.
  Distinguish unauthenticated 401, unauthorized 403, missing resource 404, and
  stale/conflicting action 409. Preserve user input on recoverable errors.
- [ ] After self-demotion/removal, navigate to an allowed page and recompute
  controls. Existing tabs revalidate on return and handle role changes on their
  next request. Use private, non-cacheable authenticated responses and revalidate
  restored browser-history pages. API consumers receive typed JSON
  authentication and authorization errors.
- [ ] Show the token's org, issuing user, and revocation consequences in token
  management. Correct the current copy that says a token covers all account
  prototypes. MCP setup identifies the org selected at token creation. Test
  independent tokens for A/B and actionable errors after revocation.
- [ ] Add role-by-entry-point tests covering the matrix, forged author fields,
  internal member viewing, same-org email entry, shared reviewer access, mixed
  account/reviewer sessions, demotion, and removal.

## Task 7 — End-to-end journey verification

- [ ] Make the local development authentication bypass an explicit opt-in
  setting. Verify login, logout, invitations, and zero-org states through the
  real server with that bypass disabled and CSRF enabled.
- [ ] Run the journey matrix below for HTML and uploaded Markdown prototypes.
  Use two browser tabs and separate browser sessions where specified.

| Journey | Required outcome |
|---------|------------------|
| New user signs up, creates A, and uploads | Correct identity, org, admin role, protected upload, usable published view |
| Existing/new user joins through an invitation | Correct org/role, explicit confirmation, account-switch recovery |
| Same user is admin in A and viewer in B | Correct controls and API permissions in each tab |
| Member opens and comments on an org prototype | Direct access with account identity and correct authorship |
| Logged-out admin/viewer enters their email on an own-org share link | Prototype opens without an explicit reviewer row, with reviewer capabilities |
| Member of B enters their email on an A share link | Denied unless independently on that prototype's explicit allowlist |
| Member or explicit reviewer is removed after share entry | Next protected request is denied unless another current grant applies |
| User follows an authenticated member-view deep link while logged out | Login returns to that accessible org and prototype |
| Two org tabs issue async reads and writes | Each request stays in its page's org |
| Admin is demoted or member removed during a session | Updated controls, denied disallowed actions, revoked tokens, recoverable navigation |
| User retries an expired/consumed/reissued invitation | Accurate state and recovery, with at most one membership |
| Member uses API/MCP credentials for A and B | Each token sees its own org and fails after revocation |
| Admin deletes an org while another member has it open | Resources removed, other member recovers, cleanup retries safely |

- [ ] Verify refresh, browser back/forward, session expiry, duplicate clicks,
  invalid names/emails, failed requests, and direct endpoint calls. Treat the
  observed UI and server-side outcome as the acceptance criteria.

## Task 8 — Consistency, documentation, and validation

- [ ] Audit ProtoLab browser and API/MCP entry points for current membership,
  role, resource scoping, CSRF where applicable, and explicit org context.
- [ ] Update `orgs.js` header comment (roles, invariants, where last-admin is
  enforced) and `docs/superpowers/specs/2026-07-29-org-multitenancy-design.md`
  to reference this phase.
- [x] Mark the old self-serve signup plan as superseded. Keep the richer-role
  plan deferred and reference the current membership invariants.
- [ ] Run the full Jest suite with Postgres and `node --check` on edited server files.
- [ ] **Commit.**

---

## HTML prototype sandboxing

This workstream applies to ProtoLab installations with any number of orgs.
Tasks S1–S4 can be implemented and released independently of EMS migration,
invitations, and role management. Coordinate their shared authorization and
CSRF helpers with Task 6.

### Current behavior and execution boundary

- `src/views/proto-shell.html` embeds uploaded HTML in an iframe with its
  application-origin privileges.
- `src/routes/delivery.js` serves executable uploaded HTML at
  `/p/:shareToken/raw`. That URL also works as a directly opened document.
- `src/routes/admin.js` serves uploaded HTML directly from the preview route.
- `public/sdk/frame-bridge.js` and `public/sdk/feedback.js` currently validate
  messages against the application's origin. A sandbox with an opaque origin
  changes incoming message origins to the string `null`.
- Cookie-authenticated feedback mutations need request protection alongside
  the frame boundary. An isolated document can still attempt network requests,
  including requests that a browser sends with credentials.

Use `sandbox="allow-scripts"` on the HTML iframe. Scripts execute with an opaque
origin. Grant additional sandbox capabilities only where a supported prototype
interaction requires them and browser tests demonstrate isolation. The
`allow-same-origin` capability would restore the application-origin privileges
that this design removes.

Apply `Content-Security-Policy: sandbox allow-scripts` as an HTTP response header
on every endpoint returning executable uploaded HTML. The response policy
also governs a raw URL opened directly and descendants created by that document.
Inventory navigations and all executable content paths when implementing this
policy. Trusted shell routes keep their own application-origin privileges.

Keep authenticated API requests, CSRF tokens, comment data, account data, and
screenshot capture in the shell. The child reports interaction geometry and
navigation through a narrowly defined message protocol. A trusted shell action
determines which prototype and version each API request addresses. Preserve
Markdown's existing sanitized rendering and restrictive CSP, and verify that
embedded Markdown HTML cannot create an executable-content bypass.

### Task S1 — Sandboxed delivery and previews

Files include `src/views/proto-shell.html`, `src/routes/delivery.js`,
`src/routes/admin.js`, `src/services/inject.js`, and `public/sdk/preview.js`.

- [ ] Add the iframe sandbox and server-delivered sandbox policy to published
  HTML and raw-content responses. Preserve current share/member authorization
  and version checks before reading storage.
- [ ] Convert HTML admin previews into a trusted shell plus a sandboxed content
  response with the same isolation policy. Authorize both requests independently.
  Keep preview comment data in the shell and extend the bridge only with the
  geometry operations needed for existing highlight behavior.
- [ ] Cover direct URL access, redirects, legacy prototypes, and published
  versions. Check every route that serves stored HTML as executable content.
- [ ] Exercise inline prototype scripts, external script/style assets, clicks,
  scrolling, and hash/history navigation. Document compatibility differences
  caused by opaque-origin storage, CORS, forms, and navigation restrictions.
  Adapt ProtoLab's bridge for supported flows and surface unsupported operations
  with useful feedback.

### Task S2 — Message protocol across the sandbox boundary

Files include `public/sdk/frame-bridge.js`, `public/sdk/feedback.js`, and preview
integration.

- [ ] The shell validates `event.source === iframe.contentWindow` and the
  expected opaque origin. Treat every payload from that frame as untrusted.
  Validate allowed message types, finite bounded coordinates, URL length and
  scheme, and current document/load state.
- [ ] The child validates `event.source === window.parent` and the configured
  trusted shell origin. Supply that origin from application-controlled data.
- [ ] Parent-to-child `postMessage` uses `*` where required for an opaque-origin
  target. Limit that channel to non-sensitive presentation commands, such as
  comment-mode toggles. Child-to-parent messages use the exact shell origin.
- [ ] Bind API targets to the shell's server-rendered prototype/version state.
  The bridge supports a fixed set of presentation/navigation operations.
  Account actions and arbitrary fetch instructions are outside that protocol.
- [ ] Treat child-reported URLs as display/navigation context and validate them
  before recording or rendering. Keep credentials and authorization decisions
  under shell/server control.
- [ ] Verify readiness after frame reloads, navigation tracking, comment pins,
  screenshot cropping, preview highlights, and resize behavior.

### Task S3 — Protect authenticated requests

Files include ProtoLab's CSRF middleware, delivery/feedback routes, shell
injection, and SDK request code.

- [ ] Apply CSRF verification and same-origin request validation to ProtoLab
  cookie-authenticated mutations, including feedback and share-entry POSTs.
  Reject opaque-origin mutation requests before side effects. Trusted shell
  requests carry a session-bound token supplied by the server.
- [ ] Keep application responses readable only by authorized same-origin
  callers. Check CORS behavior with an actual sandboxed browser document.
- [ ] Verify that forged frame messages cannot make the parent issue arbitrary
  authenticated requests or change their prototype/account target.
- [ ] Exercise reviewer entry, comment creation/replies, annotations, navigation
  telemetry, admin preview, and bearer-authenticated API/MCP requests through
  their existing user-facing entry points.

### Task S4 — Browser verification and release

- [ ] Add browser regression coverage using a deliberately adversarial HTML
  fixture. Attempt parent DOM access, application storage access, authenticated
  response reads, mutation requests, forged bridge messages, top navigation,
  and direct raw/preview navigation. Assert the resulting server state.
- [ ] Test an authenticated admin viewing another creator's shared prototype,
  a reviewer without an admin session, and HTML created before this change.
- [ ] Test accepted messages from the active frame, rejected sibling-window
  messages, reload behavior, and malformed messages.
- [ ] Verify comments, consented screenshots, version selection, previews, and
  Markdown behavior in real browsers. Header assertions and script parsing
  supplement browser isolation tests.
- [ ] Release through ProtoLab's normal pipeline and verify representative
  existing prototypes. Track compatibility gaps with specific examples.

---

## Additional product decisions (confirmed 2026-11-27)

- **Invite expiry is seven days.** Expired invitations can be reissued. An
  accepted invitation has the retry semantics defined in Task 1.
- **Org names are display labels.** Duplicate names are supported, with the org
  ID identifying each organization.
- **Deleting an org requires typing its exact name.** Validate this server-side
  and remove ProtoLab database assets with durable storage cleanup.
- **Share-link reviewers have prototype-specific access.** The existing
  share-token entry flow will accept explicit reviewer emails and current same-org
  admin/viewer emails. Member viewing also has an authenticated entry point.
  Entering a member email through a share link grants reviewer capabilities.

## Recorded issues and follow-up work

- **Email ownership is unverified.** Signup currently accepts a typed
  allowlisted address. Someone possessing an invitation could register its
  intended address if unused. Domain checks validate the supplied address,
  without establishing corporate identity. Share-link email entry also does
  not prove ownership. Someone with the link and an allowed member/reviewer
  email could gain prototype review access by entering it. Product deferred
  email verification and SSO on 2026-11-27. Record this limitation without
  making verification a prerequisite for this phase. Track remediation in
  [the secure-auth plan](2026-08-02-future-secure-auth.md).
- **Two-role governance is coarse.** Prototype creators have full admin powers,
  including member removal and org deletion. Explain those powers when granting
  admin. The owner/member hierarchy remains deferred.
- **Account recovery and member-initiated departure need a later product
  decision (proposed follow-up).** The last-admin invariant protects membership
  consistency, while sole-admin credential recovery belongs to secure-auth
  work. A future leave-org action must use the same last-admin guard.
- **Reviewer tabs currently share one prototype grant (proposed follow-up).**
  Entering another share link replaces `session.prototypeId`. This also affects
  members using email-only share entry. Member-view tabs are covered by the
  explicit org/resource routes above. A proposed follow-up replaces the single
  grant with bounded, prototype-keyed grants, revalidated against effective
  access on each request. Test two independent share tabs and per-prototype
  revocation. This remains a known UX gap unless included during plan review.

## Audit evidence and remaining validation

The functional audit on 2026-11-27 inspected the ProtoLab admin, delivery,
feedback, API token, API/MCP, and session paths and their views/tests. Eighteen
existing suites passed, comprising 166 tests.

Nine temporary HTTP/database checks reproduced current behavior missing from
those suites. A viewer could edit/delete another author's comment through the
SDK API, supply another author's email, and create explanations. Member access
alone failed at the share view. Viewer HTML exposed admin actions. A second
reviewer link replaced the first grant, and allowlist removal left an existing
grant usable. The standalone upload form failed with CSRF enforcement enabled.

The reproductions used real local Postgres and mocked object storage. Full
browser interactions, browser sandbox enforcement, hosted storage behavior,
and the proposed org/invitation features require verification during
implementation. The journey matrix is the completion standard for this phase.

## Test strategy

- Use the dedicated Postgres test database and the repository's Jest setup.
  Update fixtures that assume signup automatically grants a Default Org
  membership or that prototype/token org IDs may be null.
- Mount the actual CSRF middleware with `CSRF_ENABLED=1` in new route tests.
  Exercise concurrent operations using separate database clients and controlled
  synchronization so race tests verify the promised serialization.
- Add browser verification for two-tab switching, invitation confirmation and
  wrong-account recovery, org-less navigation, same-org email share access,
  removal/revocation, and typed deletion. Run the adversarial HTML cases in
  Task S4. Syntax and inline-script parsing checks supplement these checks.
- Run the full Jest suite, lint, and syntax checks after the feature work.

## Rollout

- Use the existing test-data baseline and run the one-time EMS startup
  migration. Replace old application instances so the removed auto-enrollment
  behavior cannot continue handling requests.
- Verify EMS assets/admins and repeat startup once, then concentrate release
  validation on the role matrix and user journeys above.
- Release reviewed implementations through ProtoLab's existing pipeline and
  verify `/health` and representative member/reviewer journeys. HTML isolation
  can ship independently once its browser acceptance checks pass.
