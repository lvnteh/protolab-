// src/db.js
const { Pool } = require('pg');
const { nanoid } = require('nanoid');
const config = require('./config');

let _pool = null;

async function initDb() {
  if (!_pool) {
    // Managed Postgres (e.g. Railway) requires SSL; a local/dev server usually
    // doesn't. Disable SSL for localhost or when PGSSLMODE=disable is set.
    const url = config.databaseUrl || '';
    const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || process.env.PGSSLMODE === 'disable';
    _pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: isLocal ? false : { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
    });
  }

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
      type TEXT NOT NULL CONSTRAINT comments_type_check CHECK(type IN ('general', 'element')),
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

  // Widen the type CHECK to also allow 'reply' rows (atomic drop + add)
  await _pool.query(`
    DO $$ BEGIN
      ALTER TABLE comments DROP CONSTRAINT IF EXISTS comments_type_check;
      ALTER TABLE comments ADD CONSTRAINT comments_type_check
        CHECK(type IN ('general', 'element', 'reply'));
    END $$
  `);

  // Add parent_id FK (idempotent)
  await _pool.query(`
    ALTER TABLE comments
      ADD COLUMN IF NOT EXISTS parent_id TEXT
      REFERENCES comments(id) ON DELETE CASCADE
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

  // --- Multi-tenancy ---
  // Order matters: (A) users must exist before the owner_id FK references it and
  // before the admin is seeded; (D) backfill needs the seeded row to exist.

  // A. Users table (email/password accounts that own prototypes)
  await _pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // B. owner_id on prototypes (nullable — existing rows have no owner yet; a
  //    NOT NULL constraint would fail on a populated table). Ownership is
  //    enforced in code, not the schema. Mirrors the parent_id pattern above.
  await _pool.query(`
    ALTER TABLE prototypes
      ADD COLUMN IF NOT EXISTS owner_id TEXT
      REFERENCES users(id)
  `);

  // C. Seed the env admin as the first user (only when the users table is
  //    empty, so it fires once and is idempotent across reboots).
  if (config.adminEmail && config.adminPasswordHash) {
    const adminEmail = config.adminEmail.trim().toLowerCase();
    await _pool.query(
      `INSERT INTO users (id, email, password_hash, created_at)
       SELECT $1, $2, $3, $4
       WHERE NOT EXISTS (SELECT 1 FROM users)`,
      [nanoid(12), adminEmail, config.adminPasswordHash, new Date().toISOString()]
    );

    // Resolve the admin id whether or not this boot performed the insert.
    const { rows: adminRows } = await _pool.query(
      'SELECT id FROM users WHERE email = $1',
      [adminEmail]
    );

    // D. Backfill: assign any unowned prototypes to the seeded admin.
    if (adminRows[0]) {
      await _pool.query(
        'UPDATE prototypes SET owner_id = $1 WHERE owner_id IS NULL',
        [adminRows[0].id]
      );
    }
  }

  // --- Local-AI integration: API tokens + prototype versioning ---

  // E. API tokens (machine auth; one user_id per token, bcrypt-hashed secret)
  await _pool.query(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash   TEXT NOT NULL,
      name         TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      last_used_at TEXT
    )
  `);
  await _pool.query(`CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id)`);

  // F. Prototype versions (linear history; one published + optional draft per proto)
  await _pool.query(`
    CREATE TABLE IF NOT EXISTS prototype_versions (
      id            TEXT PRIMARY KEY,
      prototype_id  TEXT NOT NULL REFERENCES prototypes(id) ON DELETE CASCADE,
      version       INTEGER NOT NULL,
      filename      TEXT NOT NULL,
      status        TEXT NOT NULL CONSTRAINT prototype_versions_status_check
                       CHECK (status IN ('draft', 'published')),
      note          TEXT,
      created_at    TEXT NOT NULL,
      UNIQUE (prototype_id, version)
    )
  `);
  // G. Pointers on prototypes (nullable; enforced in code, mirrors owner_id)
  await _pool.query(`ALTER TABLE prototypes ADD COLUMN IF NOT EXISTS published_version_id TEXT REFERENCES prototype_versions(id)`);
  await _pool.query(`ALTER TABLE prototypes ADD COLUMN IF NOT EXISTS draft_version_id     TEXT REFERENCES prototype_versions(id)`);

  // H. version_id stamp on comments (which version the feedback was made against)
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS version_id TEXT REFERENCES prototype_versions(id)`);

  // J. Comment resolution (Phase 3): when the agent addresses feedback it stamps
  //    resolved_at + the version that fixed it, so pulls can surface only open items.
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS resolved_at TEXT`);
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS resolved_in_version INTEGER`);

  // I. Backfill: every prototype with no versions becomes "v1, published" pointing
  //    at its existing filename. Idempotent — only fires for unversioned prototypes.
  const { rows: unversioned } = await _pool.query(`
    SELECT p.id, p.filename FROM prototypes p
    WHERE NOT EXISTS (SELECT 1 FROM prototype_versions v WHERE v.prototype_id = p.id)
  `);
  for (const p of unversioned) {
    const vId = nanoid(12);
    const client = await _pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO prototype_versions (id, prototype_id, version, filename, status, created_at)
         VALUES ($1, $2, 1, $3, 'published', $4)`,
        [vId, p.id, p.filename, new Date().toISOString()]
      );
      await client.query('UPDATE prototypes SET published_version_id = $1 WHERE id = $2', [vId, p.id]);
      await client.query(
        'UPDATE comments SET version_id = $1 WHERE prototype_id = $2 AND version_id IS NULL',
        [vId, p.id]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

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
