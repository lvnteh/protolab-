// src/db.js
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

let _db = null;

function initDb() {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  _db = new Database(config.dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS prototypes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      filename TEXT NOT NULL,
      share_token TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS allowlist (
      prototype_id TEXT NOT NULL,
      email TEXT NOT NULL,
      PRIMARY KEY (prototype_id, email),
      FOREIGN KEY (prototype_id) REFERENCES prototypes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS access_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prototype_id TEXT NOT NULL,
      email TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      user_agent TEXT
    );

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
    );

    CREATE TABLE IF NOT EXISTS nav_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      prototype_id TEXT NOT NULL,
      email        TEXT NOT NULL,
      page_url     TEXT NOT NULL,
      occurred_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_nav_events_proto
      ON nav_events(prototype_id, email, occurred_at);

    CREATE TABLE IF NOT EXISTS explanations (
      id               TEXT PRIMARY KEY,
      prototype_id     TEXT NOT NULL,
      element_selector TEXT NOT NULL,
      x_pct            REAL,
      y_pct            REAL,
      page_url         TEXT,
      body             TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      FOREIGN KEY (prototype_id) REFERENCES prototypes(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_explanations_unique
      ON explanations(prototype_id, element_selector, COALESCE(page_url, ''));
  `);

  // Migrate existing databases
  const cols = _db.pragma('table_info(comments)').map((c) => c.name);
  if (!cols.includes('tag'))   _db.exec('ALTER TABLE comments ADD COLUMN tag TEXT');
  if (!cols.includes('x_pct')) _db.exec('ALTER TABLE comments ADD COLUMN x_pct REAL');
  if (!cols.includes('y_pct')) _db.exec('ALTER TABLE comments ADD COLUMN y_pct REAL');

  // Ensure nav_events index includes email column (re-create if old 2-column version exists)
  const idxInfo = _db.prepare("PRAGMA index_info(idx_nav_events_proto)").all();
  if (idxInfo.length > 0 && !idxInfo.some(c => c.name === 'email')) {
    _db.exec('DROP INDEX IF EXISTS idx_nav_events_proto');
    _db.exec('CREATE INDEX idx_nav_events_proto ON nav_events(prototype_id, email, occurred_at)');
  }

  return _db;
}

function getDb() {
  if (!_db) initDb();
  return _db;
}

module.exports = { initDb, getDb };
