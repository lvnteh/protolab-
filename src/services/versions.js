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
// contentType ('html' | 'markdown') records how this version's file must render;
// defaults to 'html' so existing callers are unaffected.
async function createDraft(prototypeId, filename, note, contentType = 'html') {
  const version = (await latestVersion(prototypeId)) + 1;
  const id = nanoid(12);
  await getDb().query(
    `INSERT INTO prototype_versions (id, prototype_id, version, filename, status, note, created_at, content_type)
     VALUES ($1,$2,$3,$4,'draft',$5,$6,$7)`,
    [id, prototypeId, version, filename, note || null, new Date().toISOString(), contentType]
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

// Admin go-live control. Unlike publish(), this NEVER 409s on an
// already-published version — it re-points published_version_id so an admin can
// switch back to any earlier published version. A draft is promoted to published.
async function setPublished(prototypeId, version) {
  const { rows } = await getDb().query(
    'SELECT id, status FROM prototype_versions WHERE prototype_id = $1 AND version = $2',
    [prototypeId, version]);
  if (!rows[0]) { const e = new Error('Version not found.'); e.code = 'CONFLICT'; throw e; }
  const vId = rows[0].id;
  const promoted = rows[0].status === 'draft';
  const client = await getDb().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM prototypes WHERE id = $1 FOR UPDATE', [prototypeId]);
    if (promoted) await client.query(`UPDATE prototype_versions SET status = 'published' WHERE id = $1`, [vId]);
    await client.query(
      `UPDATE prototypes SET published_version_id = $1,
         draft_version_id = CASE WHEN draft_version_id = $1 THEN NULL ELSE draft_version_id END
       WHERE id = $2`,
      [vId, prototypeId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { version, status: 'published', promoted, publishedVersionId: vId };
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

// Like resolvePublishedFile but also returns how the file should render.
// Returns null when there is no published version.
async function resolvePublished(prototypeId) {
  const { rows } = await getDb().query(
    `SELECT v.filename, v.content_type FROM prototypes p
     JOIN prototype_versions v ON v.id = p.published_version_id
     WHERE p.id = $1`,
    [prototypeId]
  );
  return rows[0] ? { filename: rows[0].filename, contentType: rows[0].content_type || 'html' } : null;
}

// The version id a comment made "now" should be stamped with = published version.
async function publishedVersionId(prototypeId) {
  const { rows } = await getDb().query('SELECT published_version_id FROM prototypes WHERE id = $1', [prototypeId]);
  return rows[0] ? rows[0].published_version_id : null;
}

async function listPublishedVersions(prototypeId) {
  const { rows } = await getDb().query(
    `SELECT v.version, v.note, v.created_at, v.content_type,
            COALESCE(v.id = p.published_version_id, false) AS is_current
     FROM prototype_versions v JOIN prototypes p ON p.id = v.prototype_id
     WHERE v.prototype_id = $1 AND v.status = 'published'
     ORDER BY v.version DESC`, [prototypeId]);
  return rows.map(r => ({
    version: r.version, note: r.note, createdAt: r.created_at,
    contentType: r.content_type || 'html', isCurrent: r.is_current,
  }));
}

async function listAllVersions(prototypeId) {
  const { rows } = await getDb().query(
    `SELECT v.version, v.status, v.note, v.created_at, v.content_type,
            COALESCE(v.id = p.published_version_id, false) AS is_current
     FROM prototype_versions v JOIN prototypes p ON p.id = v.prototype_id
     WHERE v.prototype_id = $1 ORDER BY v.version DESC`, [prototypeId]);
  return rows.map(r => ({
    version: r.version, status: r.status, note: r.note, createdAt: r.created_at,
    contentType: r.content_type || 'html', isCurrent: r.is_current, isDraft: r.status === 'draft',
  }));
}

// The version NUMBER of the current published pointer (null when none). Used to
// label the default (no ?version) view's switcher; a null is fine — the switcher
// hides when there is <= 1 published version.
async function publishedVersionNumber(prototypeId) {
  const { rows } = await getDb().query(
    `SELECT pv.version FROM prototypes p
     JOIN prototype_versions pv ON pv.id = p.published_version_id
     WHERE p.id = $1`, [prototypeId]);
  return rows[0] ? rows[0].version : null;
}

async function resolvePublishedVersion(prototypeId, version) {
  const v = parseInt(version, 10);
  if (Number.isNaN(v)) return null;
  const { rows } = await getDb().query(
    `SELECT id, version, filename, content_type FROM prototype_versions
     WHERE prototype_id = $1 AND version = $2 AND status = 'published'`,
    [prototypeId, v]);
  return rows[0]
    ? { id: rows[0].id, version: rows[0].version, filename: rows[0].filename, contentType: rows[0].content_type || 'html' }
    : null;
}

module.exports = { latestVersion, createDraft, publish, setPublished, resolvePublishedFile, resolvePublished, publishedVersionId, publishedVersionNumber, listPublishedVersions, listAllVersions, resolvePublishedVersion };
