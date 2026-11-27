// src/services/orgs.js
// Organization membership + role resolution + org management (invites, roles,
// members, rename/delete) + the shared effective-reviewer-access resolver. The
// tenant boundary is the org: a prototype belongs to an org (prototypes.org_id),
// and a user's access is decided by their role in that org (org_memberships).
//
// Roles (this phase): 'admin' (full control of prototypes + org) and 'viewer'
// (read org prototypes/feedback + add comments; no writes, no org management).
// The two-role model + capability matrix is enforced in the routes (admin.js,
// api.js) and this service; last-admin protection lives HERE (setRole /
// removeMember / deleteOrg), so there is one place to widen it when the
// owner/member split is picked up.
//
// EFFECTIVE REVIEWER ACCESS (Task 6): effectiveReviewerAccess(prototypeId, email)
// is the single resolver shared by the share-link entry (delivery.js), delivery
// reads, the member-view entry, and the /api feedback routes. An email qualifies
// via an explicit allowlist row OR as the canonical users.email of a CURRENT
// admin/viewer membership in prototype.org_id. Membership in another org grants
// nothing. It is re-checked on every protected read/write, so a removed member /
// revoked allowlist entry loses access on the next request.
//
// CONCURRENCY INVARIANTS (management writes): any action that can change who is
// an admin — setRole, removeMember, acceptInvite, createOrg, deleteOrg — runs in
// a single transaction on ONE checked-out client, BEGIN..COMMIT/ROLLBACK. Inside
// it we:
//   1. SELECT ... FOR UPDATE the organizations row (serialises concurrent
//      management of the same org — lock order is ALWAYS org first, then the
//      invitation/membership row), then
//   2. recheck the ACTOR's admin role inside the txn (authorization can't be
//      trusted to a read taken before the lock), then
//   3. count the REMAINING admins inside the txn and throw LastAdminError if the
//      action would drop the org below one admin.
// deleteOrg also validates the typed confirmation against the LOCKED org name and
// enqueues durable storage cleanup in the same transaction as the row deletes.
const { nanoid } = require('nanoid');
const { getDb } = require('../db');
const config = require('../config');

// Thrown when an action (role change / removal) would leave an org with zero
// admins. Callers map it to a 409 (conflict) rather than a 500. `code` lets a
// caller branch without string-matching the message.
class LastAdminError extends Error {
  constructor(message = 'An organization must keep at least one admin.') {
    super(message);
    this.name = 'LastAdminError';
    this.code = 'LAST_ADMIN';
  }
}

// Thrown when the actor is not an admin of the org they are trying to manage.
class NotAuthorizedError extends Error {
  constructor(message = 'Requires admin role.') {
    super(message);
    this.name = 'NotAuthorizedError';
    this.code = 'NOT_AUTHORIZED';
  }
}

// Thrown when an invite token is unknown, already terminal, or does not match
// the accepting user's email.
class InvalidInviteError extends Error {
  constructor(message = 'Invalid or expired invitation.') {
    super(message);
    this.name = 'InvalidInviteError';
    this.code = 'INVALID_INVITE';
  }
}

const now = () => new Date().toISOString();

// Invite lifetime: product decision #9. createInvite/reissueInvite stamp
// expires_at = now + INVITE_TTL_MS; acceptInvite rejects once it is past.
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const inviteExpiry = () => new Date(Date.now() + INVITE_TTL_MS).toISOString();

// Is `email`'s domain permitted to hold an account? The same gate used at
// signup/org-creation; re-checked at acceptInvite so an invite can never be the
// path by which a non-allowlisted domain lands a membership.
function emailDomainAllowed(email) {
  const domain = (email || '').split('@')[1] || '';
  return config.allowedEmailDomains.includes(domain);
}

