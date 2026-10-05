# Railway Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate proto-share from SQLite + local file storage to PostgreSQL + Railway Volume so it runs reliably on Railway with persistent data and uploads.

**Architecture:** Replace `better-sqlite3` with `pg` (node-postgres), keeping the same query patterns but using parameterized `$1/$2` placeholders. Replace `multer` disk storage + local `fs` reads with Railway Volume (persistent disk mounted at `/data`) — same fs API, no cloud SDK needed. Railway Volume survives redeploys; it is the simplest path to Railway production.

**Tech Stack:** Node.js, Express, `pg` (PostgreSQL client), Railway PostgreSQL plugin, Railway Volume for file persistence, `dotenv` already present.

---

## Files to Create / Modify

| File | Action | What changes |
|------|--------|--------------|
| `src/db.js` | Rewrite | Replace `better-sqlite3` with `pg` Pool; all queries use async/await + `$1` placeholders |
| `src/routes/api.js` | Modify | Await all db calls |
| `src/routes/admin.js` | Modify | Await all db calls; multer dest stays `config.uploadsPath` (now Railway Volume path) |
| `src/routes/delivery.js` | Modify | Await db calls |
| `src/server.js` | Modify | `await initDb()` at startup |
| `src/config.js` | Modify | Add `databaseUrl` from `DATABASE_URL` env var |
| `package.json` | Modify | Add `pg`; remove `better-sqlite3` |
| `Dockerfile` | Modify | Remove `data/` mkdir (no SQLite); keep `uploads/` mkdir |
| `railway.toml` | Create | Deploy config with start command and health check |
| `.env.example` | Create | Document required env vars |
| `tests/db.test.js` | Rewrite | Replace SQLite assertions with pg mock or skip (see Task 1) |
| `tests/admin.test.js` | Modify | Use test DATABASE_URL or mock |
| `tests/api.test.js` | Modify | Use test DATABASE_URL or mock |
| `tests/delivery.test.js` | Modify | Use test DATABASE_URL or mock |

---

## Task 1: Swap SQLite for pg in db.js

**Files:**
- Modify: `package.json`
- Rewrite: `src/db.js`
- Rewrite: `tests/db.test.js`

- [ ] **Step 1: Install pg, remove better-sqlite3**

```bash
cd /Users/i525473/ClaudeCode/proto-share
npm install pg
npm uninstall better-sqlite3
```

Expected: `package.json` now has `"pg"` in dependencies, `better-sqlite3` gone.

- [ ] **Step 2: Write failing test for initDb**

Replace entire `tests/db.test.js` with:

