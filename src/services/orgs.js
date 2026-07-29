// src/services/orgs.js
// Organization membership + role resolution (P1 multi-tenancy). The tenant
// boundary is the org: a prototype belongs to an org (prototypes.org_id), and a
// user's access is decided by their role in that org (org_memberships).
//
// Roles (this phase): 'admin' (full control of prototypes + org) and 'viewer'
// (read org prototypes/feedback + add comments; no writes, no org management).
// A future plan splits admin into owner/member — see
// docs/superpowers/plans/2026-07-29-future-owner-member-roles.md.
const { getDb } = require('../db');

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
// membership. Used to set req.session.activeOrgId at login/signup when the user
// has not explicitly picked an org.
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

// Middleware: require an authenticated user who is a member of their active org.
// Sets req.orgId + req.orgRole. 401 if not logged in, 403 if no active-org
// membership. If the session has no activeOrgId yet (e.g. an old session from
// before P1), fall back to the user's default org and persist it.
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

module.exports = { membership, defaultOrgId, getOrgPrototype, requireOrg, requireAdmin };
