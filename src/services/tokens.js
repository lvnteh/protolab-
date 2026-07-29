// src/services/tokens.js
// API token lifecycle. A raw token has the form "<tokenId>.<secret>" — the id
// prefix is a non-secret lookup key (the row PK), the secret is what's hashed.
// This lets resolveToken do a single indexed row fetch + ONE bcrypt compare,
// instead of scanning every token in the table. The raw token is shown to the
// user ONCE at creation; only the bcrypt hash of the secret is stored.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const { getDb } = require('../db');

// Create a token for a user. Returns { id, raw } — raw is "<id>.<secret>",
// never re-derivable (only the secret's bcrypt hash is stored).
async function createToken(userId, name) {
  const id = nanoid(12);
  const secret = crypto.randomBytes(24).toString('base64url'); // 32-char url-safe secret
  const tokenHash = bcrypt.hashSync(secret, 10);
  await getDb().query(
    'INSERT INTO api_tokens (id, user_id, token_hash, name, created_at) VALUES ($1,$2,$3,$4,$5)',
    [id, userId, tokenHash, name || 'token', new Date().toISOString()]
  );
  return { id, raw: `${id}.${secret}` };
}

// Resolve a presented raw token ("<id>.<secret>") to { userId, tokenId }, or
// null if the id is unknown or the secret doesn't match. Single indexed lookup
// + one async bcrypt compare. Bumps last_used_at on success.
async function resolveToken(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const dot = raw.indexOf('.');
  if (dot < 1) return null; // must have a non-empty id prefix
  const id = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);
  if (!secret) return null;
  const { rows } = await getDb().query('SELECT user_id, token_hash FROM api_tokens WHERE id = $1', [id]);
  if (!rows[0]) return null;
  const ok = await bcrypt.compare(secret, rows[0].token_hash);
  if (!ok) return null;
  await getDb().query('UPDATE api_tokens SET last_used_at = $1 WHERE id = $2',
    [new Date().toISOString(), id]);
  return { userId: rows[0].user_id, tokenId: id };
}

// List a user's tokens (never returns the hash or raw secret).
async function listTokens(userId) {
  const { rows } = await getDb().query(
    'SELECT id, name, created_at, last_used_at FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return rows;
}

// Revoke = delete. Scoped by user so one user can't revoke another's token.
async function revokeToken(tokenId, userId) {
  await getDb().query('DELETE FROM api_tokens WHERE id = $1 AND user_id = $2', [tokenId, userId]);
}

module.exports = { createToken, resolveToken, listTokens, revokeToken };
