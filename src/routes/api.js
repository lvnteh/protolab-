// src/routes/api.js
const express = require('express');
const { nanoid } = require('nanoid');
const { getDb } = require('../db');
const versions = require('../services/versions');

const router = express.Router();
const VALID_TAGS = ['bug', 'copy', 'question', 'idea', 'other'];

router.post('/comments', async (req, res) => {
  try {
    const { prototypeId, type, comment, element, breadcrumb, pageUrl, tag, xPct, yPct, email, parentId } = req.body;
    const commentEmail = email || 'local@test.com';
    if (!comment || !comment.trim()) return res.status(400).json({ error: 'Comment is required.' });

    const id = nanoid(12);

    if (parentId) {
      if (!prototypeId) return res.status(400).json({ error: 'prototypeId is required.' });
      const { rows: parentRows } = await getDb().query(
        'SELECT id, parent_id FROM comments WHERE id = $1 AND prototype_id = $2',
        [parentId, prototypeId]
      );
      if (!parentRows.length) return res.status(404).json({ error: 'Parent comment not found.' });
      if (parentRows[0].parent_id) return res.status(400).json({ error: 'Cannot reply to a reply.' });

      await getDb().query(
        `INSERT INTO comments
          (id, prototype_id, email, type, comment, created_at, parent_id)
         VALUES ($1,$2,$3,'reply',$4,$5,$6)`,
        [id, prototypeId, commentEmail, comment.trim(), new Date().toISOString(), parentId]
      );
      return res.status(201).json({ ok: true, id });
    }

    if (!['general', 'element'].includes(type)) return res.status(400).json({ error: 'Invalid type.' });

    const versionId = await versions.publishedVersionId(prototypeId);

    await getDb().query(
      `INSERT INTO comments
        (id, prototype_id, email, type, element_selector, element_label, element_tag,
         breadcrumb, comment, page_url, created_at, tag, x_pct, y_pct, version_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id, prototypeId, commentEmail, type,
        element?.selector || null,
        element?.label    || null,
        element?.tagName  || null,
        breadcrumb ? JSON.stringify(breadcrumb) : null,
        comment.trim(),
        pageUrl || null,
        new Date().toISOString(),
        VALID_TAGS.includes(tag) ? tag : null,
        typeof xPct === 'number' ? xPct : null,
        typeof yPct === 'number' ? yPct : null,
        versionId,
      ]
    );
    res.status(201).json({ ok: true, id });
  } catch (err) {
    console.error('POST /comments error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.get('/comments/:prototypeId', async (req, res) => {
  try {
    const { rows } = await getDb().query(
      `SELECT id, email, element_selector, element_label, comment, created_at, tag, x_pct, y_pct, page_url, parent_id
       FROM comments
       WHERE prototype_id = $1
       ORDER BY created_at ASC`,
      [req.params.prototypeId]
    );

    const parents = [];
    const replyMap = {};

    rows.forEach(r => {
      if (r.parent_id) {
        if (!replyMap[r.parent_id]) replyMap[r.parent_id] = [];
        replyMap[r.parent_id].push({ id: r.id, email: r.email, comment: r.comment, created_at: r.created_at });
      } else {
        parents.push(r);
      }
    });

    const result = parents.map((r, i) => ({
      ...r,
      order: i + 1,
      replies: replyMap[r.id] || [],
    }));

    res.json(result);
  } catch (err) {
    console.error('GET /comments error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.patch('/comments/:commentId', async (req, res) => {
  const { comment } = req.body;
  if (!comment || !comment.trim()) return res.status(400).json({ error: 'Comment is required.' });
  const { rows } = await getDb().query('SELECT id FROM comments WHERE id = $1', [req.params.commentId]);
  if (!rows.length) return res.status(404).json({ error: 'Not found.' });
  await getDb().query('UPDATE comments SET comment = $1 WHERE id = $2', [comment.trim(), req.params.commentId]);
  res.json({ ok: true });
});

router.delete('/comments/:commentId', async (req, res) => {
  const { rows } = await getDb().query('SELECT id FROM comments WHERE id = $1', [req.params.commentId]);
  if (!rows.length) return res.status(404).json({ error: 'Not found.' });
  await getDb().query('DELETE FROM comments WHERE id = $1', [req.params.commentId]);
  res.json({ ok: true });
});

router.post('/nav', async (req, res) => {
  const { prototypeId, pageUrl } = req.body;
  if (!prototypeId || !pageUrl) return res.status(400).json({ error: 'prototypeId and pageUrl are required.' });
  const email = req.body.email || 'local@test.com';
  await getDb().query(
    'INSERT INTO nav_events (prototype_id, email, page_url, occurred_at) VALUES ($1,$2,$3,$4)',
    [prototypeId, email, String(pageUrl).slice(0, 500), new Date().toISOString()]
  );
  res.status(201).json({ ok: true });
});

router.get('/explanations/:prototypeId', async (req, res) => {
  const { rows } = await getDb().query(
    `SELECT id, element_selector, x_pct, y_pct, page_url, body, created_at, updated_at
     FROM explanations
     WHERE prototype_id = $1
     ORDER BY created_at ASC`,
    [req.params.prototypeId]
  );
  res.json(rows);
});

router.post('/explanations', async (req, res) => {
  const { prototypeId, elementSelector, xPct, yPct, pageUrl, body } = req.body;
  if (!prototypeId || !elementSelector || !body || !body.trim()) {
    return res.status(400).json({ error: 'prototypeId, elementSelector, and body are required.' });
  }
  const id = nanoid(12);
  const now = new Date().toISOString();
  try {
    await getDb().query(
      `INSERT INTO explanations (id, prototype_id, element_selector, x_pct, y_pct, page_url, body, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, prototypeId, elementSelector,
       typeof xPct === 'number' ? xPct : null,
       typeof yPct === 'number' ? yPct : null,
       pageUrl || null, body.trim(), now, now]
    );
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Explanation already exists for this element.' });
    throw e;
  }
  res.status(201).json({ ok: true, id });
});

router.patch('/explanations/:id', async (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'body is required.' });
  const { rows } = await getDb().query('SELECT id FROM explanations WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found.' });
  await getDb().query(
    'UPDATE explanations SET body = $1, updated_at = $2 WHERE id = $3',
    [body.trim(), new Date().toISOString(), req.params.id]
  );
  res.json({ ok: true });
});

router.delete('/explanations/:id', async (req, res) => {
  const { rows } = await getDb().query('SELECT id FROM explanations WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found.' });
  await getDb().query('DELETE FROM explanations WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