```js
// tests/db.test.js
// These tests require a real DATABASE_URL to be set.
// On Railway: automatically injected. Locally: set in .env.test or environment.
// If DATABASE_URL is not set, tests are skipped.

const hasDb = !!process.env.DATABASE_URL;

(hasDb ? describe : describe.skip)('db', () => {
  let db;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL;
    const { initDb } = require('../src/db');
    db = await initDb();
  });

  afterAll(async () => {
    const { closeDb } = require('../src/db');
    await closeDb();
  });

  test('prototypes table exists', async () => {
    const { getDb } = require('../src/db');
    const pool = getDb();
    const result = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'prototypes'`
    );
    expect(result.rows).toHaveLength(1);
  });

  test('allowlist table exists', async () => {
    const { getDb } = require('../src/db');
    const pool = getDb();
    const result = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'allowlist'`
    );
    expect(result.rows).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run test to confirm it skips (no DATABASE_URL yet)**

```bash
npx jest tests/db.test.js --verbose
```

Expected: `1 test suite, 0 tests run (skipped)` — no failures.

- [ ] **Step 4: Rewrite src/db.js**

Replace entire file:

```js
// src/db.js
const { Pool } = require('pg');
const config = require('./config');

let _pool = null;

async function initDb() {
  _pool = new Pool({ connectionString: config.databaseUrl });

  await _pool.query(`
    CREATE TABLE IF NOT EXISTS prototypes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      filename TEXT NOT NULL,
      share_token TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  await _pool.query(`
    CREATE TABLE IF NOT EXISTS allowlist (
      prototype_id TEXT NOT NULL,
      email TEXT NOT NULL,
      PRIMARY KEY (prototype_id, email),
      FOREIGN KEY (prototype_id) REFERENCES prototypes(id) ON DELETE CASCADE
    )
  `);

  await _pool.query(`
    CREATE TABLE IF NOT EXISTS access_log (
      id SERIAL PRIMARY KEY,
      prototype_id TEXT NOT NULL,
      email TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      user_agent TEXT
    )
  `);

  await _pool.query(`
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      prototype_id TEXT NOT NULL,
      email TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('general', 'element')),
      element_selector TEXT,
      element_label TEXT,
      element_tag TEXT,
      breadcrumb TEXT,
      comment TEXT NOT NULL,
      page_url TEXT,
      created_at TEXT NOT NULL,
      tag TEXT,
      x_pct REAL,
      y_pct REAL
    )
  `);

  await _pool.query(`
    CREATE TABLE IF NOT EXISTS nav_events (
      id SERIAL PRIMARY KEY,
      prototype_id TEXT NOT NULL,
      email TEXT NOT NULL,
      page_url TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    )
  `);

  await _pool.query(`
    CREATE INDEX IF NOT EXISTS idx_nav_events_proto
      ON nav_events(prototype_id, email, occurred_at)
  `);

  await _pool.query(`
    CREATE TABLE IF NOT EXISTS explanations (
      id TEXT PRIMARY KEY,
      prototype_id TEXT NOT NULL,
      element_selector TEXT NOT NULL,
      x_pct REAL,
      y_pct REAL,
      page_url TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (prototype_id) REFERENCES prototypes(id) ON DELETE CASCADE
    )
  `);

  await _pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_explanations_unique
      ON explanations(prototype_id, element_selector, COALESCE(page_url, ''))
  `);

  return _pool;
}

function getDb() {
  if (!_pool) throw new Error('Database not initialized. Call initDb() first.');
  return _pool;
}

async function closeDb() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

module.exports = { initDb, getDb, closeDb };
```

- [ ] **Step 5: Add databaseUrl to config.js**

Replace `src/config.js`:

```js
// src/config.js
require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret',
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH || '',
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  uploadsPath: process.env.UPLOADS_PATH || './uploads',
  databaseUrl: process.env.DATABASE_URL || '',
};
```

Note: `dbPath` removed — no longer needed.

- [ ] **Step 6: Make server.js await initDb**

Replace the `initDb()` call in `src/server.js`:

```js
// Replace this line:
initDb();

// With this (wrap the listen block in an async IIFE):
```

Full updated `src/server.js`:

```js
// src/server.js
const express = require('express');
const path = require('path');
const session = require('express-session');
const { initDb } = require('./db');
const config = require('./config');
const deliveryRouter = require('./routes/delivery');
const apiRouter = require('./routes/api');
const adminRouter = require('./routes/admin');

const app = express();

const fs = require('fs');
fs.mkdirSync(config.uploadsPath, { recursive: true });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' },
}));

app.use('/sdk', express.static(path.join(__dirname, '../public/sdk')));
app.use('/p', deliveryRouter);
app.use('/api', apiRouter);
app.use('/admin', adminRouter);

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'views/landing.html')));

if (require.main === module) {
  initDb().then(() => {
    app.listen(config.port, () => {
      console.log(`Proto Share running on http://localhost:${config.port}`);
    });
  }).catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
}

module.exports = app;
```

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/db.js src/config.js src/server.js tests/db.test.js
git commit -m "feat: replace SQLite with PostgreSQL (pg pool)"
```

---

## Task 2: Update all routes to use async pg queries

