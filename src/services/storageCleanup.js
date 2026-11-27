// src/services/storageCleanup.js
// Restart-safe drainer for storage_cleanup_queue (Task 5). Org/prototype deletion
// ENQUEUES the object keys to remove in the SAME transaction that deletes the DB
// rows, so the work is durable and survives a crash between the DB commit and the
// (eventually-consistent) object-store delete. This runner drains that queue:
//
//   * Claims a batch of DUE pending rows with SELECT ... FOR UPDATE SKIP LOCKED,
//     so multiple app instances can drain concurrently without double-claiming.
//   * Deletes each object through the storage service. Object deletion is
//     idempotent — a MISSING object counts as SUCCESS (the goal state is "gone").
//   * On failure, bumps attempts, records last_error, and schedules the next
//     attempt with exponential backoff. Rows never block the queue head because
//     next_attempt_at gates them out until due.
const { getDb } = require('../db');
const storage = require('./storage');

const now = () => new Date().toISOString();

// Backoff: 1min, 2, 4, 8 ... capped at 1h, as a function of attempt count.
function nextAttemptAt(attempts) {
  const minutes = Math.min(60, 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

// Delete one queued object by kind. Idempotent; a missing object is success.
async function deleteObject(kind, key) {
  if (kind === 'screenshot') return storage.deleteImage(key);
  // 'prototype' and anything else: prototype/version files live in the same
  // bucket under their bare filename.
  return storage.deletePrototype(key);
}

// Drain up to `limit` due rows in ONE pass. Returns { processed, failed }.
// Each row is claimed and finalized in its own short transaction so a crash
// mid-drain leaves the rest of the queue untouched and retryable.
async function drainOnce(limit = 50) {
  let processed = 0;
  let failed = 0;
  for (let i = 0; i < limit; i++) {
    const client = await getDb().connect();
    let claimed;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id, kind, object_key, attempts FROM storage_cleanup_queue
          WHERE status = 'pending' AND next_attempt_at <= $1
          ORDER BY next_attempt_at ASC
          FOR UPDATE SKIP LOCKED LIMIT 1`,
        [now()]);
      claimed = rows[0];
      if (!claimed) { await client.query('ROLLBACK'); client.release(); break; }

      try {
        await deleteObject(claimed.kind, claimed.object_key);
        await client.query(
          "UPDATE storage_cleanup_queue SET status = 'done', attempts = attempts + 1 WHERE id = $1",
          [claimed.id]);
        processed++;
      } catch (err) {
        const attempts = claimed.attempts + 1;
        await client.query(
          `UPDATE storage_cleanup_queue
              SET attempts = $2, last_error = $3, next_attempt_at = $4
            WHERE id = $1`,
          [claimed.id, attempts, String(err && err.message).slice(0, 500), nextAttemptAt(attempts)]);
        failed++;
      }
      await client.query('COMMIT');
    } catch (txErr) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      client.release();
      throw txErr;
    }
    client.release();
  }
  return { processed, failed };
}

module.exports = { drainOnce, nextAttemptAt };
