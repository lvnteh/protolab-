// src/routes/apiV1.js
// Machine-facing REST surface. Bearer-authenticated (apiTokenAuth sets req.userId),
// owner-scoped like the admin routes (a prototype that isn't yours → 404).
const express = require('express');
const { getDb } = require('../db');
const apiTokenAuth = require('../middleware/apiTokenAuth');
const config = require('../config');

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
              created_at, tag, x_pct, y_pct, parent_id, version_id
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
      resolved: false, // Phase 3 fills this
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

module.exports = router;
