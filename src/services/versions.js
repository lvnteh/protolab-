// src/services/versions.js
// Prototype version lifecycle. A push creates a DRAFT (never touches the
// published pointer); publish promotes a draft to the version the share link
// serves. All functions assume ownership has already been checked by the caller.
const { nanoid } = require('nanoid');
const { getDb } = require('../db');

// Highest version number for a prototype (0 if none — shouldn't happen post-backfill).
async function latestVersion(prototypeId) {
  const { rows } = await getDb().query(
    'SELECT COALESCE(MAX(version), 0) AS max FROM prototype_versions WHERE prototype_id = $1',
    [prototypeId]
  );
  return parseInt(rows[0].max, 10);
}

// Create a new draft version with the next number. Sets prototypes.draft_version_id.
async function createDraft(prototypeId, filename, note) {
  const version = (await latestVersion(prototypeId)) + 1;
  const id = nanoid(12);
  await getDb().query(
    `INSERT INTO prototype_versions (id, prototype_id, version, filename, status, note, created_at)
     VALUES ($1,$2,$3,$4,'draft',$5,$6)`,
    [id, prototypeId, version, filename, note || null, new Date().toISOString()]
  );
  await getDb().query('UPDATE prototypes SET draft_version_id = $1 WHERE id = $2', [id, prototypeId]);
  return { id, version, status: 'draft' };
}

// Promote a version to published: flip its status, point the prototype at it,
// clear the draft pointer if it was this version. Throws {code:'CONFLICT'} if
// the version doesn't exist or is already published.
async function publish(prototypeId, version) {
  const { rows } = await getDb().query(
    'SELECT id, status FROM prototype_versions WHERE prototype_id = $1 AND version = $2',
    [prototypeId, version]
  );
  // Both not-found and already-published map to 409 CONFLICT at the route layer
  // (a publish that can't proceed), by design — the messages distinguish them.
  if (!rows[0]) { const e = new Error('Version not found.'); e.code = 'CONFLICT'; throw e; }
  if (rows[0].status === 'published') { const e = new Error('Already published.'); e.code = 'CONFLICT'; throw e; }
  const vId = rows[0].id;
  const client = await getDb().connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE prototype_versions SET status = 'published' WHERE id = $1`, [vId]);
    await client.query(
      `UPDATE prototypes SET published_version_id = $1,
         draft_version_id = CASE WHEN draft_version_id = $1 THEN NULL ELSE draft_version_id END
       WHERE id = $2`,
      [vId, prototypeId]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { version, status: 'published' };
}

// The storage filename the share link should serve = the published version's file.
async function resolvePublishedFile(prototypeId) {
  const { rows } = await getDb().query(
    `SELECT v.filename FROM prototypes p
     JOIN prototype_versions v ON v.id = p.published_version_id
     WHERE p.id = $1`,
    [prototypeId]
  );
  return rows[0] ? rows[0].filename : null;
}

// The version id a comment made "now" should be stamped with = published version.
async function publishedVersionId(prototypeId) {
  const { rows } = await getDb().query('SELECT published_version_id FROM prototypes WHERE id = $1', [prototypeId]);
  return rows[0] ? rows[0].published_version_id : null;
}

module.exports = { latestVersion, createDraft, publish, resolvePublishedFile, publishedVersionId };
