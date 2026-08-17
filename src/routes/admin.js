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
const apiTokens = require('../services/tokens');
const filetype = require('../services/filetype');

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

router.get('/', (_req, res) => res.redirect('/admin/login'));

router.get('/login', (_req, res) => {
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
  req.session.activeOrgId = await orgs.defaultOrgId(user.id);
  res.redirect('/admin/prototypes');
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

router.get('/signup', (_req, res) => {
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

  // Org provisioning is admin-driven in this phase (not self-serve — that's a
  // future plan). A brand-new signup with no membership would be locked out of
  // every org-scoped page, so we auto-enrol them into the Default Organization
  // as a VIEWER: they can see and comment but not create/manage prototypes until
  // an admin promotes them. If no default org exists yet, they simply have no
  // active org and land on an empty prototype list.
  const { rows: defOrg } = await getDb().query(
    "SELECT id FROM organizations WHERE name = $1 ORDER BY created_at ASC LIMIT 1",
    ['Default Organization']
  );
  if (defOrg[0]) {
    await getDb().query(
      `INSERT INTO org_memberships (id, org_id, user_id, role, created_at)
       VALUES ($1,$2,$3,'viewer',$4) ON CONFLICT (org_id, user_id) DO NOTHING`,
      [nanoid(12), defOrg[0].id, id, new Date().toISOString()]
    );
    req.session.activeOrgId = defOrg[0].id;
  }
  req.session.userId = id;
  res.redirect('/admin/prototypes');
});

router.get('/prototypes', orgs.requireOrg, async (req, res) => {
  const { rows } = await getDb().query(`
    SELECT p.id, p.name, p.share_token, p.created_at,
      (SELECT COUNT(*) FROM allowlist  WHERE prototype_id = p.id) AS allowlist_count,
      (SELECT COUNT(*) FROM access_log WHERE prototype_id = p.id) AS view_count,
      (SELECT COUNT(*) FROM comments   WHERE prototype_id = p.id) AS comment_count
    FROM prototypes p WHERE p.org_id = $1 ORDER BY p.created_at DESC
  `, [req.orgId]);
  res.send(renderView('admin-prototypes.html', { prototypesJson: JSON.stringify(rows).replace(/</g, '\\u003c'), csrfToken: res.locals.csrfToken || '', orgRole: req.orgRole }));
});

router.get('/upload', orgs.requireAdmin, (_req, res) => {
  res.send(renderView('admin-upload.html', { success: '', csrfToken: res.locals.csrfToken || '' }));
});

router.post('/prototypes', orgs.requireAdmin, upload.single('file'), async (req, res) => {
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
      [id, req.body.name || 'Untitled', filename, shareToken, new Date().toISOString(), req.session.userId, req.orgId, contentType]
    );
    // v1 is the original, published from birth.
    await client.query(
      `INSERT INTO prototype_versions (id, prototype_id, version, filename, status, created_at, content_type)
       VALUES ($1,$2,1,$3,'published',$4,$5)`,
      [versionId, id, filename, new Date().toISOString(), contentType]
    );
    await client.query('UPDATE prototypes SET published_version_id = $1 WHERE id = $2', [versionId, id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
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
  res.send(renderView('admin-upload.html', { success: successBanner, csrfToken: res.locals.csrfToken || '' }));
});

router.get('/prototypes/:id', orgs.requireOrg, async (req, res) => {
  const proto = await getOrgPrototype(req.params.id, req.orgId);
  if (!proto) return res.status(404).send('Not found.');
  const { rows: allowRows } = await getDb().query('SELECT email FROM allowlist WHERE prototype_id = $1', [proto.id]);
  const allowlist = allowRows.map(r => r.email).join('\n');
  res.send(renderView('admin-prototype-detail.html', { id: proto.id, name: escapeHtml(proto.name), allowlist: escapeHtml(allowlist), shareToken: proto.share_token, csrfToken: res.locals.csrfToken || '', orgRole: req.orgRole }));
});

router.post('/prototypes/:id/settings', orgs.requireAdmin, async (req, res) => {
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
  res.redirect(`/admin/prototypes/${proto.id}?saved=1`);
});

router.get('/prototypes/:id/allowlist-count', orgs.requireOrg, async (req, res) => {
  if (!await getOrgPrototype(req.params.id, req.orgId, 'id')) return res.status(404).json({ error: 'Not found.' });
  const { rows } = await getDb().query('SELECT COUNT(*) AS n FROM allowlist WHERE prototype_id = $1', [req.params.id]);
  const count = parseInt(rows[0]?.n ?? 0, 10);
  res.json({ count });
});

router.delete('/prototypes/:id', orgs.requireAdmin, async (req, res) => {
  const proto = await getOrgPrototype(req.params.id, req.orgId);
  if (!proto) return res.status(404).json({ error: 'Not found.' });

  // Collect every stored file for this prototype: all version files plus the
  // legacy top-level filename. Dedupe, then best-effort delete each (a missing
  // object is not an error). The DB rows go via ON DELETE CASCADE below.
  const { rows: verRows } = await getDb().query(
    'SELECT filename FROM prototype_versions WHERE prototype_id = $1', [proto.id]);
  const files = new Set(verRows.map(r => r.filename));
  files.add(proto.filename);
  for (const filename of files) {
    await storage.deletePrototype(filename);
  }

  await getDb().query('DELETE FROM prototypes WHERE id = $1', [proto.id]);
  res.json({ ok: true });
});

router.post('/prototypes/:id/comments', orgs.requireOrg, async (req, res) => {
  if (!await getOrgPrototype(req.params.id, req.orgId, 'id')) return res.status(404).json({ error: 'Not found.' });
  const { pageSize = 25, offset = 0, sortingKey, sortingOrder = 'asc', filterValues = {} } = req.body || {};
  const allowedSort = ['email', 'type', 'created_at'];
  const orderBy = allowedSort.includes(sortingKey) ? sortingKey : 'created_at';
  const order = sortingOrder === 'desc' ? 'DESC' : 'ASC';

  const typeFilter = filterValues.type;
  const hasFilter = typeFilter && typeFilter.length > 0;

  let totalResult, rowsResult;
  if (hasFilter) {
    totalResult = await getDb().query(
      'SELECT COUNT(*) AS n FROM comments WHERE prototype_id = $1 AND type = $2 AND parent_id IS NULL',
      [req.params.id, typeFilter]
    );
    rowsResult = await getDb().query(
      `SELECT * FROM comments WHERE prototype_id = $1 AND type = $2 AND parent_id IS NULL ORDER BY ${orderBy} ${order} LIMIT $3 OFFSET $4`,
      [req.params.id, typeFilter, parseInt(pageSize, 10), parseInt(offset, 10)]
    );
  } else {
    totalResult = await getDb().query(
      'SELECT COUNT(*) AS n FROM comments WHERE prototype_id = $1 AND parent_id IS NULL',
      [req.params.id]
    );
    rowsResult = await getDb().query(
      `SELECT * FROM comments WHERE prototype_id = $1 AND parent_id IS NULL ORDER BY ${orderBy} ${order} LIMIT $2 OFFSET $3`,
      [req.params.id, parseInt(pageSize, 10), parseInt(offset, 10)]
    );
  }

  const total = parseInt(totalResult.rows[0].n, 10);
  const rows = rowsResult.rows.map(r => ({
    ...r,
    breadcrumb_display: (() => { try { return r.breadcrumb ? JSON.parse(r.breadcrumb).join(' → ') : ''; } catch { return ''; } })(),
  }));

  // Fetch replies for the returned page of parent comments
  const parentIds = rows.filter(r => r.type !== 'reply').map(r => r.id);
  let replyRows = [];
  if (parentIds.length) {
    const placeholders = parentIds.map((_, i) => `$${i + 1}`).join(',');
    const rr = await getDb().query(
      `SELECT id, parent_id, email, comment, created_at FROM comments WHERE parent_id IN (${placeholders}) ORDER BY created_at ASC`,
      parentIds
    );
    replyRows = rr.rows;
  }

  const replyMap = {};
  replyRows.forEach(r => {
    if (!replyMap[r.parent_id]) replyMap[r.parent_id] = [];
    replyMap[r.parent_id].push(r);
  });

  const rowsWithReplies = rows.map(r => ({ ...r, replies: replyMap[r.id] || [] }));
  res.json({ data: rowsWithReplies, totalCount: total });
});

router.delete('/prototypes/:id/comments', orgs.requireAdmin, async (req, res) => {
  if (!await getOrgPrototype(req.params.id, req.orgId, 'id')) return res.status(404).json({ error: 'Not found.' });
  await getDb().query('DELETE FROM comments WHERE prototype_id = $1', [req.params.id]);
  res.json({ ok: true });
});

router.delete('/prototypes/:id/comments/:commentId', orgs.requireAdmin, async (req, res) => {
  if (!await getOrgPrototype(req.params.id, req.orgId, 'id')) return res.status(404).json({ error: 'Not found.' });
  const { rows } = await getDb().query('SELECT id FROM comments WHERE id = $1 AND prototype_id = $2', [req.params.commentId, req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found.' });
  await getDb().query('DELETE FROM comments WHERE id = $1', [req.params.commentId]);
  res.json({ ok: true });
});

router.post('/prototypes/:id/access-log', orgs.requireOrg, async (req, res) => {
  if (!await getOrgPrototype(req.params.id, req.orgId, 'id')) return res.status(404).json({ error: 'Not found.' });
  const { pageSize = 25, offset = 0 } = req.body || {};
  const totalResult = await getDb().query('SELECT COUNT(*) AS n FROM access_log WHERE prototype_id = $1', [req.params.id]);
  const total = parseInt(totalResult.rows[0].n, 10);
  const { rows } = await getDb().query(
    'SELECT * FROM access_log WHERE prototype_id = $1 ORDER BY opened_at DESC LIMIT $2 OFFSET $3',
    [req.params.id, parseInt(pageSize, 10), parseInt(offset, 10)]
  );
  res.json({ data: rows, totalCount: total });
});

router.get('/prototypes/:id/preview', orgs.requireOrg, async (req, res) => {
  const proto = await getOrgPrototype(req.params.id, req.orgId);
  if (!proto) return res.status(404).send('Prototype not found.');

  if (path.basename(proto.filename) !== proto.filename) return res.status(400).send('Invalid prototype filename.');
  const raw = await storage.getPrototype(proto.filename);
  if (raw === null) return res.status(404).send('Prototype file not found.');

  const highlightId = req.query.comment || '';
  const { rows: allCommentRows } = await getDb().query(
    `SELECT id, email, element_selector, element_label, comment, created_at, tag, x_pct, y_pct, page_url, parent_id
     FROM comments WHERE prototype_id = $1
     ORDER BY created_at ASC`,
    [proto.id]
  );

  const replyMap = {};
  allCommentRows.filter(r => r.parent_id).forEach(r => {
    if (!replyMap[r.parent_id]) replyMap[r.parent_id] = [];
    replyMap[r.parent_id].push({ id: r.id, email: r.email, comment: r.comment, created_at: r.created_at });
  });

  const comments = allCommentRows
    .filter(r => !r.parent_id)
    .map((r, i) => ({ ...r, order: i + 1, replies: replyMap[r.id] || [] }));

  const html = injectPreview(raw, proto.id, highlightId, JSON.stringify(comments));
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
});

// --- API token management (machine access for local-AI integration) ---
// Tokens are org-scoped: minted for the admin's active org, and act with full
// (admin-equivalent) authority within that org. Admin-only.
router.post('/tokens', orgs.requireAdmin, async (req, res) => {
  const { id, raw } = await apiTokens.createToken(req.session.userId, (req.body.name || 'token').slice(0, 60), req.orgId);
  // The raw secret is returned exactly once and never stored in plaintext.
  res.status(201).json({ id, token: raw });
});

router.get('/tokens', orgs.requireAdmin, async (req, res) => {
  res.json(await apiTokens.listTokens(req.orgId));
});

// Idempotent by design: revokeToken is an org-scoped no-op DELETE, so revoking
// an already-gone or never-existed token still returns { ok: true }. (Differs
// from DELETE /prototypes/:id, which 404s — tokens don't need existence feedback.)
router.delete('/tokens/:tokenId', orgs.requireAdmin, async (req, res) => {
  await apiTokens.revokeToken(req.params.tokenId, req.orgId);
  res.json({ ok: true });
});

// Account-level API-token management page. Distinct path from GET /tokens
// (which returns JSON, consumed by this page's client-side fetch).
router.get('/tokens/page', orgs.requireAdmin, (_req, res) => {
  renderAdmin(res, 'admin-tokens.html');
});

// Org-scoped version history for a prototype (consumed by the detail view's
// Versions tab). Flags which row is the live-published one and which is the draft.
router.get('/prototypes/:id/versions', orgs.requireOrg, async (req, res) => {
  if (!await getOrgPrototype(req.params.id, req.orgId, 'id')) return res.status(404).json({ error: 'Not found.' });
  const { rows } = await getDb().query(
    `SELECT v.version, v.status, v.note, v.created_at,
            COALESCE(v.id = p.published_version_id, false) AS is_published,
            COALESCE(v.id = p.draft_version_id, false)     AS is_draft
     FROM prototype_versions v
     JOIN prototypes p ON p.id = v.prototype_id
     WHERE v.prototype_id = $1 ORDER BY v.version DESC`,
    [req.params.id]);
  res.json(rows.map(r => ({
    version: r.version, status: r.status, note: r.note, createdAt: r.created_at,
    isPublished: r.is_published, isDraft: r.is_draft,
  })));
});

router.get('/prototypes/:id/funnels', orgs.requireOrg, async (req, res) => {
  const protoId = req.params.id;
  if (!await getOrgPrototype(protoId, req.orgId, 'id')) return res.status(404).json({ error: 'Not found.' });

  // 1. Load all nav events for this prototype, ordered for stitching
  const { rows: events } = await getDb().query(
    'SELECT email, page_url, occurred_at FROM nav_events WHERE prototype_id = $1 ORDER BY email, occurred_at ASC',
    [protoId]
  );

  // 2. Stitch into journeys — the first page a user ever visits is their "root".
  //    Each return to the root page ends the current journey and starts a new one.
  const sessions = [];
  // Determine each user's root page (their very first page visited)
  const userRoot = {};
  for (const ev of events) {
    if (!(ev.email in userRoot)) userRoot[ev.email] = ev.page_url;
  }
  // The prototype's root page is the most common first-page across users
  const rootCounts = {};
  for (const r of Object.values(userRoot)) rootCounts[r] = (rootCounts[r] || 0) + 1;
  const protoRoot = Object.keys(rootCounts).sort((a, b) => rootCounts[b] - rootCounts[a])[0] || null;
  let cur = null;
  for (const ev of events) {
    const isRoot = ev.page_url === userRoot[ev.email];
    if (!cur || ev.email !== cur.email || (isRoot && cur.pages.length > 0)) {
      cur = { email: ev.email, startedAt: ev.occurred_at, pages: [], lastAt: ev.occurred_at };
      sessions.push(cur);
    }
    // Deduplicate consecutive identical pages
    if (cur.pages[cur.pages.length - 1] !== ev.page_url) cur.pages.push(ev.page_url);
    cur.lastAt = ev.occurred_at;
  }

  // 3. Cross-reference comments to mark sessions that had a comment
  const { rows: commentRows } = await getDb().query(
    "SELECT email, created_at FROM comments WHERE prototype_id = $1 AND type = 'element'",
    [protoId]
  );

  const journeys = sessions.slice(-50).reverse().map(s => {
    const sStart = new Date(s.startedAt).getTime();
    const sEnd = new Date(s.lastAt || s.startedAt).getTime() + 60000; // +1 min buffer
    const hadComment = commentRows.some(c => {
      const ct = new Date(c.created_at).getTime();
      return c.email === s.email && ct >= sStart && ct <= sEnd;
    });
    return { email: s.email, startedAt: s.startedAt, pages: s.pages, hadComment };
  });

  // 4. Build page funnel (ordered by median position across sessions), excluding root pages
  const rootPages = new Set(Object.values(userRoot));
  const pagePositions = {};
  for (const s of sessions) {
    s.pages.forEach((page, i) => {
      if (rootPages.has(page)) return;
      if (!pagePositions[page]) pagePositions[page] = [];
      pagePositions[page].push(i);
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
  function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  const funnelPages = Object.keys(pagePositions)
    .sort((a, b) => median(pagePositions[a]) - median(pagePositions[b]));
  const totalSessions = sessions.length;
  const funnel = funnelPages.map((page, i) => {
    const count = pageSessionCount[page] || 0;
    const pct = totalSessions ? Math.round(count / totalSessions * 100) : 0;
    const prevCount = i === 0 ? count : (pageSessionCount[funnelPages[i - 1]] || 0);
    const dropPct = i === 0 ? 0 : (prevCount ? Math.round((prevCount - count) / prevCount * 100) : 0);
    return { page, sessions: count, pct, dropPct };
  });

  // 5. Time on page (median inter-page interval per session, capped at 4h)
  const MAX_INTERVAL_MS = 4 * 60 * 60 * 1000;
  const pageIntervals = {};
  for (const s of sessions) {
    const evs = events.filter(e => e.email === s.email &&
      new Date(e.occurred_at).getTime() >= new Date(s.startedAt).getTime() &&
      new Date(e.occurred_at).getTime() <= new Date(s.lastAt || s.startedAt).getTime() + 60000
    );
    for (let i = 0; i < evs.length - 1; i++) {
      const dt = Math.min(
        new Date(evs[i + 1].occurred_at).getTime() - new Date(evs[i].occurred_at).getTime(),
        MAX_INTERVAL_MS
      );
      if (dt < 0) continue;
      if (!pageIntervals[evs[i].page_url]) pageIntervals[evs[i].page_url] = [];
      pageIntervals[evs[i].page_url].push(dt);
    }
  }
  const timeOnPage = Object.entries(pageIntervals)
    .filter(([, arr]) => arr.length >= 2)
    .map(([page, arr]) => ({ page, medianMs: Math.round(median(arr)), visits: arr.length }))
    .sort((a, b) => b.visits - a.visits);

  res.json({ funnel, journeys, timeOnPage });
});

module.exports = router;
