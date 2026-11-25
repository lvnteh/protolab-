// src/routes/api.js
const express = require('express');
const { getDb } = require('../db');
const { nanoid } = require('nanoid');
const annotations = require('../services/annotations');
const storage = require('../services/storage');

const router = express.Router();

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

// Authorize the current request to read/mutate data belonging to `prototypeId`.
// These /api routes are the reviewer-facing SDK endpoints (no auth middleware),
// so authorization is decided per request against the session. Two — and only
// two — callers are legitimate:
//   1. A reviewer whose share-link session is bound to EXACTLY this prototype
//      (req.session.prototypeId set by delivery.js on /enter).
//   2. An authenticated user who is a MEMBER of the prototype's organization
//      (req.session.userId + org_memberships) — the P1 tenant boundary.
// Everyone else — including a reviewer bound to a *different* prototype, or a
// user in a different org — is denied. This closes the cross-prototype /
// cross-tenant hole: without it, any caller could read or edit any
// comment/explanation by guessing its id.
async function authorizedForPrototype(req, prototypeId) {
  if (!prototypeId || !req.session) return false;
  if (req.session.prototypeId === prototypeId) return true;
  if (req.session.userId) {
    // Member of the prototype's org? Join prototype → membership for this user.
    const { rows } = await getDb().query(
      `SELECT 1 FROM prototypes p
         JOIN org_memberships m ON m.org_id = p.org_id
        WHERE p.id = $1 AND m.user_id = $2`,
      [prototypeId, req.session.userId]
    );
    return rows.length > 0;
  }
  return false;
}

// Look up the prototype a comment/explanation belongs to, then authorize.
// Returns { ok: true } when allowed, or { status, error } to send otherwise.
// A missing row is 404; an unauthorized caller is 403 — and we deliberately
// return 404 (not "you're not allowed to touch THAT one") is avoided here so
// the caller can distinguish, since the id space is per-prototype anyway.
async function authorizeResource(req, table, id) {
  const { rows } = await getDb().query(
    `SELECT prototype_id FROM ${table} WHERE id = $1`,
    [id]
  );
  if (!rows.length) return { status: 404, error: 'Not found.' };
  if (!(await authorizedForPrototype(req, rows[0].prototype_id))) {
    return { status: 403, error: 'Forbidden.' };
  }
  return { ok: true };
}

router.post('/comments', async (req, res) => {
  try {
    const { prototypeId, type, comment, element, breadcrumb, pageUrl, tag, xPct, yPct, email, parentId, anchor, screenshot } = req.body;
    const commentEmail = email || 'local@test.com';
    if (!comment || !comment.trim()) return res.status(400).json({ error: 'Comment is required.' });
    if (!prototypeId) return res.status(400).json({ error: 'prototypeId is required.' });
    if (!(await authorizedForPrototype(req, prototypeId))) {
      return res.status(403).json({ error: 'Forbidden.' });
    }

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
      // Screenshots only ride along on NEW parent pins — never on replies (a
      // reply inherits context from its parent). Failure here is swallowed by
      // handleScreenshot, so the comment always posts.
      const shot = parentId ? null : await handleScreenshot(screenshot);
      const { id } = await annotations.createComment(prototypeId, versionId,
        { email: commentEmail, type, comment, element, breadcrumb, pageUrl, tag, xPct, yPct, parentId, anchor, ...(shot || {}) });
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
    if (!(await authorizedForPrototype(req, req.params.prototypeId))) {
      return res.status(403).json({ error: 'Forbidden.' });
    }
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
  const auth = await authorizeResource(req, 'comments', req.params.commentId);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  await getDb().query('UPDATE comments SET comment = $1 WHERE id = $2', [comment.trim(), req.params.commentId]);
  res.json({ ok: true });
});

router.delete('/comments/:commentId', async (req, res) => {
  const auth = await authorizeResource(req, 'comments', req.params.commentId);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  // Best-effort: remove the stored screenshot (if any) before the row goes. A
  // storage failure must never block the DB delete, so we swallow it.
  const { rows } = await getDb().query('SELECT screenshot_key FROM comments WHERE id = $1', [req.params.commentId]);
  const key = rows[0] && rows[0].screenshot_key;
  await getDb().query('DELETE FROM comments WHERE id = $1', [req.params.commentId]);
  if (key) await storage.deleteImage(key).catch(() => {});
  res.json({ ok: true });
});

router.post('/nav', async (req, res) => {
  const { prototypeId, pageUrl } = req.body;
  if (!prototypeId || !pageUrl) return res.status(400).json({ error: 'prototypeId and pageUrl are required.' });
  if (!(await authorizedForPrototype(req, prototypeId))) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  const email = req.body.email || 'local@test.com';
  await getDb().query(
    'INSERT INTO nav_events (prototype_id, email, page_url, occurred_at) VALUES ($1,$2,$3,$4)',
    [prototypeId, email, String(pageUrl).slice(0, 500), new Date().toISOString()]
  );
  res.status(201).json({ ok: true });
});

router.get('/explanations/:prototypeId', async (req, res) => {
  if (!(await authorizedForPrototype(req, req.params.prototypeId))) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  const { versionId } = await annotations.resolveViewedVersion(req.params.prototypeId, req.query.version);
  res.json(await annotations.listExplanations(req.params.prototypeId, versionId));
});

router.post('/explanations', async (req, res) => {
  const { prototypeId, elementSelector, xPct, yPct, pageUrl, body } = req.body;
  if (!prototypeId || !elementSelector || !body || !body.trim()) {
    return res.status(400).json({ error: 'prototypeId, elementSelector, and body are required.' });
  }
  if (!(await authorizedForPrototype(req, prototypeId))) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
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
  const auth = await authorizeResource(req, 'explanations', req.params.id);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  await getDb().query(
    'UPDATE explanations SET body = $1, updated_at = $2 WHERE id = $3',
    [body.trim(), new Date().toISOString(), req.params.id]
  );
  res.json({ ok: true });
});

router.delete('/explanations/:id', async (req, res) => {
  const auth = await authorizeResource(req, 'explanations', req.params.id);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  await getDb().query('DELETE FROM explanations WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
