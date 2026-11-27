// src/routes/api.js
const express = require('express');
const { getDb } = require('../db');
const { nanoid } = require('nanoid');
const annotations = require('../services/annotations');
const storage = require('../services/storage');
const orgs = require('../services/orgs');

const router = express.Router();

// Own-comment edit/delete window (server-enforced, Task 6). The SDK also shows a
// 5-minute window client-side, but the server is the authority.
const EDIT_WINDOW_MS = 5 * 60 * 1000;

// Max decoded screenshot size we accept (8MB). Larger payloads are dropped
// (comment still posts without a screenshot) so a reviewer can't push huge
// blobs into storage.
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
// Inline-thumbnail budget. There is NO image library in this app (no sharp/jimp)
// and we must not add one, so we cannot downscale server-side. Instead we store
// the ORIGINAL data URL as the "thumbnail" ONLY when it is small enough to live
// on the row cheaply (~60KB of base64 text); otherwise the thumb is null and the
// admin UI fetches the full image on demand via the screenshot route. The check
// is on the base64 character length (what actually gets stored).
const MAX_THUMB_BASE64 = 60 * 1024;

// Decode + store a pin screenshot, returning the computed columns for
// createComment, or null to persist no screenshot. NEVER throws: any bad data or
// storage failure is logged and swallowed so comment creation always proceeds.
async function handleScreenshot(screenshot) {
  try {
    if (!screenshot || typeof screenshot !== 'object') return null;
    const { dataUrl, w, h, xPct, yPct } = screenshot;
    // Only accept PNG data URLs; anything else is skipped (never a 500).
    if (typeof dataUrl !== 'string' || !/^data:image\/png;base64,/.test(dataUrl)) return null;
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length || buffer.length > MAX_SCREENSHOT_BYTES) return null;

    // When the image is small enough to inline as the thumb, the thumb IS the
    // whole image — storing the object too would be dead weight the admin UI
    // never fetches (it prefers the thumb). So: small → inline thumb only, no
    // object; large → object in storage + null thumb (admin fetches on demand).
    const fitsInline = base64.length <= MAX_THUMB_BASE64;
    let key = null;
    if (!fitsInline) {
      key = `${storage.SCREENSHOT_PREFIX}${nanoid()}.png`;
      await storage.putImage(key, buffer);
    }
    const thumb = fitsInline ? dataUrl : null;

    // The SDK clamps, but never trust the client: bound the pin fraction to
    // [0,1] and keep only sane positive dimensions so the owner's lightbox can't
    // be fed an out-of-range pin or absurd dimensions.
    const frac = (v) => (typeof v === 'number' && isFinite(v)) ? Math.min(1, Math.max(0, v)) : null;
    const dim = (v) => (Number.isInteger(v) && v > 0 && v <= 100000) ? v : null;
    return {
      screenshotKey: key,
      screenshotThumb: thumb,
      screenshotW: dim(w),
      screenshotH: dim(h),
      screenshotXPct: frac(xPct),
      screenshotYPct: frac(yPct),
    };
  } catch (e) {
    console.error('screenshot handling failed (comment proceeds without it):', e);
    return null;
  }
}

// Resolve a STRUCTURED actor for a request against `prototypeId`. This is the one
// place authorization/identity for the reviewer-facing SDK API is decided, and
// it is re-run on EVERY read/write (so a removed member / revoked allowlist entry
// loses access on their next request). Returns one of:
//   { kind:'account', userId, email, role }  — an authenticated org MEMBER acting
//        with their account (role = 'admin' | 'viewer'); identity is the canonical
//        users.email, NEVER a request-body email.
//   { kind:'reviewer', email }               — a share-link reviewer whose session
//        is bound to EXACTLY this prototype AND whose session email still passes
//        the effective-access rule (explicit allowlist OR current same-org member
//        email). A member entering their email on an own-org link lands here.
//   null                                       — not authorized for this prototype.
// An account membership takes precedence (richer capabilities) when both apply.
async function resolveActor(req, prototypeId) {
  if (!prototypeId || !req.session) return null;

  // Account actor: a current member of the prototype's owning org.
  if (req.session.userId) {
    const { rows } = await getDb().query(
      `SELECT m.role, u.email FROM prototypes p
         JOIN org_memberships m ON m.org_id = p.org_id
         JOIN users u ON u.id = m.user_id
        WHERE p.id = $1 AND u.id = $2`,
      [prototypeId, req.session.userId]);
    if (rows[0]) {
      return { kind: 'account', userId: req.session.userId, email: (rows[0].email || '').toLowerCase(), role: rows[0].role };
    }
  }

  // Reviewer actor: the share session must be bound to THIS prototype, and the
  // session email must STILL satisfy the effective-access rule (re-checked here,
  // not trusted from when the session was created).
  if (req.session.prototypeId === prototypeId && req.session.customerEmail) {
    const { allowed } = await orgs.effectiveReviewerAccess(prototypeId, req.session.customerEmail);
    if (allowed) return { kind: 'reviewer', email: (req.session.customerEmail || '').toLowerCase() };
  }
  return null;
}

