// src/routes/admin.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { nanoid } = require('nanoid');
const { getDb } = require('../db');
const adminAuth = require('../middleware/adminAuth');
const config = require('../config');
const { injectPreview } = require('../services/inject');

const router = express.Router();

const upload = multer({
  dest: config.uploadsPath,
  fileFilter: (_req, file, cb) => cb(null, file.originalname.endsWith('.html')),
});

function readView(name) {
  return fs.readFileSync(path.join(__dirname, '../views', name), 'utf8');
}

function renderView(name, vars) {
  let html = readView(name);
  for (const [k, v] of Object.entries(vars)) {
    html = html.split(`{{${k}}}`).join(String(v));
  }
  return html;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

router.get('/', (_req, res) => res.redirect('/admin/login'));

router.get('/login', (_req, res) => {
  res.send(renderView('admin-login.html', { error: '' }));
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const errorHtml = '<div class="alert">Invalid credentials.</div>';
  if (username !== config.adminUser) return res.status(401).send(renderView('admin-login.html', { error: errorHtml }));
  const valid = await bcrypt.compare(password, config.adminPasswordHash);
  if (!valid) return res.status(401).send(renderView('admin-login.html', { error: errorHtml }));
  req.session.isAdmin = true;
  res.redirect('/admin/prototypes');
});

router.get('/prototypes', adminAuth, (_req, res) => {
  const rows = getDb().prepare(`
    SELECT p.id, p.name, p.share_token, p.created_at,
      (SELECT COUNT(*) FROM allowlist  WHERE prototype_id = p.id) AS allowlist_count,
      (SELECT COUNT(*) FROM access_log WHERE prototype_id = p.id) AS view_count,
      (SELECT COUNT(*) FROM comments   WHERE prototype_id = p.id) AS comment_count
    FROM prototypes p ORDER BY p.created_at DESC
  `).all();
  res.send(renderView('admin-prototypes.html', { prototypesJson: JSON.stringify(rows).replace(/</g, '\\u003c') }));
});

router.get('/upload', adminAuth, (_req, res) => {
  res.send(renderView('admin-upload.html', { success: '' }));
});

router.post('/prototypes', adminAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).send('Only .html files are accepted.');
  const id = nanoid(12);
  const shareToken = nanoid(12);
  const filename = `${id}.html`;
  fs.renameSync(req.file.path, path.join(config.uploadsPath, filename));

  const db = getDb();
  db.prepare(
    'INSERT INTO prototypes (id, name, filename, share_token, created_at) VALUES (?,?,?,?,?)'
  ).run(id, req.body.name || 'Untitled', filename, shareToken, new Date().toISOString());

  const emails = (req.body.allowlist || '').split(/\r?\n/).map(e => e.trim().toLowerCase()).filter(Boolean);
  const ins = db.prepare('INSERT OR IGNORE INTO allowlist (prototype_id, email) VALUES (?,?)');
  for (const email of emails) ins.run(id, email);

  const shareLink = `${config.baseUrl}/p/${shareToken}`;
  const successBanner = `<div class="alert alert-success">Prototype uploaded. Share link: <a href="${shareLink}">${shareLink}</a></div>`;
  res.send(renderView('admin-upload.html', { success: successBanner }));
});

router.get('/prototypes/:id', adminAuth, (req, res) => {
  const proto = getDb().prepare('SELECT * FROM prototypes WHERE id = ?').get(req.params.id);
  if (!proto) return res.status(404).send('Not found.');
  const allowlist = getDb().prepare('SELECT email FROM allowlist WHERE prototype_id = ?')
    .all(proto.id).map(r => r.email).join('\n');
  res.send(renderView('admin-prototype-detail.html', { id: proto.id, name: escapeHtml(proto.name), allowlist: escapeHtml(allowlist) }));
});

