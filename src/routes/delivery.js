// src/routes/delivery.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db');
const { injectSdk } = require('../services/inject');
const customerAuth = require('../middleware/customerAuth');
const config = require('../config');

const router = express.Router();

function readView(name) {
  return fs.readFileSync(path.join(__dirname, '../views', name), 'utf8');
}

// GET /p/:shareToken — email entry form
router.get('/:shareToken', (req, res) => {
  const proto = getDb().prepare(
    'SELECT id FROM prototypes WHERE share_token = ?'
  ).get(req.params.shareToken);
  if (!proto) return res.status(404).send('Prototype not found.');
  const html = readView('email-entry.html').split('{{shareToken}}').join(req.params.shareToken);
  res.send(html);
});

// POST /p/:shareToken/enter — allowlist check, grant session
router.post('/:shareToken/enter', (req, res) => {
  const proto = getDb().prepare(
    'SELECT * FROM prototypes WHERE share_token = ?'
  ).get(req.params.shareToken);
  if (!proto) return res.status(404).send('Prototype not found.');

  const email = (req.body.email || '').trim().toLowerCase();
  const allowed = getDb().prepare(
    'SELECT 1 FROM allowlist WHERE prototype_id = ? AND LOWER(email) = ?'
  ).get(proto.id, email);

  if (!allowed) return res.status(403).send(readView('access-denied.html'));

  req.session.customerEmail = email;
  req.session.prototypeId = proto.id;
  res.redirect(`/p/${req.params.shareToken}/view`);
});

// GET /p/:shareToken/view — serve prototype with SDK injected
router.get('/:shareToken/view', customerAuth, (req, res) => {
  const proto = getDb().prepare(
    'SELECT * FROM prototypes WHERE share_token = ?'
  ).get(req.params.shareToken);
  if (!proto) return res.status(404).send('Prototype not found.');
  if (req.session.prototypeId !== proto.id) return res.status(403).send('Access denied.');

  const filePath = path.join(config.uploadsPath, proto.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Prototype file not found.');

  const raw = fs.readFileSync(filePath, 'utf8');
  const injected = injectSdk(raw, proto.id, req.session.customerEmail);

  getDb().prepare(
    'INSERT INTO access_log (prototype_id, email, opened_at, user_agent) VALUES (?,?,?,?)'
  ).run(proto.id, req.session.customerEmail, new Date().toISOString(), req.headers['user-agent'] || '');

  res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-same-origin');
  res.send(injected);
});

module.exports = router;