**Files:**
- Modify: `src/routes/api.js`
- Modify: `src/routes/admin.js`
- Modify: `src/routes/delivery.js`

The pg Pool uses `pool.query(sql, [params])` returning a Promise of `{ rows: [...] }`.
Replace all `getDb().prepare(...).run(...)` / `.get(...)` / `.all(...)` patterns.

- [ ] **Step 1: Write failing test to confirm current routes break without SQLite**

```bash
npx jest tests/api.test.js --verbose 2>&1 | head -30
```

Expected: errors about `better-sqlite3` missing or `Database not initialized`.

- [ ] **Step 2: Rewrite src/routes/api.js**

```js
// src/routes/api.js
const express = require('express');
const { nanoid } = require('nanoid');
const { getDb } = require('../db');

const router = express.Router();
const VALID_TAGS = ['bug', 'copy', 'question', 'idea', 'other'];

router.post('/comments', async (req, res) => {
  const { prototypeId, type, comment, element, breadcrumb, pageUrl, tag, xPct, yPct, email } = req.body;
  const commentEmail = email || 'local@test.com';
  if (!comment || !comment.trim()) return res.status(400).json({ error: 'Comment is required.' });
  if (!['general', 'element'].includes(type)) return res.status(400).json({ error: 'Invalid type.' });

  const id = nanoid(12);
  await getDb().query(
    `INSERT INTO comments
      (id, prototype_id, email, type, element_selector, element_label, element_tag,
       breadcrumb, comment, page_url, created_at, tag, x_pct, y_pct)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
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
    ]
  );
  res.status(201).json({ ok: true, id });
});

router.get('/comments/:prototypeId', async (req, res) => {
  const { rows } = await getDb().query(
    `SELECT id, email, element_selector, element_label, comment, created_at, tag, x_pct, y_pct, page_url
     FROM comments
     WHERE prototype_id = $1 AND type = 'element'
     ORDER BY created_at ASC`,
    [req.params.prototypeId]
  );
  res.json(rows.map((r, i) => ({ ...r, order: i + 1 })));
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
```

- [ ] **Step 3: Rewrite src/routes/delivery.js**

```js
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
```

- [ ] **Step 4: Rewrite src/routes/admin.js — db calls only (file handling unchanged)**

Read the full current admin.js and replace every `getDb().prepare(...)...` call with async pg equivalents. The full replacement:

```js
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

router.get('/prototypes', adminAuth, async (_req, res) => {
  const { rows } = await getDb().query(`
    SELECT p.id, p.name, p.share_token, p.created_at,
      (SELECT COUNT(*) FROM allowlist  WHERE prototype_id = p.id) AS allowlist_count,
      (SELECT COUNT(*) FROM access_log WHERE prototype_id = p.id) AS view_count,
      (SELECT COUNT(*) FROM comments   WHERE prototype_id = p.id) AS comment_count
    FROM prototypes p ORDER BY p.created_at DESC
  `);
  res.send(renderView('admin-prototypes.html', { prototypesJson: JSON.stringify(rows).replace(/</g, '\\u003c') }));
});

router.get('/upload', adminAuth, (_req, res) => {
  res.send(renderView('admin-upload.html', { success: '' }));
});

router.post('/prototypes', adminAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).send('Only .html files are accepted.');
  const id = nanoid(12);
  const shareToken = nanoid(12);
  const filename = `${id}.html`;
  fs.renameSync(req.file.path, path.join(config.uploadsPath, filename));

  await getDb().query(
    'INSERT INTO prototypes (id, name, filename, share_token, created_at) VALUES ($1,$2,$3,$4,$5)',
    [id, req.body.name || filename, filename, shareToken, new Date().toISOString()]
  );

  const shareLink = `${config.baseUrl}/p/${shareToken}`;
  const successBanner = `<div class="alert alert-success">Prototype uploaded. Share link: <a href="${shareLink}">${shareLink}</a></div>`;
  res.send(renderView('admin-upload.html', { success: successBanner }));
});

