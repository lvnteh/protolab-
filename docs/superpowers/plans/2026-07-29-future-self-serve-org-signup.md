# FUTURE: Self-Serve Organization Creation on Signup

> **Status:** Deferred. Captured 2026-07-29 at product request while implementing
> admin-provisioned orgs (see `docs/superpowers/specs/2026-07-29-org-multitenancy-design.md`).
> This is the "Option 1 — signup creates an org" path we chose *not* to build now.

**Goal:** Make org creation fully self-serve — when a permitted-domain user signs
up, they get a personal organization automatically and become its `admin`, then
can invite others. No super-admin provisioning step.

**Prerequisite:** The org multi-tenancy model (organizations, org_memberships,
prototypes.org_id, role-based auth) must already be shipped. This plan only adds
the self-serve *creation* path on top of it.

---

## Task 1: Auto-create org on signup

**Files:**
- Modify: `src/routes/admin.js` (POST `/signup`, ~line 89-126)
- Test: `tests/tenancy.test.js`

- [ ] **Step 1: Write failing test** — after signup, the new user has exactly one
  org membership with role `admin`, and `req.session.activeOrgId` is set.

```javascript
test('signup creates a personal org with the user as admin', async () => {
  const agent = request.agent(app);
  await agent.post('/admin/signup').type('form')
    .send({ email: 'newco@sap.com', password: 'password123', confirm: 'password123' });
  const { rows: u } = await getDb().query('SELECT id FROM users WHERE email = $1', ['newco@sap.com']);
  const { rows: m } = await getDb().query(
    'SELECT o.name, m.role FROM org_memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1',
    [u[0].id]
  );
  expect(m).toHaveLength(1);
  expect(m[0].role).toBe('admin');
});
```

- [ ] **Step 2: Run it, watch it fail** (signup creates no org yet).

- [ ] **Step 3: Implement** — in the signup transaction, after inserting the user:
  create an organization (name defaults to the email local-part + "'s Organization",
  editable later), insert an `admin` membership, set `req.session.activeOrgId`.
  Wrap user + org + membership inserts in one transaction so a failure leaves no
  orphan user.

```javascript
// inside POST /signup, after computing id/passwordHash, replace the single
// INSERT with a transaction:
const client = await getDb().connect();
try {
  await client.query('BEGIN');
  await client.query('INSERT INTO users (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)',
    [id, email, passwordHash, now]);
  const orgId = nanoid(12);
  const orgName = `${email.split('@')[0]}'s Organization`;
  await client.query('INSERT INTO organizations (id, name, created_at) VALUES ($1,$2,$3)',
    [orgId, orgName, now]);
  await client.query(
    'INSERT INTO org_memberships (id, org_id, user_id, role, created_at) VALUES ($1,$2,$3,$4,$5)',
    [nanoid(12), orgId, id, 'admin', now]);
  await client.query('COMMIT');
  req.session.userId = id;
  req.session.activeOrgId = orgId;
} catch (e) { await client.query('ROLLBACK'); throw e; }
finally { client.release(); }
```

- [ ] **Step 4: Run test, expect pass.**
- [ ] **Step 5: Commit** — `feat(signup): auto-create personal org on self-serve signup`.

---

## Task 2: Member invitations

**Files:**
- Create: `src/routes/invites.js` (or extend admin.js)
- Modify: `src/db.js` (new `org_invitations` table)
- Create: `src/views/admin-members.html`
- Test: `tests/invites.test.js`

- [ ] **Step 1:** Schema — `org_invitations(id, org_id, email, role, token, created_at, accepted_at)`.
- [ ] **Step 2:** Admin-only `POST /admin/org/invites` creates an invite (token = nanoid(24)),
  returns an invite link `${BASE_URL}/admin/invites/:token`.
- [ ] **Step 3:** `GET /admin/invites/:token` — if the visitor is logged in and their
  email matches, add membership + mark accepted; else route through signup/login first.
- [ ] **Step 4:** Domain check: invited email domain must still be in
  `config.allowedEmailDomains` (unless we relax that for invitees — decide then).
- [ ] **Step 5:** Members management page listing memberships with role controls
  (admin can change role / remove members; cannot remove the last admin).
- [ ] **Step 6:** Tests: invite → accept → membership exists; last-admin-removal blocked.
- [ ] **Step 7:** Commit.

---

## Task 3: Org switcher (multi-membership UX)

- [ ] Small header dropdown listing the user's orgs; selecting one sets
  `req.session.activeOrgId` (POST `/admin/org/switch`, membership-checked).
- [ ] All org-scoped queries already read `req.orgId`, so no query changes needed.
- [ ] Test: user in two orgs switches; prototype list changes accordingly.

## Notes / open questions for when this is picked up
- Should invited users bypass the `allowedEmailDomains` gate? (Likely yes — the
  invite itself is the authorization.)
- Personal-org naming + rename UI.
- Rate-limit invite creation to prevent spam.
