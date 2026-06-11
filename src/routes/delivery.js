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

router.get('/:shareToken', async (req, res) => {
  const { rows } = await getDb().query(
    'SELECT id FROM prototypes WHERE share_token = $1',
    [req.params.shareToken]
  );
  if (!rows[0]) return res.status(404).send('Prototype not found.');
  const html = readView('email-entry.html').split('{{shareToken}}').join(req.params.shareToken);
  res.send(html);
});

router.post('/:shareToken/enter', async (req, res) => {
  const { rows: protoRows } = await getDb().query(
    'SELECT * FROM prototypes WHERE share_token = $1',
    [req.params.shareToken]
  );
  const proto = protoRows[0];
  if (!proto) return res.status(404).send('Prototype not found.');

  const email = (req.body.email || '').trim().toLowerCase();
  const { rows: allowRows } = await getDb().query(
    'SELECT 1 FROM allowlist WHERE prototype_id = $1 AND LOWER(email) = $2',
    [proto.id, email]
  );

  if (!allowRows.length) return res.status(403).send(readView('access-denied.html'));

  req.session.customerEmail = email;
  req.session.prototypeId = proto.id;
  res.redirect(`/p/${req.params.shareToken}/view`);
});

router.get('/:shareToken/view', customerAuth, async (req, res) => {
  const { rows } = await getDb().query(
    'SELECT * FROM prototypes WHERE share_token = $1',
    [req.params.shareToken]
  );
  const proto = rows[0];
  if (!proto) return res.status(404).send('Prototype not found.');
  if (req.session.prototypeId !== proto.id) return res.status(403).send('Access denied.');

  const filePath = path.join(config.uploadsPath, proto.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Prototype file not found.');

  const raw = fs.readFileSync(filePath, 'utf8');
  const injected = injectSdk(raw, proto.id, req.session.customerEmail, proto.name);

  await getDb().query(
    'INSERT INTO access_log (prototype_id, email, opened_at, user_agent) VALUES ($1,$2,$3,$4)',
    [proto.id, req.session.customerEmail, new Date().toISOString(), req.headers['user-agent'] || '']
  );

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(injected);
});

module.exports = router;