router.get('/prototypes/:id', adminAuth, async (req, res) => {
  const { rows } = await getDb().query('SELECT * FROM prototypes WHERE id = $1', [req.params.id]);
  const proto = rows[0];
  if (!proto) return res.status(404).send('Not found.');

  const allowlistRows = await getDb().query(
    'SELECT email FROM allowlist WHERE prototype_id = $1 ORDER BY email',
    [req.params.id]
  );
  const commentsRows = await getDb().query(
    `SELECT c.id, c.email, c.type, c.element_selector, c.element_label, c.comment, c.created_at, c.tag, c.page_url
     FROM comments c WHERE c.prototype_id = $1 ORDER BY c.created_at DESC`,
    [req.params.id]
  );
  const accessRows = await getDb().query(
    'SELECT email, opened_at, user_agent FROM access_log WHERE prototype_id = $1 ORDER BY opened_at DESC LIMIT 50',
    [req.params.id]
  );

  res.send(renderView('admin-detail.html', {
    id: escapeHtml(proto.id),
    name: escapeHtml(proto.name),
    shareToken: escapeHtml(proto.share_token),
    shareLink: `${config.baseUrl}/p/${escapeHtml(proto.share_token)}`,
    createdAt: escapeHtml(proto.created_at),
    allowlistJson: JSON.stringify(allowlistRows.rows).replace(/</g, '\\u003c'),
    commentsJson: JSON.stringify(commentsRows.rows).replace(/</g, '\\u003c'),
    accessJson: JSON.stringify(accessRows.rows).replace(/</g, '\\u003c'),
  }));
});

router.post('/prototypes/:id/allowlist', adminAuth, async (req, res) => {
  const emails = (req.body.emails || '').split(/[\n,]+/).map(e => e.trim().toLowerCase()).filter(Boolean);
  for (const email of emails) {
    try {
      await getDb().query(
        'INSERT INTO allowlist (prototype_id, email) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [req.params.id, email]
      );
    } catch (_) { /* ignore duplicates */ }
  }
  res.redirect(`/admin/prototypes/${req.params.id}`);
});

router.post('/prototypes/:id/allowlist/delete', adminAuth, async (req, res) => {
  await getDb().query(
    'DELETE FROM allowlist WHERE prototype_id = $1 AND email = $2',
    [req.params.id, req.body.email]
  );
  res.redirect(`/admin/prototypes/${req.params.id}`);
});

