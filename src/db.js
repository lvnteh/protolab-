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
