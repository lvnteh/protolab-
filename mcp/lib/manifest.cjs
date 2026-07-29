// mcp/lib/manifest.cjs
// Reads and writes the local .protoshare.json manifest that maps a local HTML
// file to its deployed prototype id and records the last-pulled / last-pushed
// version numbers (the baseVersion source for conflict detection). The token is
// NEVER stored here — it lives in the environment. This module is pure I/O over
// the manifest file; it holds no network or business logic.
const fs = require('fs');

// Load and validate the manifest at `filePath`. Throws with a clear, actionable
// message on missing file / bad JSON / missing remote. Guarantees a
// `.prototypes` object so callers never need to null-check it.
function load(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(`Manifest not found at ${filePath}. Copy .protoshare.example.json to .protoshare.json in your prototype repo and set PROTOSHARE_MANIFEST if it lives elsewhere.`);
    }
    throw e;
  }
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    throw new Error(`Manifest at ${filePath} is not valid JSON.`);
  }
  if (!m || typeof m.remote !== 'string' || !m.remote) {
    throw new Error(`Manifest at ${filePath} must have a non-empty "remote" URL.`);
  }
  if (!m.prototypes || typeof m.prototypes !== 'object') m.prototypes = {};
  return m;
}

// Find the file-key whose entry matches `fileOrId` either by key or by .id.
// Returns the file key, or null if it only matches as a bare id / not at all.
function fileKeyFor(m, fileOrId) {
  if (m.prototypes[fileOrId]) return fileOrId; // direct file-key hit
  for (const [file, entry] of Object.entries(m.prototypes)) {
    if (entry && entry.id === fileOrId) return file;
  }
  return null;
}

// Resolve a file-key OR a raw id to a prototype id. A known file → its id; an
// unknown value is assumed to already BE an id and returned unchanged.
function resolveId(m, fileOrId) {
  const key = fileKeyFor(m, fileOrId);
  if (key) return m.prototypes[key].id;
  return fileOrId;
}

// The version a local edit was based on = the highest version we've seen for
// this file (max of lastPulled/lastPushed). undefined when we've never synced,
// which tells the caller to omit baseVersion (server skips the conflict check).
function baseVersion(m, fileOrId) {
  const key = fileKeyFor(m, fileOrId);
  if (!key) return undefined;
  const e = m.prototypes[key];
  const vals = [e.lastPulled, e.lastPushed].filter(v => typeof v === 'number');
  return vals.length ? Math.max(...vals) : undefined;
}

function save(m, filePath) {
  fs.writeFileSync(filePath, JSON.stringify(m, null, 2) + '\n');
}

function ensureEntry(m, fileOrId) {
  const key = fileKeyFor(m, fileOrId);
  if (key) return key;
  // Not a known file or id: create a bare entry keyed by the given value,
  // storing it as the id (best effort — lets status/record work pre-first-pull).
  m.prototypes[fileOrId] = { id: fileOrId };
  return fileOrId;
}

function recordPull(m, fileOrId, version, filePath) {
  const key = ensureEntry(m, fileOrId);
  m.prototypes[key].lastPulled = version;
  save(m, filePath);
}

function recordPush(m, fileOrId, version, filePath) {
  const key = ensureEntry(m, fileOrId);
  m.prototypes[key].lastPushed = version;
  save(m, filePath);
}

module.exports = { load, save, resolveId, fileKeyFor, baseVersion, recordPull, recordPush };