// Run `fn(client)` inside a BEGIN..COMMIT, rolling back (and re-throwing) on any
// error. ONE checked-out client is used for the whole unit of work so FOR UPDATE
// row locks are actually held across the statements that depend on them.
async function withTx(fn) {
  const client = await getDb().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Lock the org row FOR UPDATE and assert the actor is an admin of it — both on
// the supplied in-transaction client, so the check reflects state no other txn
// can change until we commit. Returns nothing; throws NotAuthorizedError if the
// org is missing or the actor is not an admin.
async function lockOrgAsAdmin(client, actorUserId, orgId) {
  const { rows: org } = await client.query(
    'SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
  if (!org[0]) throw new NotAuthorizedError();
  const { rows: m } = await client.query(
    'SELECT role FROM org_memberships WHERE org_id = $1 AND user_id = $2', [orgId, actorUserId]);
  if (!m[0] || m[0].role !== 'admin') throw new NotAuthorizedError();
}

// Count current admins of an org (on the given client, inside the txn).
async function countAdmins(client, orgId) {
  const { rows } = await client.query(
    "SELECT COUNT(*)::int AS n FROM org_memberships WHERE org_id = $1 AND role = 'admin'", [orgId]);
  return rows[0].n;
}

// Resolve a user's role in an org, or null if they are not a member.
async function membership(userId, orgId) {
  if (!userId || !orgId) return null;
  const { rows } = await getDb().query(
    'SELECT role FROM org_memberships WHERE user_id = $1 AND org_id = $2',
    [userId, orgId]
  );
  return rows[0] ? { role: rows[0].role } : null;
}

// The org a user should act in by default: their most-recently-created
// membership. Used to set req.session.activeOrgId at login when the user has
// not explicitly picked an org.
async function defaultOrgId(userId) {
  const { rows } = await getDb().query(
    'SELECT org_id FROM org_memberships WHERE user_id = $1 ORDER BY created_at DESC, org_id DESC LIMIT 1',
    [userId]
  );
  return rows[0] ? rows[0].org_id : null;
}

// A prototype fetched only if it belongs to `orgId`. Returns null on miss OR
// cross-org access, so `if (!proto) 404` turns another org's prototype into a
// 404 (don't reveal its existence). `columns` is always a fixed internal string.
async function getOrgPrototype(id, orgId, columns = '*') {
  if (!orgId) return null;
  const { rows } = await getDb().query(
    `SELECT ${columns} FROM prototypes WHERE id = $1 AND org_id = $2`,
    [id, orgId]
  );
  return rows[0] || null;
}

// --- Org management service ---------------------------------------------------

// Create a new org and make the creator its first admin. User + org + membership
// run in one transaction so a failure leaves no orphan org without an admin.
// Returns { id, name }.
async function createOrg(userId, name) {
  const orgName = (name || '').trim();
  if (!userId) throw new NotAuthorizedError('A user is required to create an org.');
  if (!orgName) throw new Error('Organization name is required.');
  return withTx(async (client) => {
    const orgId = nanoid(12);
    const nowIso = now();
    await client.query(
      'INSERT INTO organizations (id, name, created_at) VALUES ($1,$2,$3)',
      [orgId, orgName, nowIso]);
    await client.query(
      `INSERT INTO org_memberships (id, org_id, user_id, role, created_at)
       VALUES ($1,$2,$3,'admin',$4)`,
      [nanoid(12), orgId, userId, nowIso]);
    return { id: orgId, name: orgName };
  });
}

// List the orgs a user belongs to, with their role in each. Ordered by
// membership recency (newest first) so the UI can default to the latest.
async function listUserOrgs(userId) {
  const { rows } = await getDb().query(
    `SELECT o.id, o.name, m.role, m.created_at
       FROM org_memberships m
       JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1
      ORDER BY m.created_at DESC, o.id DESC`,
    [userId]);
  return rows;
}

// List an org's members (user id, email, role, joined-at).
async function listMembers(orgId) {
  const { rows } = await getDb().query(
    `SELECT u.id AS user_id, u.email, m.role, m.created_at
       FROM org_memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1
      ORDER BY m.created_at ASC, u.email ASC`,
    [orgId]);
  return rows;
}

// Change a member's role. Admin-only. Guards (all inside ONE txn, after locking
// the org row): actor must still be an admin; demoting the last remaining admin
// is refused with LastAdminError. Demotion from admin -> viewer revokes that
// user's API tokens for this org in the SAME transaction (a demoted user must
// lose machine access atomically, so a token can't outlive the privilege).
async function setRole(actorUserId, orgId, targetUserId, newRole) {
  if (newRole !== 'admin' && newRole !== 'viewer') {
    throw new Error("role must be 'admin' or 'viewer'.");
  }
  return withTx(async (client) => {
    await lockOrgAsAdmin(client, actorUserId, orgId);
    const { rows: target } = await client.query(
      'SELECT role FROM org_memberships WHERE org_id = $1 AND user_id = $2', [orgId, targetUserId]);
    if (!target[0]) throw new Error('That user is not a member of this organization.');
    const currentRole = target[0].role;
    if (currentRole === newRole) return { changed: false };

    // Demoting an admin -> viewer: refuse if they are the last admin.
    if (currentRole === 'admin' && newRole === 'viewer') {
      if ((await countAdmins(client, orgId)) <= 1) throw new LastAdminError();
    }

    await client.query(
      'UPDATE org_memberships SET role = $1 WHERE org_id = $2 AND user_id = $3',
      [newRole, orgId, targetUserId]);

    // Losing admin means losing machine access: revoke this user's org tokens.
    if (currentRole === 'admin' && newRole === 'viewer') {
      await client.query(
        'DELETE FROM api_tokens WHERE org_id = $1 AND user_id = $2', [orgId, targetUserId]);
    }
    return { changed: true };
  });
}

// Remove a member from an org. Admin-only. Refuses to remove the last admin
// (LastAdminError). Revokes that user's API tokens for this org in the SAME
// transaction so machine access dies with the membership.
async function removeMember(actorUserId, orgId, targetUserId) {
  return withTx(async (client) => {
    await lockOrgAsAdmin(client, actorUserId, orgId);
    const { rows: target } = await client.query(
      'SELECT role FROM org_memberships WHERE org_id = $1 AND user_id = $2', [orgId, targetUserId]);
    if (!target[0]) return { removed: false };
    if (target[0].role === 'admin' && (await countAdmins(client, orgId)) <= 1) {
      throw new LastAdminError();
    }
    await client.query(
      'DELETE FROM api_tokens WHERE org_id = $1 AND user_id = $2', [orgId, targetUserId]);
    await client.query(
      'DELETE FROM org_memberships WHERE org_id = $1 AND user_id = $2', [orgId, targetUserId]);
    return { removed: true };
  });
}

// --- Invitations --------------------------------------------------------------

// Create a pending invite for `email` to join `orgId` at `role`. Admin-only. The
// token is nanoid(24), the opaque handle in the invite link. At most one PENDING
// invite per (org, email) — enforced by uq_invites_pending; a duplicate pending
// invite surfaces as a 23505, which we translate to a typed error. Returns
// { id, token, email, role }.
async function createInvite(actorUserId, orgId, email, role) {
  const normEmail = (email || '').trim().toLowerCase();
  if (!normEmail) throw new Error('An email is required to invite.');
  if (role !== 'admin' && role !== 'viewer') throw new Error("role must be 'admin' or 'viewer'.");
  if (!emailDomainAllowed(normEmail)) {
    const err = new Error('That email domain is not permitted.');
    err.code = 'DOMAIN_NOT_ALLOWED';
    throw err;
  }
  return withTx(async (client) => {
    await lockOrgAsAdmin(client, actorUserId, orgId);
    const id = nanoid(12);
    const token = nanoid(24);
    try {
      await client.query(
        `INSERT INTO org_invitations (id, org_id, email, role, token, status, invited_by, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8)`,
        [id, orgId, normEmail, role, token, actorUserId, now(), inviteExpiry()]);
    } catch (e) {
      if (e.code === '23505') {
        const err = new Error('A pending invitation for that email already exists.');
        err.code = 'INVITE_EXISTS';
        throw err;
      }
      throw e;
    }
    return { id, token, email: normEmail, role };
  });
}

// Reissue an invite: revoke the referenced PENDING invite and create a fresh one
// (new token) for the same email+role, atomically. Lets an admin rotate a leaked
// or lost invite link. Admin-only. Returns the new { id, token, email, role }.
async function reissueInvite(actorUserId, orgId, inviteId) {
  return withTx(async (client) => {
    await lockOrgAsAdmin(client, actorUserId, orgId);
    const { rows: inv } = await client.query(
      'SELECT id, email, role, status FROM org_invitations WHERE id = $1 AND org_id = $2 FOR UPDATE',
      [inviteId, orgId]);
    if (!inv[0]) throw new InvalidInviteError('Invitation not found.');
    if (inv[0].status !== 'pending') {
      throw new InvalidInviteError('Only a pending invitation can be reissued.');
    }
    const nowIso = now();
    // Revoke the old one first so uq_invites_pending frees up for the new row.
    await client.query(
      "UPDATE org_invitations SET status = 'revoked', revoked_at = $1 WHERE id = $2",
      [nowIso, inviteId]);
    const id = nanoid(12);
    const token = nanoid(24);
    await client.query(
      `INSERT INTO org_invitations (id, org_id, email, role, token, status, invited_by, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8)`,
      [id, orgId, inv[0].email, inv[0].role, token, actorUserId, nowIso, inviteExpiry()]);
    return { id, token, email: inv[0].email, role: inv[0].role };
  });
}

// List an org's invitations. `status` optionally filters (e.g. 'pending'). The
// token is included so an admin UI can re-render/copy a pending invite link;
// this listing is only ever reached behind an admin guard.
async function listInvites(orgId, status = null) {
  if (status) {
    const { rows } = await getDb().query(
      `SELECT id, org_id, email, role, status, token, invited_by, created_at, accepted_at, revoked_at
         FROM org_invitations WHERE org_id = $1 AND status = $2 ORDER BY created_at DESC`,
      [orgId, status]);
    return rows;
  }
  const { rows } = await getDb().query(
    `SELECT id, org_id, email, role, status, token, invited_by, created_at, accepted_at, revoked_at
       FROM org_invitations WHERE org_id = $1 ORDER BY created_at DESC`,
    [orgId]);
  return rows;
}

// Revoke a pending invite. Admin-only. No-op (returns { revoked: false }) if the
// invite is unknown or already terminal.
async function revokeInvite(actorUserId, orgId, inviteId) {
  return withTx(async (client) => {
    await lockOrgAsAdmin(client, actorUserId, orgId);
    const { rows } = await client.query(
      "UPDATE org_invitations SET status = 'revoked', revoked_at = $1 " +
      "WHERE id = $2 AND org_id = $3 AND status = 'pending' RETURNING id",
      [now(), inviteId, orgId]);
    return { revoked: rows.length > 0 };
  });
}

// Accept an invite by token. The accepting user must be logged in and their
// email must match the invite's email. Lock order: org row FIRST, then the
// invitation row — both FOR UPDATE — so a concurrent revoke/accept can't race.
// On success: inserts (or upgrades) the membership and marks the invite
// accepted, atomically. Returns { orgId, role }. Throws InvalidInviteError if
// the token is unknown, already terminal, or the email does not match.
async function acceptInvite(userId, token, userEmail) {
  const normEmail = (userEmail || '').trim().toLowerCase();
  if (!userId) throw new NotAuthorizedError('Must be logged in to accept an invite.');
  return withTx(async (client) => {
    // Find the invite (not yet locked) to learn its org, so we can take the org
    // lock FIRST (lock order: org, then invitation).
    const { rows: pre } = await client.query(
      'SELECT org_id FROM org_invitations WHERE token = $1', [token]);
    if (!pre[0]) throw new InvalidInviteError();
    const orgId = pre[0].org_id;

    await client.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
    const { rows: inv } = await client.query(
      'SELECT id, org_id, email, role, status, expires_at FROM org_invitations WHERE token = $1 FOR UPDATE', [token]);
    if (!inv[0] || inv[0].status !== 'pending') throw new InvalidInviteError();
    if (inv[0].email !== normEmail) throw new InvalidInviteError('This invitation was issued to a different email.');
    // Expiry (decision #9). A NULL expires_at is a legacy invite issued before the
    // column existed — treated as non-expiring so we don't retroactively break it.
    if (inv[0].expires_at && Date.now() > new Date(inv[0].expires_at).getTime()) {
      throw new InvalidInviteError('This invitation has expired. Ask an admin to reissue it.');
    }
    // Domain gate re-checked at accept time: the invite must never be the path by
    // which a non-allowlisted domain lands a membership (defence in depth — the
    // email is also gated at signup and at createInvite).
    if (!emailDomainAllowed(normEmail)) {
      throw new InvalidInviteError('That email domain is not permitted.');
    }

    const nowIso = now();
    // Insert the membership, or upgrade an existing viewer to the invited role.
    await client.query(
      `INSERT INTO org_memberships (id, org_id, user_id, role, created_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [nanoid(12), inv[0].org_id, userId, inv[0].role, nowIso]);
    await client.query(
      "UPDATE org_invitations SET status = 'accepted', accepted_at = $1 WHERE id = $2",
      [nowIso, inv[0].id]);
    return { orgId: inv[0].org_id, role: inv[0].role };
  });
}

// --- Org read / rename / delete (Task 5) -------------------------------------

// Read a single org row (id, name, created_at) or null.
async function getOrg(orgId) {
  if (!orgId) return null;
  const { rows } = await getDb().query(
    'SELECT id, name, created_at FROM organizations WHERE id = $1', [orgId]);
  return rows[0] || null;
}

// Count the ProtoLab-owned resources an org deletion would remove, for the
// confirmation screen (so an admin sees what is at stake before typing the name).
async function countOrgResources(orgId) {
  const { rows } = await getDb().query(
    `SELECT
       (SELECT COUNT(*)::int FROM prototypes      WHERE org_id = $1) AS prototypes,
       (SELECT COUNT(*)::int FROM api_tokens      WHERE org_id = $1) AS tokens,
       (SELECT COUNT(*)::int FROM org_memberships WHERE org_id = $1) AS members`,
    [orgId]);
  return rows[0];
}

// Rename an org. Admin-only, serialized under the org lock + actor recheck.
async function renameOrg(actorUserId, orgId, name) {
  const newName = (name || '').trim();
  if (!newName) throw new Error('Organization name is required.');
  return withTx(async (client) => {
    await lockOrgAsAdmin(client, actorUserId, orgId);
    await client.query('UPDATE organizations SET name = $1 WHERE id = $2', [newName, orgId]);
    return { id: orgId, name: newName };
  });
}

// Delete an org and every ProtoLab asset it owns, in ONE transaction. Admin-only.
// Guards: lock the org row, recheck the actor is still an admin, and validate the
// caller typed the org's EXACT current name (checked against the LOCKED row, so a
// concurrent rename can't let a stale confirmation through). Then:
//   1. Gather every stored object key (version files + legacy top-level filename +
//      comment screenshots) and ENQUEUE them into storage_cleanup_queue in the
//      same transaction (durable: survives the row deletes and a crash; drained
//      out-of-band by the cleanup runner, idempotently).
//   2. Delete the org's api_tokens and prototypes explicitly (restrictive FKs),
//      letting prototype-child cascades (versions/comments/explanations/allowlist/
//      telemetry) and org-child cascades (memberships/invitations) fire.
//   3. Delete the organization row.
// Returns { deleted:true, enqueued:<n> }. Throws NotAuthorizedError (missing org
// or non-admin actor) or a DELETE_NAME_MISMATCH-coded Error (wrong confirmation).
async function deleteOrg(actorUserId, orgId, confirmName) {
  return withTx(async (client) => {
    // Lock + authorize against the live row.
    const { rows: org } = await client.query(
      'SELECT id, name FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
    if (!org[0]) throw new NotAuthorizedError();
    const { rows: m } = await client.query(
      'SELECT role FROM org_memberships WHERE org_id = $1 AND user_id = $2', [orgId, actorUserId]);
    if (!m[0] || m[0].role !== 'admin') throw new NotAuthorizedError();

    // Server-side exact-name confirmation, validated against the LOCKED row.
    if ((confirmName || '').trim() !== org[0].name) {
      const err = new Error('The confirmation text does not match the organization name.');
      err.code = 'DELETE_NAME_MISMATCH';
      throw err;
    }

    // 1. Inventory every stored object key for this org and enqueue cleanup.
    const { rows: verFiles } = await client.query(
      `SELECT pv.filename FROM prototype_versions pv
         JOIN prototypes p ON p.id = pv.prototype_id WHERE p.org_id = $1`, [orgId]);
    const { rows: protoFiles } = await client.query(
      'SELECT filename FROM prototypes WHERE org_id = $1', [orgId]);
    const { rows: shots } = await client.query(
      `SELECT c.screenshot_key FROM comments c
         JOIN prototypes p ON p.id = c.prototype_id
        WHERE p.org_id = $1 AND c.screenshot_key IS NOT NULL`, [orgId]);

    const nowIso = now();
    const seen = new Set();
    let enqueued = 0;
    const enqueue = async (kind, key) => {
      if (!key || seen.has(`${kind}:${key}`)) return;
      seen.add(`${kind}:${key}`);
      await client.query(
        `INSERT INTO storage_cleanup_queue (id, kind, object_key, status, attempts, next_attempt_at, created_at)
         VALUES ($1,$2,$3,'pending',0,$4,$4)`,
        [nanoid(12), kind, key, nowIso]);
      enqueued++;
    };
    for (const r of verFiles) await enqueue('prototype', r.filename);
    for (const r of protoFiles) await enqueue('prototype', r.filename);
    for (const r of shots) await enqueue('screenshot', r.screenshot_key);

    // 2. Delete the restrictive-FK children explicitly, then 3. the org.
    await client.query('DELETE FROM api_tokens WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM prototypes WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    return { deleted: true, enqueued };
  });
}

// --- Effective reviewer access (Task 6) --------------------------------------

// Normalize an email the same way everywhere access is decided: trim + lowercase.
function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

// Decide whether `email` may review `prototypeId` as a share-link reviewer. An
// email qualifies when EITHER:
//   (a) it has an explicit allowlist row for the prototype, OR
//   (b) it matches the canonical users.email of a CURRENT admin/viewer membership
//       in the prototype's OWNING org (prototype.org_id).
// Both sides are normalized (trim+lowercase). Membership in ANOTHER org grants
// nothing — the join is pinned to prototype.org_id. Rechecked on every protected
// read/write so a removed member / revoked allowlist entry loses access on the
// next request. Returns { allowed, source } where source is 'allowlist' |
// 'membership' | null (source is informational, e.g. for removal messaging).
async function effectiveReviewerAccess(prototypeId, email) {
  const norm = normalizeEmail(email);
  if (!prototypeId || !norm) return { allowed: false, source: null };
  // (a) explicit allowlist row.
  const { rows: allow } = await getDb().query(
    'SELECT 1 FROM allowlist WHERE prototype_id = $1 AND LOWER(email) = $2 LIMIT 1',
    [prototypeId, norm]);
  if (allow.length) return { allowed: true, source: 'allowlist' };
  // (b) current admin/viewer membership in the prototype's owning org.
  const { rows: member } = await getDb().query(
    `SELECT 1 FROM prototypes p
       JOIN org_memberships m ON m.org_id = p.org_id
       JOIN users u ON u.id = m.user_id
      WHERE p.id = $1 AND LOWER(u.email) = $2 LIMIT 1`,
    [prototypeId, norm]);
  if (member.length) return { allowed: true, source: 'membership' };
  return { allowed: false, source: null };
}

// Count the DISTINCT effective reviewer emails for a prototype: the union of its
// explicit allowlist emails and current org admin/viewer emails, deduplicated by
// canonical lowercased email. Also returns the explicit-only count so the UI can
// label "explicit reviewers" separately from the inherited-org set.
async function effectiveReviewerCount(prototypeId) {
  const { rows } = await getDb().query(
    `WITH eff AS (
       SELECT LOWER(email) AS e FROM allowlist WHERE prototype_id = $1
       UNION
       SELECT LOWER(u.email) FROM prototypes p
         JOIN org_memberships m ON m.org_id = p.org_id
         JOIN users u ON u.id = m.user_id
        WHERE p.id = $1
     )
     SELECT
       (SELECT COUNT(*)::int FROM eff) AS effective,
       (SELECT COUNT(DISTINCT LOWER(email))::int FROM allowlist WHERE prototype_id = $1) AS explicit`,
    [prototypeId]);
  return rows[0] || { effective: 0, explicit: 0 };
}

// --- Middleware ---------------------------------------------------------------

// Require an authenticated user, no org required. Mirrors adminAuth.js (userId
// present) but is a named export here so Task-1 routes that act BEFORE an active
// org is chosen (accept-invite, create-org, org switch) can guard on login
// without the requireOrg 403. For JSON/API callers it 401s; browser callers are
// redirected to login.
function requireLogin(req, res, next) {
  if (req.session && req.session.userId) {
    req.userId = req.session.userId;
    return next();
  }
  if (req.accepts(['html', 'json']) === 'json') {
    return res.status(401).json({ error: 'Login required.' });
  }
  return res.redirect('/admin/login');
}

// Middleware: require an authenticated user who is a member of their active org.
// Sets req.orgId + req.orgRole. 401 if not logged in, 403 if no active-org
// membership. If the session has no activeOrgId yet, fall back to the user's
// default org and persist it.
async function requireOrg(req, res, next) {
  try {
    if (!req.session || !req.session.userId) return res.redirect('/admin/login');
    if (!req.session.activeOrgId) {
      req.session.activeOrgId = await defaultOrgId(req.session.userId);
    }
    const m = await membership(req.session.userId, req.session.activeOrgId);
    if (!m) return res.status(403).send('No access to this organization.');
    req.orgId = req.session.activeOrgId;
    req.orgRole = m.role;
    next();
  } catch (err) {
    console.error('requireOrg error:', err);
    res.status(500).send('Internal server error.');
  }
}

// Middleware: requireOrg + admin role. Viewers get 403.
async function requireAdmin(req, res, next) {
  requireOrg(req, res, () => {
    if (req.orgRole !== 'admin') {
      return res.status(403).json({ error: 'Requires admin role.' });
    }
    next();
  });
}

// Canonical org-URL guard (Task 3). Resolves the intended org from the :orgId
// URL parameter — NOT session.activeOrgId — so two browser tabs can each work in
// a different org simultaneously. Requires an authenticated user who is a current
// member of THAT org. Sets req.orgId + req.orgRole from the URL org. 401 (JSON) /
// redirect (browser) when logged out; 403/404-style recovery when not a member.
// On a membership miss the browser is sent to /admin/home (session recovery, Task
// 2 Step 5); JSON/API callers get a typed 403 before any side effect.
async function requireOrgParam(req, res, next) {
  try {
    if (!req.session || !req.session.userId) {
      if (req.accepts(['html', 'json']) === 'json') {
        return res.status(401).json({ error: 'Login required.' });
      }
      return res.redirect('/admin/login');
    }
    const orgId = req.params.orgId;
    const m = await membership(req.session.userId, orgId);
    if (!m) {
      if (req.accepts(['html', 'json']) === 'json') {
        return res.status(403).json({ error: 'No access to this organization.' });
      }
      return res.redirect('/admin/home');
    }
    req.userId = req.session.userId;
    req.orgId = orgId;
    req.orgRole = m.role;
    next();
  } catch (err) {
    console.error('requireOrgParam error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
}

// Canonical org-URL guard + admin role. Viewers get a typed 403.
function requireAdminParam(req, res, next) {
  requireOrgParam(req, res, () => {
    if (req.orgRole !== 'admin') {
      return res.status(403).json({ error: 'Requires admin role.' });
    }
    next();
  });
}

module.exports = {
  // resolution / scoping
  membership,
  defaultOrgId,
  getOrgPrototype,
  // org management
  createOrg,
  listUserOrgs,
  listMembers,
  setRole,
  removeMember,
  getOrg,
  renameOrg,
  deleteOrg,
  countOrgResources,
  // effective reviewer access (Task 6)
  effectiveReviewerAccess,
  effectiveReviewerCount,
  normalizeEmail,
  // invitations
  createInvite,
  reissueInvite,
  listInvites,
  revokeInvite,
  acceptInvite,
  // middleware
  requireLogin,
  requireOrg,
  requireAdmin,
  requireOrgParam,
  requireAdminParam,
  // typed errors
  LastAdminError,
  NotAuthorizedError,
  InvalidInviteError,
};
