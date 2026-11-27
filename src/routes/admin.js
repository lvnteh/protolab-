// src/routes/admin.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { nanoid } = require('nanoid');
const { getDb } = require('../db');
const orgs = require('../services/orgs');
const config = require('../config');
const { injectPreview } = require('../services/inject');
const storage = require('../services/storage');
const markdown = require('../services/markdown');
const apiTokens = require('../services/tokens');
const filetype = require('../services/filetype');
const versions = require('../services/versions');
const annotations = require('../services/annotations');
const storageCleanup = require('../services/storageCleanup');
const { orgCreateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => cb(null, filetype.isAccepted(file.originalname)),
});

function readView(name) {
  return fs.readFileSync(path.join(__dirname, '../views', name), 'utf8');
}

function renderView(name, vars) {
  let html = readView(name);
  for (const [k, v] of Object.entries(vars)) {
    html = html.split(`{{${k}}}`).join(String(v));
  }
  return html;
}

// Render an admin HTML page with the per-session CSRF token always injected.
// The token is placed on res.locals by the csrf middleware; every admin view
// carries a `{{csrfToken}}` placeholder (hidden form input and/or <meta> tag),
// so routing all admin pages through here guarantees the browser can echo it
// back on unsafe requests. When enforcement is off the token is still injected
// but never required, so existing token-less suites are unaffected.
function renderAdmin(res, name, vars = {}) {
  return res.send(renderView(name, { csrfToken: res.locals.csrfToken || '', ...vars }));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Fetch a prototype scoped to an ORG (the tenant boundary since P1). Returns
// null on miss OR cross-org access, so the existing `if (!proto) 404` branches
// turn another org's prototype into a 404 automatically. Thin wrapper over the
// orgs service so call sites read the same as before.
async function getOrgPrototype(id, orgId, columns = '*') {
  return orgs.getOrgPrototype(id, orgId, columns);
}

// Resolve where an authenticated user should land, honoring a validated
// same-application continuation (invite accept / prototype deep link) and the
// zero-org case. Returns a local path string. Never trusts an absolute/offsite
// `next` — only our own `/admin/...` or `/p/...` paths are followed.
async function landingFor(req) {
  const cont = validContinuation(req.session && req.session.continuation);
  if (cont) return cont;
  const userId = req.session.userId;
  const orgs0 = await orgs.listUserOrgs(userId);
  if (!orgs0.length) return '/admin/home';
  // Prefer a stored, still-valid org preference; else the most recent membership.
  let activeOrgId = req.session.activeOrgId;
  if (!activeOrgId || !orgs0.some(o => o.id === activeOrgId)) {
    activeOrgId = orgs0[0].id;
  }
  req.session.activeOrgId = activeOrgId;
  return `/admin/orgs/${activeOrgId}/prototypes`;
}

// A continuation is a validated LOCAL path we may return to after auth. Only our
// own invite-accept and prototype paths are allowed (no open redirect).
function validContinuation(cont) {
  if (typeof cont !== 'string' || !cont.startsWith('/')) return null;
  if (cont.startsWith('//')) return null; // protocol-relative -> offsite
  if (/^\/admin\/invite\/[A-Za-z0-9_-]+$/.test(cont)) return cont;
  if (/^\/p\/[A-Za-z0-9_-]+/.test(cont)) return cont;
  return null;
}

router.get('/login', (req, res) => {
  captureContinuation(req);
  renderAdmin(res, 'admin-login.html', { error: '' });
});

router.post('/login', async (req, res) => {
  const errorHtml = '<div class="alert">Invalid credentials.</div>';
  const email = (req.body.email || '').trim().toLowerCase();
  const { rows } = await getDb().query(
    'SELECT id, password_hash FROM users WHERE email = $1',
    [email]
  );
  const user = rows[0];
  if (!user) return res.status(401).send(renderView('admin-login.html', { error: errorHtml, csrfToken: res.locals.csrfToken || '' }));
  const valid = await bcrypt.compare(req.body.password || '', user.password_hash);
  if (!valid) return res.status(401).send(renderView('admin-login.html', { error: errorHtml, csrfToken: res.locals.csrfToken || '' }));
  req.session.userId = user.id;
  // Land on the stored/most-recent org, honoring any invite/deep-link
  // continuation; a zero-org account goes to the create-or-join home (Task 2).
  res.redirect(await landingFor(req));
});

// POST (not GET) so it can't be triggered by a cross-site <img>/link, and it
// flows through the CSRF guard like every other unsafe admin request. Destroys
// the server-side session (removes the Postgres session row in prod) and clears
// the cookie so a stale sid can't be replayed, then sends the user to login.
router.post('/logout', (req, res) => {
  const finish = () => {
    res.clearCookie('connect.sid');
    res.redirect('/admin/login');
  };
  if (req.session) return req.session.destroy(finish);
  return finish();
});

// Stash a validated same-application continuation (invite accept / deep link)
// onto the session so it survives signup/login and the session regeneration that
// follows. Called from the auth GET pages which carry ?next=<local path>.
function captureContinuation(req) {
  const cont = validContinuation(req.query.next);
  if (cont && req.session) req.session.continuation = cont;
}

router.get('/signup', (req, res) => {
  captureContinuation(req);
  renderAdmin(res, 'admin-signup.html', { error: '' });
});

router.post('/signup', async (req, res) => {
  const err = (msg, status = 400) =>
    res.status(status).send(renderView('admin-signup.html', {
      error: `<div class="alert">${escapeHtml(msg)}</div>`,
      csrfToken: res.locals.csrfToken || '',
    }));

  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const confirm = req.body.confirm || '';

  if (!email || !password || !confirm) return err('All fields are required.');
  if (password !== confirm) return err('Passwords do not match.');
  if (password.length < 8) return err('Password must be at least 8 characters.');

  const domain = email.split('@')[1] || '';
  if (!config.allowedEmailDomains.includes(domain)) {
    return err('That email domain is not permitted.');
  }

  const { rows: existing } = await getDb().query('SELECT 1 FROM users WHERE email = $1', [email]);
  if (existing.length) return err('An account with that email already exists.', 409);

  const id = nanoid(12);
  const passwordHash = bcrypt.hashSync(password, 10);
  try {
    await getDb().query(
      'INSERT INTO users (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)',
      [id, email, passwordHash, new Date().toISOString()]
    );
  } catch (e) {
    // Unique-violation backstop in case of a race between the check and insert.
    if (e.code === '23505') return err('An account with that email already exists.', 409);
    throw e;
  }

  // Org provisioning is invite-driven / self-serve (Task 2): a brand-new signup
  // has no org membership and lands on /admin/home (the create-or-join screen)
  // unless an invitation continuation was preserved through signup, in which case
  // landingFor returns to that invite's confirmation page. Account creation and
  // accepting an invite are SEPARATE actions with their own transactions — we
  // never auto-accept here, so a bare account survives an expired invite.
  req.session.userId = id;
  res.redirect(await landingFor(req));
});

// ====================================================================
// Global account routes (Task 2 / 3 / 4). These act BEFORE or ACROSS an active
// org, so they guard on login only (requireLogin), not org membership.
// ====================================================================

// The create-or-join home. An org-less user lands here; a user with orgs can
// also reach it to create another or switch. Renders their orgs + a create form.
// `reason` surfaces a session-recovery message (e.g. the active org was deleted).
router.get('/home', orgs.requireLogin, async (req, res) => {
  const list = await orgs.listUserOrgs(req.userId);
  const { rows: u } = await getDb().query('SELECT email FROM users WHERE id = $1', [req.userId]);
  const reason = req.query.reason === 'no-org'
    ? '<div class="alert">The organization you were working in is no longer available. Pick another or create one.</div>'
    : '';
  renderAdmin(res, 'admin-home.html', {
    email: escapeHtml(u[0] ? u[0].email : ''),
    orgsJson: JSON.stringify(list).replace(/</g, '\\u003c'),
    reason,
  });
});

// Create an org (self-serve). Validates the name and the account's canonical
// email domain, creates the org (creator = admin), sets the active-org
// preference, and redirects to the new org's canonical prototype list.
router.post('/orgs', orgs.requireLogin, orgCreateLimiter, async (req, res) => {
  const name = (req.body.name || '').trim();
  const { rows: u } = await getDb().query('SELECT email FROM users WHERE id = $1', [req.userId]);
  const email = (u[0] && u[0].email) || '';
  const domain = email.split('@')[1] || '';
  const wantsJson = req.accepts(['html', 'json']) === 'json';
  const fail = (msg, status = 400) => wantsJson
    ? res.status(status).json({ error: msg })
    : res.status(status).send(renderView('admin-home.html', {
        email: escapeHtml(email),
        orgsJson: '[]',
        reason: `<div class="alert">${escapeHtml(msg)}</div>`,
        csrfToken: res.locals.csrfToken || '',
      }));
  if (!name) return fail('Organization name is required.');
  if (!config.allowedEmailDomains.includes(domain)) {
    return fail('Your account email domain is not permitted to create organizations.', 403);
  }
  const org = await orgs.createOrg(req.userId, name);
  req.session.activeOrgId = org.id;
  if (wantsJson) return res.status(201).json({ id: org.id, name: org.name, redirect: `/admin/orgs/${org.id}/prototypes` });
  res.redirect(`/admin/orgs/${org.id}/prototypes`);
});

// Switch the DEFAULT landing org preference (session.activeOrgId). Validated
// through membership so a user can't set an org they don't belong to. Other tabs
// keep their explicit URL org context — this only changes the default landing.
router.post('/orgs/switch', orgs.requireLogin, async (req, res) => {
  const orgId = (req.body.orgId || '').trim();
  const m = await orgs.membership(req.userId, orgId);
  if (!m) return res.status(403).json({ error: 'No access to this organization.' });
  req.session.activeOrgId = orgId;
  const wantsJson = req.accepts(['html', 'json']) === 'json';
  if (wantsJson) return res.json({ ok: true, redirect: `/admin/orgs/${orgId}/prototypes` });
  res.redirect(`/admin/orgs/${orgId}/prototypes`);
});

// Direct /admin lands an authenticated user without asking them to log in again.
router.get('/', async (req, res) => {
  if (req.session && req.session.userId) return res.redirect(await landingFor(req));
  res.redirect('/admin/login');
});

// ====================================================================
// Invitations (Task 4). The token identifies the org, so an org-less user can
// accept. GET is public (logged-out visitors preserve a continuation through
// auth); POST accept requires login + CSRF.
// ====================================================================

router.get('/invite/:token', async (req, res) => {
  const token = req.params.token;
  const { rows } = await getDb().query(
    `SELECT i.org_id, i.email, i.role, i.status, o.name AS org_name
       FROM org_invitations i JOIN organizations o ON o.id = i.org_id
      WHERE i.token = $1`, [token]);
  const inv = rows[0];
  const render = (vars) => renderAdmin(res, 'admin-invite.html', {
    orgName: '', role: '', inviteEmail: '', accountEmail: '', token: escapeHtml(token),
    state: 'ok', message: '', loggedIn: '', ...vars,
  });

  if (!inv) {
    return res.status(404).send(renderView('admin-invite.html', {
      csrfToken: res.locals.csrfToken || '', orgName: '', role: '', inviteEmail: '',
      accountEmail: '', token: escapeHtml(token), loggedIn: '', state: 'invalid',
      message: 'This invitation link is not valid. Ask an organization admin for a new one.',
    }));
  }
  const stateMsg = inv.status === 'accepted' ? 'This invitation has already been accepted.'
    : inv.status === 'revoked' ? 'This invitation has been revoked. Ask an admin to reissue it.'
    : '';
  const loggedIn = !!(req.session && req.session.userId);
  let accountEmail = '';
  if (loggedIn) {
    const { rows: u } = await getDb().query('SELECT email FROM users WHERE id = $1', [req.session.userId]);
    accountEmail = (u[0] && u[0].email) || '';
  } else {
    // Preserve the invitation continuation so signup/login returns here.
    req.session.continuation = `/admin/invite/${token}`;
  }
  render({
    orgName: escapeHtml(inv.org_name),
    role: escapeHtml(inv.role),
    inviteEmail: escapeHtml(inv.email),
    accountEmail: escapeHtml(accountEmail),
    loggedIn: loggedIn ? '1' : '',
    state: inv.status === 'pending' ? 'ok' : 'terminal',
    message: stateMsg,
  });
});

// Confirm an invitation (explicit POST action). requireLogin + CSRF. Sets the
// active org only AFTER the accept commit, clears the continuation, and redirects
// to the joined org's prototype list.
router.post('/invite/:token/accept', orgs.requireLogin, async (req, res) => {
  const { rows: u } = await getDb().query('SELECT email FROM users WHERE id = $1', [req.userId]);
  const userEmail = (u[0] && u[0].email) || '';
  try {
    const { orgId } = await orgs.acceptInvite(req.userId, req.params.token, userEmail);
    req.session.activeOrgId = orgId;
    if (req.session.continuation === `/admin/invite/${req.params.token}`) {
      delete req.session.continuation;
    }
    const wantsJson = req.accepts(['html', 'json']) === 'json';
    if (wantsJson) return res.json({ ok: true, orgId, redirect: `/admin/orgs/${orgId}/prototypes` });
    res.redirect(`/admin/orgs/${orgId}/prototypes?joined=1`);
  } catch (err) {
    if (err instanceof orgs.InvalidInviteError) {
      return res.status(409).send(renderView('admin-invite.html', {
        csrfToken: res.locals.csrfToken || '', orgName: '', role: '', inviteEmail: '',
        accountEmail: escapeHtml(userEmail), token: escapeHtml(req.params.token), loggedIn: '1',
        state: 'invalid', message: escapeHtml(err.message),
      }));
    }
    throw err;
  }
});

// ====================================================================
// Org-scoped resources (prototypes, tokens, members, settings).
//
// Canonical URLs live under `/admin/orgs/:orgId/...` (Task 3). Each handler is
// defined ONCE and registered on BOTH:
//   * `orgRouter` — mounted at `/orgs/:orgId`, guarded by requireOrgParam /
//     requireAdminParam (org resolved from the URL — two tabs, two orgs).
//   * the legacy `router` under `/prototypes...`/`/tokens...`, guarded by the
//     session-based requireOrg / requireAdmin, kept for backward compatibility.
// Legacy READ links redirect to the canonical URL; legacy MUTATION routes still
// work but validate a rendered `expectedOrgId` and reject a mismatch (so a stale
// unscoped form can't post into the wrong org). Both guards set req.orgId /
// req.orgRole / req.userId, so the shared handlers never care which gate ran.
// ====================================================================

const orgRouter = express.Router({ mergeParams: true });

// A legacy unscoped MUTATION must agree with its rendered org if one was carried.
// Absent expectedOrgId = pre-Task-3 session context (allowed); present-and-wrong
// = a stale/forged form targeting another org (409, before any side effect).
function expectedOrgOk(req) {
  const expected = (req.body && req.body.expectedOrgId) || req.get('x-expected-org');
  if (!expected) return true;
  return expected === req.orgId;
}
function rejectOrgMismatch(req, res) {
  if (expectedOrgOk(req)) return false;
  res.status(409).json({ error: 'This action targeted a different organization. Reload and try again.' });
  return true;
}

async function listPrototypesHandler(req, res) {
  const { rows } = await getDb().query(`
    SELECT p.id, p.name, p.share_token, p.created_at,
      (SELECT COUNT(*) FROM access_log WHERE prototype_id = p.id) AS view_count,
      (SELECT COUNT(*) FROM comments   WHERE prototype_id = p.id) AS comment_count
    FROM prototypes p WHERE p.org_id = $1 ORDER BY p.created_at DESC
  `, [req.orgId]);
  // Effective reviewer counts (explicit allowlist ∪ current org members),
  // deduplicated, computed per prototype so the list labels reviewer reach
  // consistently with the settings page (Task 6).
  for (const r of rows) {
    const c = await orgs.effectiveReviewerCount(r.id);
    r.allowlist_count = c.explicit;
    r.effective_reviewer_count = c.effective;
  }
  const navOrgs = await orgs.listUserOrgs(req.userId || req.session.userId);
  res.send(renderView('admin-prototypes.html', {
    prototypesJson: JSON.stringify(rows).replace(/</g, '\\u003c'),
    csrfToken: res.locals.csrfToken || '',
    orgRole: req.orgRole,
    orgId: req.orgId,
    orgName: escapeHtml((navOrgs.find(o => o.id === req.orgId) || {}).name || ''),
    orgsJson: JSON.stringify(navOrgs).replace(/</g, '\\u003c'),
  }));
}

function uploadPageHandler(_req, res) {
  res.send(renderView('admin-upload.html', { success: '', csrfToken: res.locals.csrfToken || '', orgId: res.req.orgId }));
}

async function createPrototypeHandler(req, res) {
  if (rejectOrgMismatch(req, res)) return;
  if (!req.file) return res.status(400).send('Only .html or .md files are accepted.');
  const contentType = filetype.contentTypeForFilename(req.file.originalname) || 'html';
  const id = nanoid(12);
  const shareToken = nanoid(12);
  const filename = `${id}.${filetype.extForContentType(contentType)}`;
  const versionId = nanoid(12);
  await storage.putPrototype(filename, req.file.buffer, filetype.mimeForContentType(contentType));

  const client = await getDb().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO prototypes (id, name, filename, share_token, created_at, owner_id, org_id, content_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, req.body.name || 'Untitled', filename, shareToken, new Date().toISOString(), req.userId || req.session.userId, req.orgId, contentType]
    );
    await client.query(
      `INSERT INTO prototype_versions (id, prototype_id, version, filename, status, created_at, content_type)
       VALUES ($1,$2,1,$3,'published',$4,$5)`,
      [versionId, id, filename, new Date().toISOString(), contentType]
    );
    await client.query('UPDATE prototypes SET published_version_id = $1 WHERE id = $2', [versionId, id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    // Compensate the orphaned object store write on a failed DB commit.
    await storage.deletePrototype(filename).catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const emails = (req.body.allowlist || '').split(/\r?\n/).map(e => e.trim().toLowerCase()).filter(Boolean);
  for (const email of emails) {
    await getDb().query(
      'INSERT INTO allowlist (prototype_id, email) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [id, email]
    );
  }

  const shareLink = `${config.baseUrl}/p/${shareToken}`;
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.json({ id, shareToken, shareLink, name: req.body.name || 'Untitled' });
  }
  const successBanner = `<div class="alert alert-success">Prototype uploaded. Share link: <a href="${shareLink}">${shareLink}</a></div>`;
  res.send(renderView('admin-upload.html', { success: successBanner, csrfToken: res.locals.csrfToken || '', orgId: req.orgId }));
}

async function prototypeDetailHandler(req, res) {
  const proto = await getOrgPrototype(req.params.id, req.orgId);
  if (!proto) return res.status(404).send('Not found.');
  const { rows: allowRows } = await getDb().query('SELECT email FROM allowlist WHERE prototype_id = $1', [proto.id]);
  const allowlist = allowRows.map(r => r.email).join('\n');
  // Inherited (org member) reviewer emails for the settings page's read-only
  // "automatically allowed" section (Task 6). Deduplicated, lowercased.
  const { rows: inheritedRows } = await getDb().query(
    `SELECT DISTINCT LOWER(u.email) AS email FROM org_memberships m
       JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY LOWER(u.email)`, [req.orgId]);
  res.send(renderView('admin-prototype-detail.html', {
    id: proto.id, name: escapeHtml(proto.name), allowlist: escapeHtml(allowlist),
    shareToken: proto.share_token, csrfToken: res.locals.csrfToken || '', orgRole: req.orgRole,
    orgId: req.orgId,
    inheritedReviewers: escapeHtml(inheritedRows.map(r => r.email).join('\n')),
    contentType: proto.content_type || 'html',
    uploadAccept: proto.content_type === 'markdown' ? '.md' : '.html',
  }));
}

async function prototypeSettingsHandler(req, res) {
  if (rejectOrgMismatch(req, res)) return;
  const proto = await getOrgPrototype(req.params.id, req.orgId, 'id');
  if (!proto) return res.status(404).send('Not found.');
  await getDb().query('UPDATE prototypes SET name = $1 WHERE id = $2', [req.body.name || 'Untitled', proto.id]);
  await getDb().query('DELETE FROM allowlist WHERE prototype_id = $1', [proto.id]);
  const emails = (req.body.allowlist || '').split(/\r?\n/).map(e => e.trim().toLowerCase()).filter(Boolean);
  for (const email of emails) {
    await getDb().query(
      'INSERT INTO allowlist (prototype_id, email) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [proto.id, email]
    );
  }
  res.redirect(`/admin/orgs/${req.orgId}/prototypes/${proto.id}?saved=1`);
}

async function createVersionHandler(req, res) {
  if (rejectOrgMismatch(req, res)) return;
  const proto = await getOrgPrototype(req.params.id, req.orgId, 'id, content_type');
  if (!proto) return res.status(404).json({ error: 'Not found.' });
  if (!req.file) return res.status(400).json({ error: 'Only .html or .md files are accepted.' });
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
}

async function publishVersionHandler(req, res) {
  if (rejectOrgMismatch(req, res)) return;
  if (!await getOrgPrototype(req.params.id, req.orgId, 'id')) return res.status(404).json({ error: 'Not found.' });
  const version = parseInt(req.body.version, 10);
  if (Number.isNaN(version)) return res.status(400).json({ error: 'version must be an integer.' });
  try {
    res.json(await versions.setPublished(req.params.id, version));
  } catch (err) {
    if (err.code === 'CONFLICT') return res.status(409).json({ error: err.message });
    throw err;
  }
}

async function allowlistCountHandler(req, res) {
  if (!await getOrgPrototype(req.params.id, req.orgId, 'id')) return res.status(404).json({ error: 'Not found.' });
  // Report the EFFECTIVE (deduplicated) reviewer count — explicit allowlist ∪
  // current org members — plus the explicit-only count (Task 6).
  const c = await orgs.effectiveReviewerCount(req.params.id);
  res.json({ count: c.explicit, effectiveCount: c.effective, explicitCount: c.explicit });
}

async function deletePrototypeHandler(req, res) {
  if (rejectOrgMismatch(req, res)) return;
  const proto = await getOrgPrototype(req.params.id, req.orgId);
  if (!proto) return res.status(404).json({ error: 'Not found.' });
  const { rows: verRows } = await getDb().query(
    'SELECT filename FROM prototype_versions WHERE prototype_id = $1', [proto.id]);
  const files = new Set(verRows.map(r => r.filename));
  files.add(proto.filename);
  for (const filename of files) await storage.deletePrototype(filename);
  const { rows: shotRows } = await getDb().query(
    'SELECT screenshot_key FROM comments WHERE prototype_id = $1 AND screenshot_key IS NOT NULL', [proto.id]);
  await getDb().query('DELETE FROM prototypes WHERE id = $1', [proto.id]);
  for (const r of shotRows) await storage.deleteImage(r.screenshot_key).catch(() => {});
  res.json({ ok: true });
}

async function listCommentsHandler(req, res) {
  if (!await getOrgPrototype(req.params.id, req.orgId, 'id')) return res.status(404).json({ error: 'Not found.' });
  const { pageSize = 25, offset = 0, sortingKey, sortingOrder = 'asc', filterValues = {} } = req.body || {};
  const allowedSort = ['email', 'type', 'created_at'];
  const orderBy = allowedSort.includes(sortingKey) ? sortingKey : 'created_at';
  const order = sortingOrder === 'desc' ? 'DESC' : 'ASC';
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
  const total = parseInt(totalResult.rows[0].n, 10);
  const rows = rowsResult.rows.map(r => {
    const { screenshot_key, ...rest } = r;
    return {
      ...rest,
      hasScreenshot: screenshot_key != null || r.screenshot_thumb != null,
      breadcrumb_display: (() => { try { return r.breadcrumb ? JSON.parse(r.breadcrumb).join(' → ') : ''; } catch { return ''; } })(),
    };
  });
  const parentIds = rows.filter(r => r.type !== 'reply').map(r => r.id);
  let replyRows = [];
  if (parentIds.length) {
    const placeholders = parentIds.map((_, i) => `$${i + 1}`).join(',');
    const rr = await getDb().query(
      `SELECT id, parent_id, email, comment, created_at FROM comments WHERE parent_id IN (${placeholders}) ORDER BY created_at ASC`,
      parentIds);
    replyRows = rr.rows;
  }
  const replyMap = {};
  replyRows.forEach(r => { (replyMap[r.parent_id] ||= []).push(r); });
  res.json({ data: rows.map(r => ({ ...r, replies: replyMap[r.id] || [] })), totalCount: total });
}

async function commentScreenshotHandler(req, res) {
  if (!await getOrgPrototype(req.params.id, req.orgId, 'id')) return res.status(404).send('Not found.');
  const { rows } = await getDb().query(
    'SELECT screenshot_key FROM comments WHERE id = $1 AND prototype_id = $2',
    [req.params.commentId, req.params.id]);
  const key = rows[0] && rows[0].screenshot_key;
  if (!key) return res.status(404).send('Not found.');
  const buffer = await storage.getImage(key);
  if (!buffer) return res.status(404).send('Not found.');
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buffer);
}