router.post('/prototypes/:id/settings', adminAuth, (req, res) => {
  const db = getDb();
  const proto = db.prepare('SELECT id FROM prototypes WHERE id = ?').get(req.params.id);
  if (!proto) return res.status(404).send('Not found.');
  db.prepare('UPDATE prototypes SET name = ? WHERE id = ?').run(req.body.name || 'Untitled', proto.id);
  db.prepare('DELETE FROM allowlist WHERE prototype_id = ?').run(proto.id);
  const emails = (req.body.allowlist || '').split(/\r?\n/).map(e => e.trim().toLowerCase()).filter(Boolean);
  const ins = db.prepare('INSERT OR IGNORE INTO allowlist (prototype_id, email) VALUES (?,?)');
  for (const email of emails) ins.run(proto.id, email);
  res.redirect(`/admin/prototypes/${proto.id}?saved=1`);
});

router.get('/prototypes/:id/allowlist-count', adminAuth, (req, res) => {
  const count = getDb().prepare('SELECT COUNT(*) AS n FROM allowlist WHERE prototype_id = ?').get(req.params.id)?.n ?? 0;
  res.json({ count });
});

router.delete('/prototypes/:id', adminAuth, (req, res) => {
  const db = getDb();
  const proto = db.prepare('SELECT * FROM prototypes WHERE id = ?').get(req.params.id);
  if (!proto) return res.status(404).json({ error: 'Not found.' });
  const filePath = path.join(config.uploadsPath, proto.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  db.prepare('DELETE FROM prototypes WHERE id = ?').run(proto.id);
  res.json({ ok: true });
});

router.post('/prototypes/:id/comments', adminAuth, (req, res) => {
  const { pageSize = 25, offset = 0, sortingKey, sortingOrder = 'asc', filterValues = {} } = req.body || {};
  const allowedSort = ['email', 'type', 'created_at'];
  const orderBy = allowedSort.includes(sortingKey) ? sortingKey : 'created_at';
  const order = sortingOrder === 'desc' ? 'DESC' : 'ASC';

  const typeFilter = filterValues.type;
  const hasFilter = typeFilter && typeFilter.length > 0;
  const filterClause = hasFilter ? ' AND type = ?' : '';
  const filterArgs = hasFilter ? [typeFilter] : [];

  const total = getDb().prepare(
    `SELECT COUNT(*) AS n FROM comments WHERE prototype_id = ?${filterClause}`
  ).get(req.params.id, ...filterArgs).n;

  const rows = getDb().prepare(
    `SELECT * FROM comments WHERE prototype_id = ?${filterClause} ORDER BY ${orderBy} ${order} LIMIT ? OFFSET ?`
  ).all(req.params.id, ...filterArgs, parseInt(pageSize, 10), parseInt(offset, 10)).map(r => ({
    ...r,
    breadcrumb_display: (() => { try { return r.breadcrumb ? JSON.parse(r.breadcrumb).join(' → ') : ''; } catch { return ''; } })(),
  }));
  res.json({ data: rows, totalCount: total });
});

router.post('/prototypes/:id/access-log', adminAuth, (req, res) => {
  const { pageSize = 25, offset = 0 } = req.body || {};
  const total = getDb().prepare('SELECT COUNT(*) AS n FROM access_log WHERE prototype_id = ?').get(req.params.id).n;
  const rows = getDb().prepare(
    'SELECT * FROM access_log WHERE prototype_id = ? ORDER BY opened_at DESC LIMIT ? OFFSET ?'
  ).all(req.params.id, parseInt(pageSize, 10), parseInt(offset, 10));
  res.json({ data: rows, totalCount: total });
});

router.get('/prototypes/:id/preview', adminAuth, (req, res) => {
  const db = getDb();
  const proto = db.prepare('SELECT * FROM prototypes WHERE id = ?').get(req.params.id);
  if (!proto) return res.status(404).send('Prototype not found.');

  if (path.basename(proto.filename) !== proto.filename) return res.status(400).send('Invalid prototype filename.');
  const filePath = path.join(config.uploadsPath, proto.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Prototype file not found.');

  const highlightId = req.query.comment || '';
  const comments = db.prepare(
    `SELECT id, email, element_selector, element_label, comment, created_at
     FROM comments WHERE prototype_id = ? AND type = 'element'
     ORDER BY created_at ASC`
  ).all(proto.id).map((r, i) => ({ ...r, order: i + 1 }));

  const raw = fs.readFileSync(filePath, 'utf8');
  const html = injectPreview(raw, proto.id, highlightId, JSON.stringify(comments));
  res.send(html);
});

module.exports = router;