// Capability predicates over a resolved actor (the Task 6 matrix). Reviewers and
// viewers may read + comment; only admins may moderate others' comments and
// create/edit/delete explanations.
const canComment = (actor) => !!actor; // any resolved actor may create comments/replies
const canModerate = (actor) => !!actor && actor.kind === 'account' && actor.role === 'admin';
const canExplain = (actor) => !!actor && actor.kind === 'account' && actor.role === 'admin';

// May `actor` edit/delete THIS comment row? Admins may always (moderation).
// Otherwise only the ORIGINAL author, and only within the 5-minute window, keyed
// off the server-derived author identity (author_user_id for accounts,
// author_kind='reviewer' + email for reviewers) — never the request-body email.
// Legacy rows (author_kind NULL) have insufficient identity and are admin-only.
function canEditOwnComment(actor, row) {
  if (canModerate(actor)) return true;
  if (!actor || !row.author_kind) return false;
  const withinWindow = (Date.now() - new Date(row.created_at).getTime()) <= EDIT_WINDOW_MS;
  if (!withinWindow) return false;
  if (actor.kind === 'account') return row.author_kind === 'account' && row.author_user_id === actor.userId;
  if (actor.kind === 'reviewer') return row.author_kind === 'reviewer' && (row.email || '').toLowerCase() === actor.email;
  return false;
}

