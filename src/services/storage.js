// src/services/storage.js
// Backend-agnostic storage for uploaded prototype .html files. Hides the
// Supabase Storage SDK behind three verbs so the routes never touch the
// filesystem for uploads — keeping the app stateless (no local disk needed).
const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

let _client = null;

function client() {
  if (!_client) {
    _client = createClient(config.supabaseUrl, config.supabaseServiceKey);
  }
  return _client;
}

// Store a prototype file. `body` may be a Buffer (from multer memoryStorage)
// or a string. `upsert: true` so re-uploading the same filename overwrites.
async function putPrototype(filename, body) {
  const { error } = await client()
    .storage.from(config.storageBucket)
    .upload(filename, body, { contentType: 'text/html', upsert: true });
  if (error) throw error;
}

// Read a prototype file back as a UTF-8 string. Returns null when the object
// doesn't exist, so callers keep their existing `if (!raw) return 404` shape.
async function getPrototype(filename) {
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
  const { error } = await client()
    .storage.from(config.storageBucket)
    .remove([filename]);
  if (error && !/not.?found/i.test(error.message || '')) throw error;
}

module.exports = { putPrototype, getPrototype, deletePrototype };
