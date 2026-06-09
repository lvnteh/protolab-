// src/routes/api.js
const express = require('express');
const { nanoid } = require('nanoid');
const { getDb } = require('../db');
const customerAuth = require('../middleware/customerAuth');

const router = express.Router();

router.post('/comments', customerAuth, (req, res) => {
  const { prototypeId, type, comment, element, breadcrumb, pageUrl } = req.body;
  const email = req.session.customerEmail;

  if (!comment || !comment.trim()) return res.status(400).json({ error: 'Comment is required.' });
  if (!['general', 'element'].includes(type)) return res.status(400).json({ error: 'Invalid type.' });
  if (req.session.prototypeId !== prototypeId) return res.status(403).json({ error: 'Forbidden.' });

  getDb().prepare(`
    INSERT INTO comments
      (id, prototype_id, email, type, element_selector, element_label, element_tag,
       breadcrumb, comment, page_url, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    nanoid(12), prototypeId, email, type,
    element?.selector || null,
    element?.label    || null,
    element?.tagName  || null,
    breadcrumb ? JSON.stringify(breadcrumb) : null,
    comment.trim(),
    pageUrl || null,
    new Date().toISOString()
  );

  res.status(201).json({ ok: true });
});

router.get('/comments/:prototypeId', customerAuth, (req, res) => {
  if (req.session.prototypeId !== req.params.prototypeId) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  const rows = getDb().prepare(
    `SELECT id, email, element_selector, element_label, comment, created_at
     FROM comments
     WHERE prototype_id = ? AND type = 'element'
     ORDER BY created_at ASC`
  ).all(req.params.prototypeId);
  res.json(rows.map((r, i) => ({ ...r, order: i + 1 })));
});

module.exports = router;
