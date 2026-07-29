// tests/db-cascade.test.js
//
// Exercises the deletion FK graph and the deploy-safety migration guard added to
// src/db.js. Guarded by DATABASE_URL so it is skipped in envs without a Postgres.
//
// SHARED-DB SAFETY: this DB is used by other test suites concurrently. Every row
// this suite creates uses a unique nanoid id and is deleted by exactly its id in
// afterAll — we NEVER TRUNCATE shared tables here. cleanDb() (which truncates
// everything) is only exercised behind RUN_CLEANDB_TRUNCATE=1 so a normal serial
// run does not wipe another agent's in-flight data.
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();

const hasDb = !!process.env.DATABASE_URL;
jest.setTimeout(15000);

const { initDb, getDb, closeDb, cleanDb } = require('../src/db');
const { nanoid } = require('nanoid');

// Track every id we create so afterAll can delete precisely our own rows.
const created = { prototypes: [], users: [] };

async function seedPrototype(db, { withComment = true, withTelemetry = true } = {}) {
  const userId = nanoid(12);
  await db.query('INSERT INTO users (id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)',
    [userId, `cascade-${userId}@sap.com`, 'x', new Date().toISOString()]);
  created.users.push(userId);

  const protoId = nanoid(12);
  await db.query(
    'INSERT INTO prototypes (id,name,filename,share_token,created_at,owner_id) VALUES ($1,$2,$3,$4,$5,$6)',
    [protoId, 'Cascade', `${protoId}.html`, nanoid(12), new Date().toISOString(), userId]);
  created.prototypes.push(protoId);

  // Give it a version + published pointer via the backfill path.
  await initDb();
  const { rows: [{ id: vId }] } = await db.query(
    'SELECT id FROM prototype_versions WHERE prototype_id = $1', [protoId]);

  let commentId = null;
  if (withComment) {
    commentId = nanoid(12);
    await db.query(
      `INSERT INTO comments (id,prototype_id,email,type,comment,created_at,version_id)
       VALUES ($1,$2,$3,'general',$4,$5,$6)`,
      [commentId, protoId, 'alice@sap.com', 'please fix', new Date().toISOString(), vId]);
  }
  if (withTelemetry) {
    await db.query(
      'INSERT INTO access_log (prototype_id,email,opened_at) VALUES ($1,$2,$3)',
      [protoId, 'alice@sap.com', new Date().toISOString()]);
    await db.query(
      'INSERT INTO nav_events (prototype_id,email,page_url,occurred_at) VALUES ($1,$2,$3,$4)',
      [protoId, 'alice@sap.com', '/page', new Date().toISOString()]);
  }
  return { userId, protoId, vId, commentId };
}

(hasDb ? describe : describe.skip)('db cascade + migration guard', () => {
  beforeAll(async () => {
    await initDb();
    // Start from a clean slate for THIS suite's own seeded rows. cleanDb truncates
    // everything, so only run it when explicitly opted in (shared-DB safety).
    if (process.env.RUN_CLEANDB_TRUNCATE === '1') await cleanDb();
  });

  afterAll(async () => {
    // Scope teardown to exactly the ids we created — never truncate shared tables.
    const db = getDb();
    for (const id of created.prototypes) {
      await db.query('DELETE FROM prototypes WHERE id = $1', [id]);
    }
    for (const id of created.users) {
      await db.query('DELETE FROM users WHERE id = $1', [id]);
    }
    await closeDb();
  });

  test('(a) DELETE FROM prototypes cascades comments/versions/access_log/nav_events in one shot', async () => {
    const db = getDb();
    const { protoId, commentId } = await seedPrototype(db);

    // Single delete, no manual unwinding of children or pointers.
    await expect(db.query('DELETE FROM prototypes WHERE id = $1', [protoId])).resolves.toBeDefined();

    const proto = await db.query('SELECT 1 FROM prototypes WHERE id = $1', [protoId]);
    const comments = await db.query('SELECT 1 FROM comments WHERE id = $1', [commentId]);
    const versions = await db.query('SELECT 1 FROM prototype_versions WHERE prototype_id = $1', [protoId]);
    const access = await db.query('SELECT 1 FROM access_log WHERE prototype_id = $1', [protoId]);
    const nav = await db.query('SELECT 1 FROM nav_events WHERE prototype_id = $1', [protoId]);

    expect(proto.rowCount).toBe(0);
    expect(comments.rowCount).toBe(0);
    expect(versions.rowCount).toBe(0);
    expect(access.rowCount).toBe(0);
    expect(nav.rowCount).toBe(0);
  });

  test('(b) deleting only a version SET NULLs the comment.version_id but keeps the comment', async () => {
    const db = getDb();
    const { protoId, vId, commentId } = await seedPrototype(db);

    // Delete just the version row. published_version_id points at it (SET NULL) and
    // the comment references it (SET NULL) — both must degrade, not error/cascade-delete.
    await expect(db.query('DELETE FROM prototype_versions WHERE id = $1', [vId])).resolves.toBeDefined();

    const comment = await db.query('SELECT version_id FROM comments WHERE id = $1', [commentId]);
    const proto = await db.query('SELECT published_version_id FROM prototypes WHERE id = $1', [protoId]);

    expect(comment.rowCount).toBe(1);                 // comment survived
    expect(comment.rows[0].version_id).toBeNull();    // version_id nulled
    expect(proto.rows[0].published_version_id).toBeNull(); // pointer nulled
  });

  test('(d) initDb() is idempotent (safe to call twice) and records the backfill marker', async () => {
    const db = getDb();
    await expect(initDb()).resolves.toBeDefined();
    await expect(initDb()).resolves.toBeDefined();
    const { rows } = await db.query(
      'SELECT 1 FROM schema_migrations WHERE name = $1', ['v1-version-backfill']);
    expect(rows.length).toBe(1);
  });

  // (c) cleanDb() truncates everything, so it is destructive to concurrent suites.
  // It is verified only when RUN_CLEANDB_TRUNCATE=1 to protect the shared DB.
  const cleanDbTest = process.env.RUN_CLEANDB_TRUNCATE === '1' ? test : test.skip;
  cleanDbTest('(c) cleanDb() empties the data tables', async () => {
    const db = getDb();
    await seedPrototype(db);
    await cleanDb();
    const protos = await db.query('SELECT count(*)::int AS n FROM prototypes');
    const comments = await db.query('SELECT count(*)::int AS n FROM comments');
    const users = await db.query('SELECT count(*)::int AS n FROM users');
    expect(protos.rows[0].n).toBe(0);
    expect(comments.rows[0].n).toBe(0);
    expect(users.rows[0].n).toBe(0);
  });
});
