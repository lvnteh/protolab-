// src/services/storage.js
// Backend-agnostic storage for uploaded prototype .html files. Hides the
// Supabase Storage SDK behind three verbs so the routes never touch the
// filesystem for uploads — keeping the app stateless (no local disk needed).
//
// Local-dev fallback: when Supabase credentials are absent, files are read
// from and written to a local directory (config.uploadsPath) instead. This
// mirrors the SSL-off-for-localhost conditional in db.js — production behaviour
// is unchanged (creds present → Supabase), but the app runs fully offline for
// development without a Supabase project.
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

// Use Supabase only when both the URL and service key are configured.
// Otherwise fall back to the local filesystem so `npm start` works offline.
const useSupabase = !!(config.supabaseUrl && config.supabaseServiceKey);

let _client = null;

function client() {
  if (!_client) {
    _client = createClient(config.supabaseUrl, config.supabaseServiceKey);
  }
  return _client;
}

function localPath(filename) {
  // filename is always `${id}.html` (id is nanoid, no separators) or the
  // basename-validated value from the routes, so it can't escape the dir.
  return path.join(config.uploadsPath, path.basename(filename));
}

// Store a prototype file. `body` may be a Buffer (from multer memoryStorage)
// or a string. `upsert: true` so re-uploading the same filename overwrites.
async function putPrototype(filename, body) {
  if (!useSupabase) {
    await fs.promises.mkdir(config.uploadsPath, { recursive: true });
    await fs.promises.writeFile(localPath(filename), body);
    return;
  }
  const { error } = await client()
    .storage.from(config.storageBucket)
    .upload(filename, body, { contentType: 'text/html', upsert: true });
  if (error) throw error;
}

// Read a prototype file back as a UTF-8 string. Returns null when the object
// doesn't exist, so callers keep their existing `if (!raw) return 404` shape.
async function getPrototype(filename) {
  if (!useSupabase) {
    try {
      return await fs.promises.readFile(localPath(filename), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }
  const { data, error } = await client()
    .storage.from(config.storageBucket)
    .download(filename);
  if (error) {
    if (/not.?found/i.test(error.message || '')) return null;
    throw error;
  }
  return await data.text();
}

// Best-effort delete. A missing object is not an error here — the DB row is
// the source of truth, and a delete should never be blocked by a stale file.
async function deletePrototype(filename) {
  if (!useSupabase) {
    try {
      await fs.promises.unlink(localPath(filename));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return;
  }
  const { error } = await client()
    .storage.from(config.storageBucket)
    .remove([filename]);
  if (error && !/not.?found/i.test(error.message || '')) throw error;
}

module.exports = { putPrototype, getPrototype, deletePrototype };
