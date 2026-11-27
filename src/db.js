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

    // Managed Postgres (Railway) can accept the app before the DB is reachable,
    // producing an ETIMEDOUT on the first connect that would otherwise crash the
    // boot (server.js exits on initDb failure). Retry the initial connection with
    // linear backoff so a slow-starting DB self-heals instead of crash-looping.
    let lastErr;
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        const client = await _pool.connect();
        client.release();
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const waitMs = Math.min(attempt * 1000, 5000);
        console.warn(`initDb: Postgres not ready (attempt ${attempt}/10): ${err.code || err.message}; retrying in ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    if (lastErr) throw lastErr;
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

  // Version-scope explanations (mirrors comments.version_id). Nullable: a legacy
  // row carries NULL until the data migration clears it; a new row is stamped
  // with the viewed version by annotations.js.
  await _pool.query(`ALTER TABLE explanations ADD COLUMN IF NOT EXISTS version_id TEXT`);

  // Recreate the uniqueness guard with version in scope. COALESCE(version_id,'')
  // (not NULL-distinct) so two NULL-version rows on one selector still collide —
  // preserving the 23505 -> 409 edit-in-place upsert contract — while the SAME
  // selector/page on a DIFFERENT version is allowed.
  await _pool.query(`DROP INDEX IF EXISTS idx_explanations_unique`);
  await _pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_explanations_unique
      ON explanations(prototype_id, element_selector, COALESCE(page_url, ''), COALESCE(version_id, ''))
  `);
  await _pool.query(`
    CREATE INDEX IF NOT EXISTS idx_explanations_version
      ON explanations(prototype_id, version_id)
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

  // Screenshot context (consented screen-capture). All nullable — legacy comments
  // and comments placed without capture have none. See plans/comment-screenshot-context.md.
  //   screenshot_key   : object-storage key for the full-resolution image (null = no capture)
  //   screenshot_thumb : small inline thumbnail (data URL) for the owner/admin preview
  //   screenshot_w/h   : captured frame dimensions (px)
  //   screenshot_x_pct/y_pct : pin position WITHIN the captured image (0..1); distinct from
  //                            x_pct/y_pct which are the pin's position within the ELEMENT.
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS screenshot_key   TEXT`);
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS screenshot_thumb TEXT`);
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS screenshot_w     INTEGER`);
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS screenshot_h     INTEGER`);
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS screenshot_x_pct REAL`);
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS screenshot_y_pct REAL`);

  // Server-derived comment authorship (Task 6). The SDK still sends a display
  // `email`, but it can NEVER establish authorship or editing rights — identity
  // is derived server-side and stamped here:
  //   author_user_id : the authenticated account that wrote it (users.id), or
  //                     NULL for a share-link reviewer / legacy row.
  //   author_kind    : 'account' (a member writing with their login) |
  //                     'reviewer' (a share-link reviewer, identity = session's
  //                     validated reviewer email) | NULL (legacy, pre-Task-6).
  // The 5-minute own-comment edit window and ownership checks key off these, not
  // the request body. Legacy rows (NULL identity) are editable only by admins.
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL`);
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_kind TEXT`);

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
    CREATE TABLE IF NOT EXISTS docs_repos (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      html_url TEXT NOT NULL,
      default_branch TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (org_id, owner, repo)
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

  // org_invitations: a pending invite for an email to join an org at a role.
  //   status lifecycle: 'pending' -> terminal ('accepted' | 'revoked').
  //   token is nanoid(24), the opaque handle in the invite link (and the lookup
  //   key for acceptInvite). email is stored lowercased (match signup/login).
  //   Concurrency: only ONE pending invite may exist per (org_id, email) at a
  //   time — enforced by the partial unique index uq_invites_pending (which
  //   ignores terminal rows, so a revoked/accepted invite never blocks a
  //   re-invite). The terminal-state CHECK pins accepted_at/revoked_at to their
  //   status so a row can't claim it is 'accepted' with no accepted_at (and vice
  //   versa), and 'pending' rows carry neither timestamp.
  await _pool.query(`
    CREATE TABLE IF NOT EXISTS org_invitations (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      email       TEXT NOT NULL,
      role        TEXT NOT NULL CONSTRAINT org_invitations_role_check CHECK (role IN ('admin','viewer')),
      token       TEXT UNIQUE NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending'
                    CONSTRAINT org_invitations_status_check CHECK (status IN ('pending','accepted','revoked')),
      invited_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL,
      accepted_at TEXT,
      revoked_at  TEXT,
      CONSTRAINT org_invitations_terminal_check CHECK (
        (status = 'pending'  AND accepted_at IS NULL AND revoked_at IS NULL) OR
        (status = 'accepted' AND accepted_at IS NOT NULL AND revoked_at IS NULL) OR
        (status = 'revoked'  AND revoked_at  IS NOT NULL AND accepted_at IS NULL)
      )
    )
  `);
  // At most one PENDING invite per (org, email); terminal rows are excluded so a
  // fresh invite can always be issued after a prior one is accepted or revoked.
  await _pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_invites_pending
      ON org_invitations(org_id, email) WHERE status = 'pending'
  `);
  // Seven-day expiry (product decision #9), enforced server-side at acceptInvite.
  // Added idempotently so it applies to already-deployed invitation tables too.
  // A NULL expires_at means "legacy invite, no expiry" — we do NOT retroactively
  // invalidate invites that were issued before this column existed; every invite
  // created/reissued from now on carries a concrete expires_at.
  await _pool.query(`ALTER TABLE org_invitations ADD COLUMN IF NOT EXISTS expires_at TEXT`);
  await _pool.query(`CREATE INDEX IF NOT EXISTS idx_invites_org ON org_invitations(org_id, status)`);

  // storage_cleanup_queue: a durable work queue of object-storage objects that
  // must be deleted out-of-band (Task 5 drains it). Rows are created as the
  // owning org/prototype is torn down, and must OUTLIVE those rows — so there is
  // intentionally NO FK to prototypes/organizations here (a cascade would delete
  // the very cleanup record we need to keep). Fields:
  //   kind           : object class (e.g. 'prototype', 'screenshot')
  //   object_key     : the storage key to delete
  //   status         : 'pending' -> 'done' | 'failed' (retry bookkeeping)
  //   attempts       : how many delete attempts have run
  //   next_attempt_at: earliest ISO time the next attempt may run (backoff)
  //   last_error     : last failure message, for diagnosis
  await _pool.query(`
    CREATE TABLE IF NOT EXISTS storage_cleanup_queue (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL,
      object_key      TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending'
                        CONSTRAINT storage_cleanup_status_check CHECK (status IN ('pending','done','failed')),
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      last_error      TEXT,
      created_at      TEXT NOT NULL
    )
  `);
  await _pool.query(`
    CREATE INDEX IF NOT EXISTS idx_storage_cleanup_due
      ON storage_cleanup_queue(status, next_attempt_at)
  `);

  // org_id is the tenant boundary on prototypes. Nullable at first (existing
  // rows), backfilled by the migration below, then enforced NOT NULL (see the
  // EMS consolidation migration + the ALTER ... SET NOT NULL after it).
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

      UPDATE explanations SET version_id = NULL
        WHERE version_id IS NOT NULL
          AND version_id NOT IN (SELECT id FROM prototype_versions);
      ALTER TABLE explanations DROP CONSTRAINT IF EXISTS explanations_version_id_fkey;
      ALTER TABLE explanations DROP CONSTRAINT IF EXISTS explanations_version_fk;
      ALTER TABLE explanations ADD  CONSTRAINT explanations_version_fk
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

    // Explanations version-scope data migration (runs AFTER v1 backfill so
    // parent comments already carry version_id). Marker-guarded, same lock.
    const { rows: expMarker } = await lockClient.query(
      'SELECT 1 FROM schema_migrations WHERE name = $1', ['explanations-version-scope-v1']);
    if (!expMarker.length) {
      await runAnnotationVersionBackfill(lockClient);
      await lockClient.query(
        `INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)
         ON CONFLICT (name) DO NOTHING`,
        ['explanations-version-scope-v1', new Date().toISOString()]);
    }

    // --- Org multi-tenancy migration: EMS consolidation (org-ems-consolidation-v1) ---
    // Decision: all existing data is confirmed TEST data owned by one team, so we
    // fold it into a SINGLE org named 'EMS' and make EVERY existing user an admin
    // of it (mass-granting admin is acceptable here). This REPLACES the earlier
    // 'org-multitenancy-v1' "Default Organization" fold; there is no per-boot
    // self-heal anymore — the migration is marker-guarded and one-time, and new
    // users join orgs via explicit invites (Task 1), not an auto-join.
    //
    // Under the same advisory lock as the v1 backfill, so concurrent/multi-
    // instance boots can't double-create the org. Idempotent: if the marker is
    // missing but an 'EMS' org already exists (e.g. a lost marker) we reuse it,
    // and all writes are ON CONFLICT / WHERE NULL guarded.
    const { rows: emsMarker } = await lockClient.query(
      'SELECT 1 FROM schema_migrations WHERE name = $1', ['org-ems-consolidation-v1']);
    const { rows: unassigned } = await lockClient.query(
      'SELECT 1 FROM prototypes WHERE org_id IS NULL LIMIT 1');
    const { rows: unassignedTokens } = await lockClient.query(
      'SELECT 1 FROM api_tokens WHERE org_id IS NULL LIMIT 1');

    if (emsMarker.length === 0 || unassigned.length > 0 || unassignedTokens.length > 0) {
      const nowIso = new Date().toISOString();
      // One atomic transaction for the whole fold: a crash mid-fold must not
      // leave a half-migrated DB (org created but prototypes unmoved, or the
      // marker recorded before the UPDATEs). Idempotent on re-run regardless.
      await lockClient.query('BEGIN');
      try {
        // Reuse an existing EMS org if present (idempotent even if the marker was
        // lost); otherwise create it with an opaque id.
        let { rows: emsOrg } = await lockClient.query(
          'SELECT id FROM organizations WHERE name = $1', ['EMS']);
        let emsOrgId = emsOrg[0] && emsOrg[0].id;
        if (!emsOrgId) {
          emsOrgId = nanoid(12);
          await lockClient.query(
            'INSERT INTO organizations (id, name, created_at) VALUES ($1,$2,$3)',
            [emsOrgId, 'EMS', nowIso]);
        }
        // Every existing user becomes an admin of EMS. The membership PK is a
        // fresh random id (NOT 'm_' || user_id): a deterministic PK collided on
        // org_memberships_pkey with legacy membership rows from the earlier
        // Default-Org fold / env-admin seed that used that same scheme, and
        // ON CONFLICT (org_id,user_id) does NOT cover the PK. WHERE NOT EXISTS
        // makes it idempotent on (org_id,user_id) without relying on a PK clash.
        await lockClient.query(
          `INSERT INTO org_memberships (id, org_id, user_id, role, created_at)
           SELECT 'm_' || replace(gen_random_uuid()::text, '-', ''), $1, u.id, 'admin', $2
             FROM users u
            WHERE NOT EXISTS (
              SELECT 1 FROM org_memberships m
               WHERE m.org_id = $1 AND m.user_id = u.id)`,
          [emsOrgId, nowIso]);
        // Move ALL existing prototypes + tokens into EMS.
        await lockClient.query('UPDATE prototypes SET org_id = $1 WHERE org_id IS NULL', [emsOrgId]);
        await lockClient.query('UPDATE api_tokens SET org_id = $1 WHERE org_id IS NULL', [emsOrgId]);
        await lockClient.query(
          `INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)
           ON CONFLICT (name) DO NOTHING`,
          ['org-ems-consolidation-v1', nowIso]);
        await lockClient.query('COMMIT');
      } catch (e) {
        await lockClient.query('ROLLBACK');
        throw e;
      }
    }

    // After the backfill, org_id is mandatory on both tenant-scoped tables.
    // Enforced idempotently: ALTER ... SET NOT NULL is a no-op if already set and
    // only succeeds once every row has an org_id (guaranteed by the fold above).
    await lockClient.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'prototypes' AND column_name = 'org_id' AND is_nullable = 'YES') THEN
          ALTER TABLE prototypes ALTER COLUMN org_id SET NOT NULL;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'api_tokens' AND column_name = 'org_id' AND is_nullable = 'YES') THEN
          ALTER TABLE api_tokens ALTER COLUMN org_id SET NOT NULL;
        END IF;
      END $$
    `);
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

async function seedDevUser() {
  // In dev mode: ensure a dev user + org exists so the auto-auth middleware
  // can reference valid IDs. Runs once on startup (idempotent).
  if (process.env.NODE_ENV === 'production') return;

  const devUserId = 'dev-user-12345';
  const devOrgId = 'dev-org-12345';

  try {
    // Insert dev user if it doesn't exist.
    await _pool.query(
      `INSERT INTO users (id, email, password_hash, created_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [devUserId, 'dev@sap.com', 'dev-hash', new Date().toISOString()]
    );

    // Insert dev org if it doesn't exist.
    await _pool.query(
      `INSERT INTO organizations (id, name, created_at)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [devOrgId, 'Dev Organization', new Date().toISOString()]
    );

    // Add dev user to dev org as admin (idempotent).
    await _pool.query(
      `INSERT INTO org_memberships (id, org_id, user_id, role, created_at)
       VALUES ($1, $2, $3, 'admin', $4) ON CONFLICT DO NOTHING`,
      [`m_dev_${devUserId}`, devOrgId, devUserId, new Date().toISOString()]
    );
  } catch (err) {
    console.error('Warning: Failed to seed dev user:', err.message);
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
                   docs_repos, org_invitations, storage_cleanup_queue,
                   org_memberships, organizations, users
    RESTART IDENTITY CASCADE
  `);
}

// One-time data migration for version-scoped annotations. Stamps every reply
// with its parent's version (new replies created by the pre-fix path carry
// NULL), then clears all legacy prototype-scoped explanations (Option A: no
// version reference survives). Idempotent; safe to re-run.
async function runAnnotationVersionBackfill(db) {
  await db.query(`
    UPDATE comments c SET version_id = p.version_id
    FROM comments p
    WHERE c.parent_id = p.id AND c.version_id IS NULL AND p.version_id IS NOT NULL
  `);
  await db.query(`DELETE FROM explanations WHERE version_id IS NULL`);
}

module.exports = { initDb, getDb, closeDb, cleanDb, seedDevUser, runAnnotationVersionBackfill };
