// src/routes/api.js
const express = require('express');
const { nanoid } = require('nanoid');
const { getDb } = require('../db');

const router = express.Router();

const VALID_TAGS = ['bug', 'copy', 'question', 'idea', 'other'];

router.post('/comments', (req, res) => {
  const { prototypeId, type, comment, element, breadcrumb, pageUrl, tag, xPct, yPct, email } = req.body;
  const commentEmail = email || 'local@test.com';

  if (!comment || !comment.trim()) return res.status(400).json({ error: 'Comment is required.' });
  if (!['general', 'element'].includes(type)) return res.status(400).json({ error: 'Invalid type.' });

  const id = nanoid(12);
  getDb().prepare(`
    INSERT INTO comments
      (id, prototype_id, email, type, element_selector, element_label, element_tag,
       breadcrumb, comment, page_url, created_at, tag, x_pct, y_pct)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
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
  );

  res.status(201).json({ ok: true, id });
});

router.get('/comments/:prototypeId', (req, res) => {
  const rows = getDb().prepare(
    `SELECT id, email, element_selector, element_label, comment, created_at, tag, x_pct, y_pct, page_url
     FROM comments
     WHERE prototype_id = ? AND type = 'element'
     ORDER BY created_at ASC`
  ).all(req.params.prototypeId);
  res.json(rows.map((r, i) => ({ ...r, order: i + 1 })));
});

router.patch('/comments/:commentId', (req, res) => {
  const { comment } = req.body;
  if (!comment || !comment.trim()) return res.status(400).json({ error: 'Comment is required.' });
  const row = getDb().prepare('SELECT id FROM comments WHERE id = ?').get(req.params.commentId);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  getDb().prepare('UPDATE comments SET comment = ? WHERE id = ?').run(comment.trim(), req.params.commentId);
  res.json({ ok: true });
});

router.delete('/comments/:commentId', (req, res) => {
  const row = getDb().prepare('SELECT id FROM comments WHERE id = ?').get(req.params.commentId);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  getDb().prepare('DELETE FROM comments WHERE id = ?').run(req.params.commentId);
  res.json({ ok: true });
});

router.post('/nav', (req, res) => {
  const { prototypeId, pageUrl } = req.body;
  if (!prototypeId || !pageUrl) return res.status(400).json({ error: 'prototypeId and pageUrl are required.' });
  const email = req.body.email || 'local@test.com';
  getDb().prepare(
    'INSERT INTO nav_events (prototype_id, email, page_url, occurred_at) VALUES (?,?,?,?)'
  ).run(prototypeId, email, String(pageUrl).slice(0, 500), new Date().toISOString());
  res.status(201).json({ ok: true });
});

router.get('/explanations/:prototypeId', (req, res) => {
  const rows = getDb().prepare(
    `SELECT id, element_selector, x_pct, y_pct, page_url, body, created_at, updated_at
     FROM explanations
     WHERE prototype_id = ?
     ORDER BY created_at ASC`
  ).all(req.params.prototypeId);
  res.json(rows);
});

router.post('/explanations', (req, res) => {
  const { prototypeId, elementSelector, xPct, yPct, pageUrl, body } = req.body;
  if (!prototypeId || !elementSelector || !body || !body.trim()) {
    return res.status(400).json({ error: 'prototypeId, elementSelector, and body are required.' });
  }
  const id = nanoid(12);
  const now = new Date().toISOString();
  try {
    getDb().prepare(`
      INSERT INTO explanations (id, prototype_id, element_selector, x_pct, y_pct, page_url, body, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, prototypeId, elementSelector,
      typeof xPct === 'number' ? xPct : null,
      typeof yPct === 'number' ? yPct : null,
      pageUrl || null,
      body.trim(),
      now, now
    );
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Explanation already exists for this element.' });
    }
    throw e;
  }
  res.status(201).json({ ok: true, id });
});

router.patch('/explanations/:id', (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'body is required.' });
  const row = getDb().prepare('SELECT id FROM explanations WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  getDb().prepare('UPDATE explanations SET body = ?, updated_at = ? WHERE id = ?')
    .run(body.trim(), new Date().toISOString(), req.params.id);
  res.json({ ok: true });
});

router.delete('/explanations/:id', (req, res) => {
  const row = getDb().prepare('SELECT id FROM explanations WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  getDb().prepare('DELETE FROM explanations WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
