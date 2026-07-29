// src/routes/apiV1.js
// Machine-facing REST surface. Bearer-authenticated (apiTokenAuth sets req.userId),
// owner-scoped like the admin routes (a prototype that isn't yours → 404).
const express = require('express');
const { getDb } = require('../db');
const apiTokenAuth = require('../middleware/apiTokenAuth');
const config = require('../config');
const multer = require('multer');
const { nanoid } = require('nanoid');
const storage = require('../services/storage');
const versions = require('../services/versions');

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => cb(null, file.originalname.endsWith('.html')),
});

const router = express.Router();
router.use(apiTokenAuth);

// Fetch a prototype only if owned by the caller — mirrors admin getOwnedPrototype.
async function getOwned(id, ownerId, columns = '*') {
  const { rows } = await getDb().query(
    `SELECT ${columns} FROM prototypes WHERE id = $1 AND owner_id = $2`, [id, ownerId]);
  return rows[0] || null;
}

// GET /api/v1/prototypes — list the caller's prototypes with version pointers.
router.get('/prototypes', async (req, res) => {
  try {
    const { rows } = await getDb().query(`
      SELECT p.id, p.name, p.share_token,
        pub.version AS published_version,
        dr.version  AS draft_version
      FROM prototypes p
      LEFT JOIN prototype_versions pub ON pub.id = p.published_version_id
      LEFT JOIN prototype_versions dr  ON dr.id  = p.draft_version_id
      WHERE p.owner_id = $1 ORDER BY p.created_at DESC`, [req.userId]);
    res.json(rows.map(r => ({
      id: r.id, name: r.name,
      shareLink: `${config.baseUrl}/p/${r.share_token}`,
      publishedVersion: r.published_version,
      draftVersion: r.draft_version,
    })));
  } catch (err) {
    console.error('GET /api/v1/prototypes error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/v1/prototypes/:id/feedback — comments (+replies) + explanations.
router.get('/prototypes/:id/feedback', async (req, res) => {
  try {
    const proto = await getOwned(req.params.id, req.userId, 'id, name, published_version_id, draft_version_id');
    if (!proto) return res.status(404).json({ error: 'Not found.' });

    const { rows: vNums } = await getDb().query(
      'SELECT id, version FROM prototype_versions WHERE prototype_id = $1', [proto.id]);
    const versionOf = Object.fromEntries(vNums.map(v => [v.id, v.version]));
    const pubVer = versionOf[proto.published_version_id] || null;
    const draftVer = versionOf[proto.draft_version_id] || null;

    const { rows } = await getDb().query(
      `SELECT id, email, type, element_selector, element_label, comment, page_url,
              created_at, tag, x_pct, y_pct, parent_id, version_id,
              resolved_at, resolved_in_version
       FROM comments WHERE prototype_id = $1 ORDER BY created_at ASC`, [proto.id]);

    const replyMap = {};
    rows.filter(r => r.parent_id).forEach(r => {
      (replyMap[r.parent_id] ||= []).push(
        { email: r.email, comment: r.comment, createdAt: r.created_at });
    });
    const comments = rows.filter(r => !r.parent_id).map(r => ({
      id: r.id, type: r.type, tag: r.tag, comment: r.comment, email: r.email,
      element: r.element_selector ? { selector: r.element_selector, label: r.element_label } : null,
      pageUrl: r.page_url, createdAt: r.created_at,
      madeAgainstVersion: versionOf[r.version_id] || 1, // null version_id = legacy/backfilled comment → treat as v1
      resolved: !!r.resolved_at,
      resolvedInVersion: r.resolved_in_version ?? null,
      replies: replyMap[r.id] || [],
    }));

    const { rows: expl } = await getDb().query(
      `SELECT element_selector, page_url, body FROM explanations
       WHERE prototype_id = $1 ORDER BY created_at ASC`, [proto.id]);

    res.json({
      prototype: { id: proto.id, name: proto.name, publishedVersion: pubVer, draftVersion: draftVer },
      comments,
      explanations: expl.map(e => ({ elementSelector: e.element_selector, pageUrl: e.page_url, body: e.body })),
    });
  } catch (err) {
    console.error('GET /api/v1/prototypes/:id/feedback error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /prototypes/:id/versions — history newest-first.
router.get('/prototypes/:id/versions', async (req, res) => {
  try {
    if (!await getOwned(req.params.id, req.userId, 'id')) return res.status(404).json({ error: 'Not found.' });
    const { rows } = await getDb().query(
      `SELECT version, status, note, created_at FROM prototype_versions
       WHERE prototype_id = $1 ORDER BY version DESC`, [req.params.id]);
    res.json(rows.map(r => ({ version: r.version, status: r.status, note: r.note, createdAt: r.created_at })));
  } catch (err) {
    console.error('GET /api/v1/prototypes/:id/versions error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /prototypes/:id/source — published HTML, or ?version=N for a specific one.
router.get('/prototypes/:id/source', async (req, res) => {
  try {
    if (!await getOwned(req.params.id, req.userId, 'id')) return res.status(404).json({ error: 'Not found.' });
    let filename;
    if (req.query.version) {
      const v = parseInt(req.query.version, 10);
      if (Number.isNaN(v)) return res.status(400).json({ error: 'version must be an integer.' });
      const { rows } = await getDb().query(
        'SELECT filename FROM prototype_versions WHERE prototype_id = $1 AND version = $2',
        [req.params.id, v]);
      filename = rows[0] && rows[0].filename;
    } else {
      filename = await versions.resolvePublishedFile(req.params.id);
    }
    if (!filename) return res.status(404).json({ error: 'Version not found.' });
    const raw = await storage.getPrototype(filename);
    if (raw === null) return res.status(404).json({ error: 'File not found.' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(raw);
  } catch (err) {
    console.error('GET /api/v1/prototypes/:id/source error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /prototypes/:id/versions — upload HTML as a DRAFT. Conflict-guarded.
router.post('/prototypes/:id/versions', upload.single('file'), async (req, res) => {
  try {
    if (!await getOwned(req.params.id, req.userId, 'id')) return res.status(404).json({ error: 'Not found.' });
    if (!req.file) return res.status(400).json({ error: 'Only .html files are accepted.' });

    const latest = await versions.latestVersion(req.params.id);
    const base = parseInt(req.body.baseVersion, 10);
    if (!Number.isNaN(base) && base !== latest) {
      return res.status(409).json({ error: 'Prototype changed since you pulled.', currentVersion: latest });
    }

    const filename = `${nanoid(12)}.html`;
    await storage.putPrototype(filename, req.file.buffer);
    try {
      const v = await versions.createDraft(req.params.id, filename, req.body.note);
      res.status(201).json(v);
    } catch (e) {
      // Concurrent push race: UNIQUE(prototype_id, version) collision. Someone
      // else created the same version number between our read and insert.
      if (e.code === '23505') {
        await storage.deletePrototype(filename).catch(() => {}); // best-effort: no version row references this file
        return res.status(409).json({ error: 'Prototype changed since you pulled.', currentVersion: await versions.latestVersion(req.params.id) });
      }
      throw e;
    }
  } catch (err) {
    console.error('POST /api/v1/prototypes/:id/versions error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /prototypes/:id/publish — promote a draft (defaults to latest).
router.post('/prototypes/:id/publish', async (req, res) => {
  try {
    if (!await getOwned(req.params.id, req.userId, 'id')) return res.status(404).json({ error: 'Not found.' });
    const version = req.body.version != null ? parseInt(req.body.version, 10) : await versions.latestVersion(req.params.id);
    const result = await versions.publish(req.params.id, version);
    res.json(result);
  } catch (err) {
    if (err.code === 'CONFLICT') return res.status(409).json({ error: err.message });
    console.error('POST /api/v1/prototypes/:id/publish error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /prototypes/:id/comments/:commentId/resolve — mark a comment addressed.
// Idempotent: re-resolving updates the version stamp. Owner-scoped; a comment
// that isn't on a prototype you own (or doesn't exist) → 404.
router.post('/prototypes/:id/comments/:commentId/resolve', async (req, res) => {
  try {
    if (!await getOwned(req.params.id, req.userId, 'id')) return res.status(404).json({ error: 'Not found.' });
    const version = req.body && req.body.version != null ? parseInt(req.body.version, 10) : null;
    if (version != null && Number.isNaN(version)) return res.status(400).json({ error: 'version must be an integer.' });
    const { rowCount } = await getDb().query(
      `UPDATE comments SET resolved_at = $1, resolved_in_version = $2
       WHERE id = $3 AND prototype_id = $4`,
      [new Date().toISOString(), version, req.params.commentId, req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Comment not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/v1/prototypes/:id/comments/:commentId/resolve error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
