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

  // Widen the type CHECK to allow 'reply' and 'range' rows (atomic drop + add)
  await _pool.query(`
    DO $$ BEGIN
      ALTER TABLE comments DROP CONSTRAINT IF EXISTS comments_type_check;
      ALTER TABLE comments ADD CONSTRAINT comments_type_check
        CHECK(type IN ('general', 'element', 'reply', 'range'));
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

  // --- Markdown sharing: content_type on versions (authoritative) + prototypes (mirror) ---
  // Existing rows default to 'html' so every current prototype keeps rendering as HTML.
  await _pool.query(`ALTER TABLE prototype_versions ADD COLUMN IF NOT EXISTS content_type TEXT NOT NULL DEFAULT 'html'`);
  await _pool.query(`ALTER TABLE prototypes         ADD COLUMN IF NOT EXISTS content_type TEXT NOT NULL DEFAULT 'html'`);

  // Range (text-selection) comments: anchor columns. Nullable — only range rows use them.
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS anchor_quote  TEXT`);
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS anchor_prefix TEXT`);
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS anchor_suffix TEXT`);
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS anchor_start  INTEGER`);
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS anchor_end    INTEGER`);

  // K. schema_migrations marker table. Lets us skip the expensive backfill scan on
  //    normal boots once it has run and no legacy (unversioned) prototypes remain.
  await _pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT
    )
  `);

  // --- Organizations (P1 multi-tenancy) ---
  // The tenant boundary moves from the individual user (owner_id) to an org.
  // Users belong to N orgs via org_memberships; a prototype belongs to an org;
  // access is decided by the caller's role in that org. See
  // docs/superpowers/specs/2026-07-29-org-multitenancy-design.md.

  await _pool.query(`
    CREATE TABLE IF NOT EXISTS organizations (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      created_at  TEXT NOT NULL
    )
  `);

  await _pool.query(`
    CREATE TABLE IF NOT EXISTS org_memberships (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
      role        TEXT NOT NULL CONSTRAINT org_memberships_role_check CHECK (role IN ('admin','viewer')),
      created_at  TEXT NOT NULL,
      UNIQUE (org_id, user_id)
    )
  `);
  await _pool.query(`CREATE INDEX IF NOT EXISTS idx_memberships_user ON org_memberships(user_id)`);
  await _pool.query(`CREATE INDEX IF NOT EXISTS idx_memberships_org  ON org_memberships(org_id)`);

  // org_id is the tenant boundary on prototypes. Nullable at first (existing
  // rows), backfilled by the migration below, enforced in code (mirrors owner_id).
  await _pool.query(`ALTER TABLE prototypes ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(id)`);
  await _pool.query(`ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(id)`);

  // Scale indexes. owner_id and these prototype_id FKs were unindexed — every
  // admin list / comment fetch / analytics query was a full table scan.
  await _pool.query(`CREATE INDEX IF NOT EXISTS idx_prototypes_org      ON prototypes(org_id, created_at)`);
  await _pool.query(`CREATE INDEX IF NOT EXISTS idx_prototypes_owner    ON prototypes(owner_id)`);
  await _pool.query(`CREATE INDEX IF NOT EXISTS idx_comments_prototype  ON comments(prototype_id)`);
  await _pool.query(`CREATE INDEX IF NOT EXISTS idx_access_log_proto    ON access_log(prototype_id)`);

  // L. Deletion FKs. These columns already exist from earlier phases but were
  //    created WITHOUT the ON DELETE behavior that makes `DELETE FROM prototypes`
  //    work in one shot. We add them idempotently via DROP IF EXISTS + ADD.
  //
  //    Cascade vs SET NULL, per column, and WHY:
  //      * comments.prototype_id  -> CASCADE:  a comment belongs to a prototype; if the
  //        prototype is gone the comment is meaningless, so it should be removed. (This
  //        column previously had NO FK at all, so orphaned comment rows could block or
  //        outlive a delete.)
  //      * comments.version_id    -> SET NULL: a comment should SURVIVE its version being
  //        pruned. version_id is nullable and NULL is already treated as "legacy/v1" by
  //        apiV1.js, so nulling it degrades gracefully instead of deleting feedback.
  //      * prototypes.published_version_id / draft_version_id -> SET NULL: these are
  //        pointers back into prototype_versions. Without ON DELETE they BLOCK deleting a
  //        prototype (deleting its versions violates the pointer FK). SET NULL lets the
  //        version cascade-delete fire and nulls the now-dangling pointer. The
  //        prototypes<->prototype_versions cycle is safe for SET NULL: when a prototype is
  //        deleted its versions cascade-delete, which fires SET NULL on the very rows being
  //        removed — Postgres handles concurrent set-null-on-deleting-row fine.
  //      * access_log.prototype_id / nav_events.prototype_id -> CASCADE: telemetry rows are
  //        only meaningful with their prototype; they had NO FK before, so they neither
  //        cascaded nor blocked, just leaked. CASCADE cleans them up on delete.
  //
  //    Each ADD CONSTRAINT would FAIL if existing data violates it, so we first NULL out
  //    (SET NULL cols) or delete (CASCADE cols) any dangling references before adding.
  await _pool.query(`
    DO $$ BEGIN
      -- Clean dangling refs so the constraints can be added on a dirty DB.
      DELETE FROM comments  c WHERE NOT EXISTS (SELECT 1 FROM prototypes p WHERE p.id = c.prototype_id);
      UPDATE comments SET version_id = NULL
        WHERE version_id IS NOT NULL
          AND version_id NOT IN (SELECT id FROM prototype_versions);
      UPDATE prototypes SET published_version_id = NULL
        WHERE published_version_id IS NOT NULL
          AND published_version_id NOT IN (SELECT id FROM prototype_versions);
      UPDATE prototypes SET draft_version_id = NULL
        WHERE draft_version_id IS NOT NULL
          AND draft_version_id NOT IN (SELECT id FROM prototype_versions);
      DELETE FROM access_log a WHERE NOT EXISTS (SELECT 1 FROM prototypes p WHERE p.id = a.prototype_id);
      DELETE FROM nav_events  n WHERE NOT EXISTS (SELECT 1 FROM prototypes p WHERE p.id = n.prototype_id);

      ALTER TABLE comments   DROP CONSTRAINT IF EXISTS comments_prototype_fk;
      ALTER TABLE comments   ADD  CONSTRAINT comments_prototype_fk
        FOREIGN KEY (prototype_id) REFERENCES prototypes(id) ON DELETE CASCADE;

      -- Drop the auto-generated FK from the original "ADD COLUMN ... REFERENCES"
      -- (default NO ACTION) as well as our named one, then re-add with SET NULL.
      ALTER TABLE comments   DROP CONSTRAINT IF EXISTS comments_version_id_fkey;
      ALTER TABLE comments   DROP CONSTRAINT IF EXISTS comments_version_fk;
      ALTER TABLE comments   ADD  CONSTRAINT comments_version_fk
        FOREIGN KEY (version_id) REFERENCES prototype_versions(id) ON DELETE SET NULL;

      ALTER TABLE prototypes DROP CONSTRAINT IF EXISTS prototypes_published_version_id_fkey;
      ALTER TABLE prototypes DROP CONSTRAINT IF EXISTS prototypes_pub_ver_fk;
      ALTER TABLE prototypes ADD  CONSTRAINT prototypes_pub_ver_fk
        FOREIGN KEY (published_version_id) REFERENCES prototype_versions(id) ON DELETE SET NULL;

      ALTER TABLE prototypes DROP CONSTRAINT IF EXISTS prototypes_draft_version_id_fkey;
      ALTER TABLE prototypes DROP CONSTRAINT IF EXISTS prototypes_draft_ver_fk;
      ALTER TABLE prototypes ADD  CONSTRAINT prototypes_draft_ver_fk
        FOREIGN KEY (draft_version_id) REFERENCES prototype_versions(id) ON DELETE SET NULL;

      ALTER TABLE access_log DROP CONSTRAINT IF EXISTS access_log_prototype_fk;
      ALTER TABLE access_log ADD  CONSTRAINT access_log_prototype_fk
        FOREIGN KEY (prototype_id) REFERENCES prototypes(id) ON DELETE CASCADE;

      ALTER TABLE nav_events DROP CONSTRAINT IF EXISTS nav_events_prototype_fk;
      ALTER TABLE nav_events ADD  CONSTRAINT nav_events_prototype_fk
        FOREIGN KEY (prototype_id) REFERENCES prototypes(id) ON DELETE CASCADE;
    END $$
  `);

  // I. Backfill: every prototype with no versions becomes "v1, published" pointing
  //    at its existing filename. Idempotent — only fires for unversioned prototypes.
  //
  //    CONCURRENCY / DEPLOY SAFETY. This loop runs on EVERY boot. Under multi-instance
  //    startup or parallel Jest workers, two connections could both SELECT the same
  //    unversioned prototype and both INSERT "v1" -> UNIQUE(prototype_id, version)
  //    violation, crashing startup. We defend with BOTH layers:
  //      (a) a Postgres ADVISORY LOCK on a fixed key so only one connection runs the
  //          backfill section at a time. We take/release it on a DEDICATED client so the
  //          lock and unlock are guaranteed to be the same connection, released in finally.
  //      (b) ON CONFLICT (prototype_id, version) DO NOTHING on the INSERT so that even if
  //          a race slipped through, a lost insert is a no-op rather than a crash. When the
  //          insert did nothing we re-SELECT the existing v1 id so the pointer/version_id
  //          updates still target the correct row.
  //    Marker optimization: once 'v1-version-backfill' is recorded AND no unversioned
  //    prototypes remain, we skip the per-row work. The WHERE-NOT-EXISTS guard still runs
  //    (cheap) so a newly-appearing legacy prototype is never missed; the marker only lets
  //    us avoid the loop body when there is nothing to do.
  const BACKFILL_LOCK_KEY = 91537;
  const lockClient = await _pool.connect();
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [BACKFILL_LOCK_KEY]);

    const { rows: markerRows } = await lockClient.query(
      'SELECT 1 FROM schema_migrations WHERE name = $1', ['v1-version-backfill']);
    const markerPresent = markerRows.length > 0;

    const { rows: unversioned } = await lockClient.query(`
      SELECT p.id, p.filename FROM prototypes p
      WHERE NOT EXISTS (SELECT 1 FROM prototype_versions v WHERE v.prototype_id = p.id)
    `);

    // Skip the expensive path only when the marker exists AND there is genuinely
    // nothing to backfill. Otherwise fall through and process the rows.
    if (!(markerPresent && unversioned.length === 0)) {
      for (const p of unversioned) {
        const client = await _pool.connect();
        try {
          await client.query('BEGIN');
          const vId = nanoid(12);
          const ins = await client.query(
            `INSERT INTO prototype_versions (id, prototype_id, version, filename, status, created_at)
             VALUES ($1, $2, 1, $3, 'published', $4)
             ON CONFLICT (prototype_id, version) DO NOTHING
             RETURNING id`,
            [vId, p.id, p.filename, new Date().toISOString()]
          );
          // If a concurrent worker beat us to it, the insert did nothing — re-select the
          // existing v1 id so the pointer/version_id updates target the right row.
          let effectiveVId = ins.rows[0] ? ins.rows[0].id : null;
          if (!effectiveVId) {
            const { rows } = await client.query(
              'SELECT id FROM prototype_versions WHERE prototype_id = $1 AND version = 1', [p.id]);
            effectiveVId = rows[0] ? rows[0].id : vId;
          }
          await client.query('UPDATE prototypes SET published_version_id = $1 WHERE id = $2', [effectiveVId, p.id]);
          await client.query(
            'UPDATE comments SET version_id = $1 WHERE prototype_id = $2 AND version_id IS NULL',
            [effectiveVId, p.id]
          );
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      }

      // Record the marker (idempotent) now that the backfill has run to completion.
      await lockClient.query(
        `INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)
         ON CONFLICT (name) DO NOTHING`,
        ['v1-version-backfill', new Date().toISOString()]
      );
    }

    // --- Org multi-tenancy migration (P1) ---
    // Marker-guarded so it runs once. Under the same advisory lock as the v1
    // backfill, so concurrent/multi-instance boots can't double-create the org.
    // Strategy: fold ALL existing data into ONE shared "Default Organization";
    // every existing user becomes an admin of it. See the design spec.
    const { rows: orgMarker } = await lockClient.query(
      'SELECT 1 FROM schema_migrations WHERE name = $1', ['org-multitenancy-v1']);
    const { rows: unassigned } = await lockClient.query(
      'SELECT 1 FROM prototypes WHERE org_id IS NULL LIMIT 1');

    if (orgMarker.length === 0 || unassigned.length > 0) {
      const nowIso = new Date().toISOString();
      // Reuse an existing default org if one is already present (idempotent even
      // if the marker was lost); otherwise create it.
      let { rows: defOrg } = await lockClient.query(
        "SELECT id FROM organizations WHERE name = $1", ['Default Organization']);
      let defaultOrgId = defOrg[0] && defOrg[0].id;
      if (!defaultOrgId) {
        defaultOrgId = nanoid(12);
        await lockClient.query(
          'INSERT INTO organizations (id, name, created_at) VALUES ($1,$2,$3)',
          [defaultOrgId, 'Default Organization', nowIso]);
      }
      // Every existing user becomes an admin of the default org.
      await lockClient.query(
        `INSERT INTO org_memberships (id, org_id, user_id, role, created_at)
         SELECT $1 || u.id, $2, u.id, 'admin', $3 FROM users u
         ON CONFLICT (org_id, user_id) DO NOTHING`,
        ['m_', defaultOrgId, nowIso]);
      // Assign all unowned prototypes + tokens to the default org.
      await lockClient.query('UPDATE prototypes SET org_id = $1 WHERE org_id IS NULL', [defaultOrgId]);
      await lockClient.query('UPDATE api_tokens SET org_id = $1 WHERE org_id IS NULL', [defaultOrgId]);
      await lockClient.query(
        `INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)
         ON CONFLICT (name) DO NOTHING`,
        ['org-multitenancy-v1', nowIso]);
    }

    // --- Self-heal: env admin must always have a Default-Org membership ---
    // The migration block above only enrols users WHILE it runs, and is skipped
    // once the marker exists and no prototypes are unassigned. An env admin
    // seeded AFTER that point (step C, e.g. ADMIN_EMAIL set on a later deploy)
    // would then have zero memberships and be locked out of every admin route by
    // requireOrg. This runs on every boot, is idempotent (ON CONFLICT DO
    // NOTHING), and is scoped to the single configured admin — so it guarantees
    // the operator can always log in without broadly auto-enrolling other users.
    if (config.adminEmail) {
      const adminEmail = config.adminEmail.trim().toLowerCase();
      const { rows: defOrg } = await lockClient.query(
        "SELECT id FROM organizations WHERE name = $1", ['Default Organization']);
      if (defOrg[0]) {
        await lockClient.query(
          `INSERT INTO org_memberships (id, org_id, user_id, role, created_at)
           SELECT 'm_' || u.id, $1, u.id, 'admin', $2
             FROM users u
            WHERE u.email = $3
           ON CONFLICT (org_id, user_id) DO NOTHING`,
          [defOrg[0].id, new Date().toISOString(), adminEmail]);
      }
    }
  } finally {
    // Always release the advisory lock on the same connection that took it.
    await lockClient.query('SELECT pg_advisory_unlock($1)', [BACKFILL_LOCK_KEY]);
    lockClient.release();
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

// Test-isolation helper: wipe all DATA tables (not schema_migrations, which is
// migration bookkeeping) in one FK-safe TRUNCATE. RESTART IDENTITY resets the
// SERIAL sequences on access_log/nav_events; CASCADE lets the single statement
// truncate the whole FK graph regardless of ordering. No-ops if there is no pool
// so callers don't need to guard on initialization order.
async function cleanDb() {
  if (!_pool) return;
  await _pool.query(`
    TRUNCATE TABLE comments, prototype_versions, prototypes, allowlist,
                   access_log, nav_events, explanations, api_tokens,
                   org_memberships, organizations, users
    RESTART IDENTITY CASCADE
  `);
}

module.exports = { initDb, getDb, closeDb, cleanDb };