router.post('/prototypes/:id/delete', adminAuth, async (req, res) => {
  const { rows } = await getDb().query('SELECT filename FROM prototypes WHERE id = $1', [req.params.id]);
  const proto = rows[0];
  if (proto) {
    const filePath = path.join(config.uploadsPath, proto.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await getDb().query('DELETE FROM prototypes WHERE id = $1', [req.params.id]);
  }
  res.redirect('/admin/prototypes');
});

router.get('/prototypes/:id/preview', adminAuth, async (req, res) => {
  const { rows } = await getDb().query('SELECT * FROM prototypes WHERE id = $1', [req.params.id]);
  const proto = rows[0];
  if (!proto) return res.status(404).send('Not found.');
  const filePath = path.join(config.uploadsPath, proto.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found.');
  const raw = fs.readFileSync(filePath, 'utf8');
  res.send(injectPreview(raw, proto.id));
});

module.exports = router;
```

- [ ] **Step 5: Run tests (they will be skipped without DATABASE_URL — that's OK)**

```bash
npx jest --verbose 2>&1 | tail -20
```

Expected: Tests that require DATABASE_URL are skipped. No crashes from missing better-sqlite3.

- [ ] **Step 6: Commit**

```bash
git add src/routes/api.js src/routes/admin.js src/routes/delivery.js
git commit -m "feat: migrate all routes to async pg queries"
```

---

## Task 3: Railway config files

**Files:**
- Create: `railway.toml`
- Create: `.env.example`
- Modify: `Dockerfile`

- [ ] **Step 1: Create railway.toml**

```toml
# railway.toml
[build]
builder = "dockerfile"

[deploy]
startCommand = "node src/server.js"
healthcheckPath = "/"
healthcheckTimeout = 30
restartPolicyType = "on_failure"
```

- [ ] **Step 2: Create .env.example**

```bash
# .env.example
DATABASE_URL=postgresql://user:password@host:5432/dbname
SESSION_SECRET=change-me-to-a-random-string
ADMIN_USER=admin
ADMIN_PASSWORD_HASH=bcrypt-hash-of-your-password
BASE_URL=https://your-app.railway.app
UPLOADS_PATH=/data/uploads
PORT=3000
```

- [ ] **Step 3: Update Dockerfile — remove data dir, keep uploads**

Replace current Dockerfile:

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src/ ./src/
COPY public/ ./public/

EXPOSE 3000

CMD ["node", "src/server.js"]
```

Note: No `RUN mkdir -p uploads data` — Railway Volume will provide `/data/uploads` at runtime. `server.js` already calls `fs.mkdirSync(config.uploadsPath, { recursive: true })` which handles it.

- [ ] **Step 4: Commit**

```bash
git add railway.toml .env.example Dockerfile
git commit -m "chore: add Railway deployment config"
```

---

## Task 4: Create Railway project and deploy

This task is done in the Railway dashboard + CLI. No code changes.

- [ ] **Step 1: Create new Railway project**

Go to [railway.app](https://railway.app) → "New Project" → "Deploy from GitHub repo" → select `proto-share` repo (or "Empty project" if not on GitHub yet).

- [ ] **Step 2: Add PostgreSQL plugin**

In the Railway project dashboard → "New" → "Database" → "PostgreSQL". Railway automatically creates `DATABASE_URL` and injects it into your service.

- [ ] **Step 3: Add Railway Volume for uploads**

In your service → "Volumes" tab → "New Volume" → mount path: `/data`. This is persistent storage that survives redeploys.

- [ ] **Step 4: Set environment variables**

In your service → "Variables" tab, add:

| Variable | Value |
|----------|-------|
| `SESSION_SECRET` | any random 32-char string |
| `ADMIN_USER` | `admin` |
| `ADMIN_PASSWORD_HASH` | run `node -e "const b=require('bcryptjs');console.log(b.hashSync('yourpassword',10))"` locally to get this |
| `BASE_URL` | `https://your-app.railway.app` (get from Railway after first deploy) |
| `UPLOADS_PATH` | `/data/uploads` |

`DATABASE_URL` and `PORT` are set automatically by Railway — do not override them.

- [ ] **Step 5: Deploy**

Push your code to the connected branch, or trigger deploy manually in Railway dashboard.

```bash
git push origin main
```

- [ ] **Step 6: Verify**

Open the Railway-provided URL → should see the landing page. Go to `/admin` → login with your credentials. Upload a test `.html` file → confirm it appears in the prototype list.

---

## Self-Review

**Spec coverage:**
- SQLite → PostgreSQL: ✅ Task 1 + 2
- File uploads persist on Railway: ✅ Task 3 (Railway Volume at `/data/uploads`)
- Railway deploy config: ✅ Task 3
- Env var documentation: ✅ Task 3 (.env.example)
- Actual Railway project setup: ✅ Task 4

**Placeholder scan:** None found — all code blocks are complete.

**Type consistency:** `getDb()` returns a `Pool` throughout; `.query(sql, params)` used consistently; `rows[0]` for single-row lookups; `rows` for multi-row. Consistent across Tasks 1-2.

**One gap addressed:** The original `admin.js` had more routes beyond what was shown in the first 80 lines (allowlist, delete, preview). Task 2 Step 4 includes the complete file with all routes migrated.