router.post('/comments', async (req, res) => {
  try {
    const { prototypeId, type, comment, element, breadcrumb, pageUrl, tag, xPct, yPct, parentId, anchor, screenshot } = req.body;
    if (!comment || !comment.trim()) return res.status(400).json({ error: 'Comment is required.' });
    if (!prototypeId) return res.status(400).json({ error: 'prototypeId is required.' });
    const actor = await resolveActor(req, prototypeId);
    if (!canComment(actor)) return res.status(403).json({ error: 'Forbidden.' });

    // Author identity is derived SERVER-SIDE from the resolved actor — the body's
    // `email` can never set authorship or editing rights. The display email is
    // the account's canonical email (members) or the validated reviewer email.
    const commentEmail = actor.email;
    const authorUserId = actor.kind === 'account' ? actor.userId : null;
    const authorKind = actor.kind;

    try {
      let versionId;
      if (parentId) {
        const { rows: parentRows } = await getDb().query(
          'SELECT id, parent_id, version_id FROM comments WHERE id = $1 AND prototype_id = $2',
          [parentId, prototypeId]);
        if (!parentRows.length) return res.status(404).json({ error: 'Parent comment not found.' });
        if (parentRows[0].parent_id) return res.status(400).json({ error: 'Cannot reply to a reply.' });
        versionId = parentRows[0].version_id;           // reply inherits the parent's version
      } else {
        if (!['general', 'element', 'range'].includes(type)) return res.status(400).json({ error: 'Invalid type.' });
        ({ versionId } = await annotations.resolveViewedVersion(prototypeId, req.body.version));
      }
      const shot = parentId ? null : await handleScreenshot(screenshot);
      const { id } = await annotations.createComment(prototypeId, versionId,
        { email: commentEmail, type, comment, element, breadcrumb, pageUrl, tag, xPct, yPct, parentId, anchor, authorUserId, authorKind, ...(shot || {}) });
      return res.status(201).json({ ok: true, id });
    } catch (e) {
      if (e.code === 'ANCHOR_REQUIRED') return res.status(400).json({ error: 'Range comment requires an anchor quote.' });
      throw e;
    }
  } catch (err) {
    console.error('POST /comments error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.get('/comments/:prototypeId', async (req, res) => {
  try {
    const actor = await resolveActor(req, req.params.prototypeId);
    if (!actor) return res.status(403).json({ error: 'Forbidden.' });
    const { versionId } = await annotations.resolveViewedVersion(req.params.prototypeId, req.query.version);
    const result = await annotations.listComments(req.params.prototypeId, versionId);
    res.json(result);
  } catch (err) {
    console.error('GET /comments error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.patch('/comments/:commentId', async (req, res) => {
  const { comment } = req.body;
  if (!comment || !comment.trim()) return res.status(400).json({ error: 'Comment is required.' });
  const { rows } = await getDb().query(
    'SELECT id, prototype_id, author_user_id, author_kind, email, created_at FROM comments WHERE id = $1',
    [req.params.commentId]);
  if (!rows.length) return res.status(404).json({ error: 'Not found.' });
  const row = rows[0];
  const actor = await resolveActor(req, row.prototype_id);
  if (!actor) return res.status(403).json({ error: 'Forbidden.' });
  // Editing is author-own (within the 5-min window) OR admin moderation. A viewer
  // / reviewer editing someone ELSE's comment (or past the window) is 403.
  if (!canEditOwnComment(actor, row)) return res.status(403).json({ error: 'You can only edit your own comment within five minutes of posting.' });
  await getDb().query('UPDATE comments SET comment = $1 WHERE id = $2', [comment.trim(), req.params.commentId]);
  res.json({ ok: true });
});

router.delete('/comments/:commentId', async (req, res) => {
  const { rows } = await getDb().query(
    'SELECT id, prototype_id, author_user_id, author_kind, email, created_at, screenshot_key FROM comments WHERE id = $1',
    [req.params.commentId]);
  if (!rows.length) return res.status(404).json({ error: 'Not found.' });
  const row = rows[0];
  const actor = await resolveActor(req, row.prototype_id);
  if (!actor) return res.status(403).json({ error: 'Forbidden.' });
  // Delete is author-own-within-window OR admin moderation (matrix: a viewer
  // cannot moderate others' comments; a reviewer cannot moderate at all).
  if (!canEditOwnComment(actor, row)) return res.status(403).json({ error: 'You can only delete your own comment within five minutes, unless you are an admin.' });
  const key = row.screenshot_key;
  await getDb().query('DELETE FROM comments WHERE id = $1', [req.params.commentId]);
  if (key) await storage.deleteImage(key).catch(() => {});
  res.json({ ok: true });
});

router.post('/nav', async (req, res) => {
  const { prototypeId, pageUrl } = req.body;
  if (!prototypeId || !pageUrl) return res.status(400).json({ error: 'prototypeId and pageUrl are required.' });
  const actor = await resolveActor(req, prototypeId);
  if (!actor) return res.status(403).json({ error: 'Forbidden.' });
  // Telemetry email is the server-derived actor identity, not a body field.
  await getDb().query(
    'INSERT INTO nav_events (prototype_id, email, page_url, occurred_at) VALUES ($1,$2,$3,$4)',
    [prototypeId, actor.email, String(pageUrl).slice(0, 500), new Date().toISOString()]
  );
  res.status(201).json({ ok: true });
});

router.get('/explanations/:prototypeId', async (req, res) => {
  const actor = await resolveActor(req, req.params.prototypeId);
  if (!actor) return res.status(403).json({ error: 'Forbidden.' });
  const { versionId } = await annotations.resolveViewedVersion(req.params.prototypeId, req.query.version);
  res.json(await annotations.listExplanations(req.params.prototypeId, versionId));
});

router.post('/explanations', async (req, res) => {
  const { prototypeId, elementSelector, xPct, yPct, pageUrl, body } = req.body;
  if (!prototypeId || !elementSelector || !body || !body.trim()) {
    return res.status(400).json({ error: 'prototypeId, elementSelector, and body are required.' });
  }
  const actor = await resolveActor(req, prototypeId);
  if (!actor) return res.status(403).json({ error: 'Forbidden.' });
  // Explanations are authored content — admin-only (matrix).
  if (!canExplain(actor)) return res.status(403).json({ error: 'Only admins can create explanations.' });
  try {
    const { versionId } = await annotations.resolveViewedVersion(prototypeId, req.body.version);
    const { id } = await annotations.createExplanation(prototypeId, versionId, { elementSelector, xPct, yPct, pageUrl, body });
    res.status(201).json({ ok: true, id });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Explanation already exists for this element.' });
    throw e;
  }
});

router.patch('/explanations/:id', async (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'body is required.' });
  const { rows } = await getDb().query('SELECT prototype_id FROM explanations WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found.' });
  const actor = await resolveActor(req, rows[0].prototype_id);
  if (!actor) return res.status(403).json({ error: 'Forbidden.' });
  if (!canExplain(actor)) return res.status(403).json({ error: 'Only admins can edit explanations.' });
  await getDb().query(
    'UPDATE explanations SET body = $1, updated_at = $2 WHERE id = $3',
    [body.trim(), new Date().toISOString(), req.params.id]
  );
  res.json({ ok: true });
});

router.delete('/explanations/:id', async (req, res) => {
  const { rows } = await getDb().query('SELECT prototype_id FROM explanations WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found.' });
  const actor = await resolveActor(req, rows[0].prototype_id);
  if (!actor) return res.status(403).json({ error: 'Forbidden.' });
  if (!canExplain(actor)) return res.status(403).json({ error: 'Only admins can delete explanations.' });
  await getDb().query('DELETE FROM explanations WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
