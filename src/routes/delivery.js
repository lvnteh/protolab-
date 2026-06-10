// src/routes/delivery.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db');
const { injectSdk } = require('../services/inject');
const config = require('../config');

const router = express.Router();

router.get('/:shareToken', async (req, res) => {
  const { rows } = await getDb().query(
    'SELECT * FROM prototypes WHERE share_token = $1',
    [req.params.shareToken]
  );
  const proto = rows[0];
  if (!proto) return res.status(404).send('Prototype not found.');

  const filePath = path.join(config.uploadsPath, proto.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Prototype file not found.');

  const raw = fs.readFileSync(filePath, 'utf8');
  const injected = injectSdk(raw, proto.id, 'local@test.com');

  await getDb().query(
    'INSERT INTO access_log (prototype_id, email, opened_at, user_agent) VALUES ($1,$2,$3,$4)',
    [proto.id, 'local@test.com', new Date().toISOString(), req.headers['user-agent'] || '']
  );

  res.send(injected);
});

module.exports = router;