async function clearCommentsHandler(req, res) {
  if (rejectOrgMismatch(req, res)) return;
  if (!await getOrgPrototype(req.params.id, req.orgId, 'id')) return res.status(404).json({ error: 'Not found.' });
  const { rows: shotRows } = await getDb().query(
    'SELECT screenshot_key FROM comments WHERE prototype_id = $1 AND screenshot_key IS NOT NULL', [req.params.id]);
  await getDb().query('DELETE FROM comments WHERE prototype_id = $1', [req.params.id]);
  for (const r of shotRows) await storage.deleteImage(r.screenshot_key).catch(() => {});
  res.json({ ok: true });
}

async function deleteCommentHandler(req, res) {
  if (rejectOrgMismatch(req, res)) return;
  if (!await getOrgPrototype(req.params.id, req.orgId, 'id')) return res.status(404).json({ error: 'Not found.' });
  const { rows } = await getDb().query('SELECT id, screenshot_key FROM comments WHERE id = $1 AND prototype_id = $2', [req.params.commentId, req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found.' });
  await getDb().query('DELETE FROM comments WHERE id = $1', [req.params.commentId]);
  if (rows[0].screenshot_key) await storage.deleteImage(rows[0].screenshot_key).catch(() => {});
  res.json({ ok: true });
}

async function accessLogHandler(req, res) {
  if (!await getOrgPrototype(req.params.id, req.orgId, 'id')) return res.status(404).json({ error: 'Not found.' });
  const { pageSize = 25, offset = 0 } = req.body || {};
  const totalResult = await getDb().query('SELECT COUNT(*) AS n FROM access_log WHERE prototype_id = $1', [req.params.id]);
  const total = parseInt(totalResult.rows[0].n, 10);
  const { rows } = await getDb().query(
    'SELECT * FROM access_log WHERE prototype_id = $1 ORDER BY opened_at DESC LIMIT $2 OFFSET $3',
    [req.params.id, parseInt(pageSize, 10), parseInt(offset, 10)]);
  res.json({ data: rows, totalCount: total });
}

async function previewHandler(req, res) {
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
  // HTML previews render EXECUTABLE uploaded markup at the app origin in the
  // admin's own browser. Sandbox it the same way /p/:token/raw is: the CSP
  // `sandbox allow-scripts allow-forms` forces an opaque origin (prototype scripts
  // still run, but it cannot touch the admin's app-origin cookies, storage, or
  // authenticated endpoints) and blocks top navigation. `allow-forms` matches the
  // /raw delivery header and the proto-shell iframe so a prototype with a form
  // previews identically to how it is delivered; the opaque origin still prevents
  // the form from carrying the admin's session. preview.js only reads its own
  // injected DOM + inline data-comments, so it needs no app-origin privilege and
  // works unchanged under the opaque origin. Markdown previews are already
  // sanitized (markdown-it html:false + sanitize-html) and carry no executable
  // author markup, so they are NOT sandboxed here (parity with the markdown
  // delivery view, which keeps its own restrictive CSP).
  if (contentType !== 'markdown') {
    res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-forms');
  }
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
}

async function createTokenHandler(req, res) {
  if (rejectOrgMismatch(req, res)) return;
  const { id, raw } = await apiTokens.createToken(req.userId || req.session.userId, (req.body.name || 'token').slice(0, 60), req.orgId);
  res.status(201).json({ id, token: raw });
}
async function listTokensHandler(req, res) { res.json(await apiTokens.listTokens(req.orgId)); }
async function revokeTokenHandler(req, res) {
  if (rejectOrgMismatch(req, res)) return;
  await apiTokens.revokeToken(req.params.tokenId, req.orgId);
  res.json({ ok: true });
}
// The standalone tokens page was folded into the org Settings (members) page.
// Keep the route as a redirect so old bookmarks / the MCP setup docs still land
// somewhere sensible (the API-tokens card lives on Settings now).
function tokensPageHandler(req, res) {
  res.redirect(`/admin/orgs/${req.orgId}/members`);
}

async function listVersionsHandler(req, res) {
  if (!await getOrgPrototype(req.params.id, req.orgId, 'id')) return res.status(404).json({ error: 'Not found.' });
  res.json(await versions.listAllVersions(req.params.id));
}

async function explanationsHandler(req, res) {
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
}

async function funnelsHandler(req, res) {
  const protoId = req.params.id;
  if (!await getOrgPrototype(protoId, req.orgId, 'id')) return res.status(404).json({ error: 'Not found.' });
  const { rows: events } = await getDb().query(
    'SELECT email, page_url, occurred_at FROM nav_events WHERE prototype_id = $1 ORDER BY email, occurred_at ASC',
    [protoId]);
  const sessions = [];
  const userRoot = {};
  for (const ev of events) { if (!(ev.email in userRoot)) userRoot[ev.email] = ev.page_url; }
  let cur = null;
  for (const ev of events) {
    const isRoot = ev.page_url === userRoot[ev.email];
    if (!cur || ev.email !== cur.email || (isRoot && cur.pages.length > 0)) {
      cur = { email: ev.email, startedAt: ev.occurred_at, pages: [], lastAt: ev.occurred_at };
      sessions.push(cur);
    }
    if (cur.pages[cur.pages.length - 1] !== ev.page_url) cur.pages.push(ev.page_url);
    cur.lastAt = ev.occurred_at;
  }
  const { rows: commentRows } = await getDb().query(
    "SELECT email, created_at FROM comments WHERE prototype_id = $1 AND type = 'element'", [protoId]);
  const journeys = sessions.slice(-50).reverse().map(s => {
    const sStart = new Date(s.startedAt).getTime();
    const sEnd = new Date(s.lastAt || s.startedAt).getTime() + 60000;
    const hadComment = commentRows.some(c => {
      const ct = new Date(c.created_at).getTime();
      return c.email === s.email && ct >= sStart && ct <= sEnd;
    });
    return { email: s.email, startedAt: s.startedAt, pages: s.pages, hadComment };
  });
  const rootPages = new Set(Object.values(userRoot));
  const pagePositions = {};
  for (const s of sessions) {
    s.pages.forEach((page, i) => {
      if (rootPages.has(page)) return;
      (pagePositions[page] ||= []).push(i);
    });
  }
  const pageSessionCount = {};
  for (const s of sessions) {
    const seen = new Set();
    for (const p of s.pages) {
      if (rootPages.has(p)) continue;
      if (!seen.has(p)) { pageSessionCount[p] = (pageSessionCount[p] || 0) + 1; seen.add(p); }
    }
  }
  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const funnelPages = Object.keys(pagePositions).sort((a, b) => median(pagePositions[a]) - median(pagePositions[b]));
  const totalSessions = sessions.length;
  const funnel = funnelPages.map((page, i) => {
    const count = pageSessionCount[page] || 0;
    const pct = totalSessions ? Math.round(count / totalSessions * 100) : 0;
    const prevCount = i === 0 ? count : (pageSessionCount[funnelPages[i - 1]] || 0);
    const dropPct = i === 0 ? 0 : (prevCount ? Math.round((prevCount - count) / prevCount * 100) : 0);
    return { page, sessions: count, pct, dropPct };
  });
  const MAX_INTERVAL_MS = 4 * 60 * 60 * 1000;
  const pageIntervals = {};
  for (const s of sessions) {
    const evs = events.filter(e => e.email === s.email &&
      new Date(e.occurred_at).getTime() >= new Date(s.startedAt).getTime() &&
      new Date(e.occurred_at).getTime() <= new Date(s.lastAt || s.startedAt).getTime() + 60000);
    for (let i = 0; i < evs.length - 1; i++) {
      const dt = Math.min(
        new Date(evs[i + 1].occurred_at).getTime() - new Date(evs[i].occurred_at).getTime(), MAX_INTERVAL_MS);
      if (dt < 0) continue;
      (pageIntervals[evs[i].page_url] ||= []).push(dt);
    }
  }
  const timeOnPage = Object.entries(pageIntervals)
    .filter(([, arr]) => arr.length >= 2)
    .map(([page, arr]) => ({ page, medianMs: Math.round(median(arr)), visits: arr.length }))
    .sort((a, b) => b.visits - a.visits);
  res.json({ funnel, journeys, timeOnPage });
}

// --- Members, settings, org deletion (Task 4 / 5) ---

async function membersPageHandler(req, res) {
  const members = await orgs.listMembers(req.orgId);
  // Only PENDING invites are actionable; revoked/accepted ones are terminal and
  // would just pile up in the list (a fresh revoke/reissue would otherwise leave
  // its old row behind). Show pending only — revoking a row removes it from view.
  const invites = await orgs.listInvites(req.orgId, 'pending');
  const org = await orgs.getOrg(req.orgId);
  const counts = await orgs.countOrgResources(req.orgId);
  const nowIso = new Date().toISOString();
  // A pending invite past its expires_at shows as 'expired' (still reissue-able).
  // expires_at is the authoritative column (set at create/reissue); fall back to
  // created_at + 7d only for legacy rows issued before the column existed.
  const invRows = invites.map(i => {
    const exp = i.expires_at
      || new Date(new Date(i.created_at).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const status = exp < nowIso ? 'expired' : 'pending';
    return {
      id: i.id, email: i.email, role: i.role, status,
      created_at: i.created_at, expires_at: exp,
      link: status === 'pending' ? `${config.baseUrl}/admin/invite/${i.token}` : null,
    };
  });
  renderAdmin(res, 'admin-members.html', {
    orgId: req.orgId,
    orgName: escapeHtml(org ? org.name : ''),
    orgNameJson: JSON.stringify(org ? org.name : ''),
    membersJson: JSON.stringify(members).replace(/</g, '\\u003c'),
    invitesJson: JSON.stringify(invRows).replace(/</g, '\\u003c'),
    counts: JSON.stringify(counts).replace(/</g, '\\u003c'),
    selfUserId: req.userId,
  });
}

async function inviteCreateHandler(req, res) {
  if (rejectOrgMismatch(req, res)) return;
  const email = (req.body.email || '').trim().toLowerCase();
  const role = req.body.role === 'admin' ? 'admin' : 'viewer';
  const domain = email.split('@')[1] || '';
  if (!email) return res.status(400).json({ error: 'An email is required.' });
  if (!config.allowedEmailDomains.includes(domain)) {
    return res.status(400).json({ error: 'That email domain is not permitted.' });
  }
  // Refuse inviting someone who is already a member.
  const { rows: already } = await getDb().query(
    `SELECT 1 FROM org_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1 AND LOWER(u.email) = $2`, [req.orgId, email]);
  if (already.length) return res.status(409).json({ error: 'That person is already a member.' });
  try {
    const inv = await orgs.createInvite(req.userId, req.orgId, email, role);
    res.status(201).json({ id: inv.id, email: inv.email, role: inv.role, link: `${config.baseUrl}/admin/invite/${inv.token}` });
  } catch (e) {
    if (e.code === 'INVITE_EXISTS') return res.status(409).json({ error: 'A pending invitation for that email already exists.' });
    throw e;
  }
}

async function inviteRevokeHandler(req, res) {
  if (rejectOrgMismatch(req, res)) return;
  const { revoked } = await orgs.revokeInvite(req.userId, req.orgId, req.params.inviteId);
  res.json({ ok: true, revoked });
}

async function inviteReissueHandler(req, res) {
  if (rejectOrgMismatch(req, res)) return;
  try {
    const inv = await orgs.reissueInvite(req.userId, req.orgId, req.params.inviteId);
    res.json({ id: inv.id, email: inv.email, role: inv.role, link: `${config.baseUrl}/admin/invite/${inv.token}` });
  } catch (e) {
    if (e instanceof orgs.InvalidInviteError) return res.status(409).json({ error: e.message });
    throw e;
  }
}

async function setMemberRoleHandler(req, res) {
  if (rejectOrgMismatch(req, res)) return;
  const role = req.body.role === 'admin' ? 'admin' : 'viewer';
  try {
    const result = await orgs.setRole(req.userId, req.orgId, req.params.userId, role);
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof orgs.LastAdminError) return res.status(409).json({ error: e.message, code: e.code });
    throw e;
  }
}

async function removeMemberHandler(req, res) {
  if (rejectOrgMismatch(req, res)) return;
  try {
    const result = await orgs.removeMember(req.userId, req.orgId, req.params.userId);
    // If an admin removed THEMSELVES, their active org is gone — steer them home.
    const redirect = req.params.userId === req.userId ? '/admin/home' : null;
    res.json({ ok: true, ...result, redirect });
  } catch (e) {
    if (e instanceof orgs.LastAdminError) return res.status(409).json({ error: e.message, code: e.code });
    throw e;
  }
}

async function renameOrgHandler(req, res) {
  if (rejectOrgMismatch(req, res)) return;
  try {
    const result = await orgs.renameOrg(req.userId, req.orgId, req.body.name);
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof orgs.NotAuthorizedError) return res.status(403).json({ error: e.message });
    return res.status(400).json({ error: e.message });
  }
}

async function deleteOrgHandler(req, res) {
  if (rejectOrgMismatch(req, res)) return;
  try {
    const result = await orgs.deleteOrg(req.userId, req.orgId, req.body.confirmName);
    // Move the actor to a remaining org, or /admin/home after the commit.
    const remaining = await orgs.listUserOrgs(req.userId);
    const redirect = remaining.length ? `/admin/orgs/${remaining[0].id}/prototypes` : '/admin/home';
    if (req.session.activeOrgId === req.orgId) {
      req.session.activeOrgId = remaining.length ? remaining[0].id : null;
    }
    // Best-effort immediate drain of the enqueued cleanup (also drained by the
    // restart-safe runner). Never blocks the response on storage.
    storageCleanup.drainOnce().catch(() => {});
    res.json({ ok: true, ...result, redirect });
  } catch (e) {
    if (e instanceof orgs.NotAuthorizedError) return res.status(403).json({ error: e.message });
    if (e.code === 'DELETE_NAME_MISMATCH') return res.status(409).json({ error: e.message, code: e.code });
    throw e;
  }
}

async function memberOpenHandler(req, res) {
  // Authenticated member-view entry point (Task 6). A current org member opens a
  // prototype with their ACCOUNT identity (no explicit allowlist row needed):
  // seed a reviewer session bound to this prototype using the member's canonical
  // account email (which the effective-access resolver accepts via membership),
  // then hand off to the normal review shell. The server re-checks access on
  // every subsequent read, so a later removal ends access.
  const proto = await getOrgPrototype(req.params.id, req.orgId, 'id, share_token');
  if (!proto) return res.status(404).send('Not found.');
  const { rows: u } = await getDb().query('SELECT email FROM users WHERE id = $1', [req.userId]);
  req.session.customerEmail = ((u[0] && u[0].email) || '').toLowerCase();
  req.session.prototypeId = proto.id;
  res.redirect(`/p/${proto.share_token}/view`);
}
orgRouter.get('/prototypes/:id/open', orgs.requireOrgParam, memberOpenHandler);


orgRouter.get('/prototypes', orgs.requireOrgParam, listPrototypesHandler);
orgRouter.get('/upload', orgs.requireAdminParam, uploadPageHandler);
orgRouter.post('/prototypes', orgs.requireAdminParam, upload.single('file'), createPrototypeHandler);
orgRouter.get('/prototypes/:id', orgs.requireOrgParam, prototypeDetailHandler);
orgRouter.post('/prototypes/:id/settings', orgs.requireAdminParam, prototypeSettingsHandler);
orgRouter.post('/prototypes/:id/versions', orgs.requireAdminParam, upload.single('file'), createVersionHandler);
orgRouter.post('/prototypes/:id/publish', orgs.requireAdminParam, publishVersionHandler);
orgRouter.get('/prototypes/:id/allowlist-count', orgs.requireOrgParam, allowlistCountHandler);
orgRouter.delete('/prototypes/:id', orgs.requireAdminParam, deletePrototypeHandler);
orgRouter.post('/prototypes/:id/comments', orgs.requireOrgParam, listCommentsHandler);
orgRouter.get('/prototypes/:id/comments/:commentId/screenshot', orgs.requireOrgParam, commentScreenshotHandler);
orgRouter.delete('/prototypes/:id/comments', orgs.requireAdminParam, clearCommentsHandler);
orgRouter.delete('/prototypes/:id/comments/:commentId', orgs.requireAdminParam, deleteCommentHandler);
orgRouter.post('/prototypes/:id/access-log', orgs.requireOrgParam, accessLogHandler);
orgRouter.get('/prototypes/:id/preview', orgs.requireOrgParam, previewHandler);
orgRouter.get('/prototypes/:id/versions', orgs.requireOrgParam, listVersionsHandler);
orgRouter.get('/prototypes/:id/explanations', orgs.requireOrgParam, explanationsHandler);
orgRouter.get('/prototypes/:id/funnels', orgs.requireOrgParam, funnelsHandler);
orgRouter.post('/tokens', orgs.requireAdminParam, createTokenHandler);
orgRouter.get('/tokens', orgs.requireAdminParam, listTokensHandler);
orgRouter.delete('/tokens/:tokenId', orgs.requireAdminParam, revokeTokenHandler);
orgRouter.get('/tokens/page', orgs.requireAdminParam, tokensPageHandler);
// Members / invitations / org settings (Task 4 / 5)
orgRouter.get('/members', orgs.requireAdminParam, membersPageHandler);
orgRouter.post('/members/invite', orgs.requireAdminParam, inviteCreateHandler);
orgRouter.post('/members/invite/:inviteId/revoke', orgs.requireAdminParam, inviteRevokeHandler);
orgRouter.post('/members/invite/:inviteId/reissue', orgs.requireAdminParam, inviteReissueHandler);
orgRouter.post('/members/:userId/role', orgs.requireAdminParam, setMemberRoleHandler);
orgRouter.post('/members/:userId/remove', orgs.requireAdminParam, removeMemberHandler);
orgRouter.post('/rename', orgs.requireAdminParam, renameOrgHandler);
orgRouter.delete('/', orgs.requireAdminParam, deleteOrgHandler);

router.use('/orgs/:orgId', orgRouter);

// ---- Legacy unscoped routes (backward compatibility) ----
// READ links redirect to the canonical URL after resolving the active org; the
// JSON/data + mutation routes keep working under the session guard and validate
// an optional expectedOrgId (rejecting a mismatch) so a stale form can't cross
// org boundaries.
function canonicalRedirect(req, res, suffix) {
  const orgId = req.orgId;
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  res.redirect(`/admin/orgs/${orgId}${suffix}${qs}`);
}

router.get('/prototypes', orgs.requireOrg, (req, res) => canonicalRedirect(req, res, '/prototypes'));
router.get('/upload', orgs.requireAdmin, (req, res) => canonicalRedirect(req, res, '/upload'));
// Resource-scoped legacy reads redirect ONLY after confirming the prototype
// belongs to the caller's active org (plan: "after checking resource
// membership"); a cross-org / missing id is a 404, same as the canonical route.
router.get('/prototypes/:id', orgs.requireOrg, async (req, res) => {
  if (!await getOrgPrototype(req.params.id, req.orgId, 'id')) return res.status(404).send('Not found.');
  canonicalRedirect(req, res, `/prototypes/${req.params.id}`);
});
router.get('/prototypes/:id/preview', orgs.requireOrg, async (req, res) => {
  if (!await getOrgPrototype(req.params.id, req.orgId, 'id')) return res.status(404).send('Not found.');
  canonicalRedirect(req, res, `/prototypes/${req.params.id}/preview`);
});
router.get('/tokens/page', orgs.requireAdmin, (req, res) => canonicalRedirect(req, res, '/tokens/page'));

// Legacy JSON/data GETs stay in place (consumed by older cached pages / tests).
router.get('/prototypes/:id/allowlist-count', orgs.requireOrg, allowlistCountHandler);
router.get('/prototypes/:id/versions', orgs.requireOrg, listVersionsHandler);
router.get('/prototypes/:id/explanations', orgs.requireOrg, explanationsHandler);
router.get('/prototypes/:id/funnels', orgs.requireOrg, funnelsHandler);
router.get('/prototypes/:id/comments/:commentId/screenshot', orgs.requireOrg, commentScreenshotHandler);
router.get('/tokens', orgs.requireAdmin, listTokensHandler);

// Legacy mutations (expectedOrgId-validated inside each handler).
router.post('/prototypes', orgs.requireAdmin, upload.single('file'), createPrototypeHandler);
router.post('/prototypes/:id/settings', orgs.requireAdmin, prototypeSettingsHandler);
router.post('/prototypes/:id/versions', orgs.requireAdmin, upload.single('file'), createVersionHandler);
router.post('/prototypes/:id/publish', orgs.requireAdmin, publishVersionHandler);
router.delete('/prototypes/:id', orgs.requireAdmin, deletePrototypeHandler);
router.post('/prototypes/:id/comments', orgs.requireOrg, listCommentsHandler);
router.delete('/prototypes/:id/comments', orgs.requireAdmin, clearCommentsHandler);
router.delete('/prototypes/:id/comments/:commentId', orgs.requireAdmin, deleteCommentHandler);
router.post('/prototypes/:id/access-log', orgs.requireOrg, accessLogHandler);
router.post('/tokens', orgs.requireAdmin, createTokenHandler);
router.delete('/tokens/:tokenId', orgs.requireAdmin, revokeTokenHandler);

module.exports = router;
