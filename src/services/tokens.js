// src/services/tokens.js
// API token lifecycle. A raw token is shown to the user ONCE at creation; only
// its bcrypt hash is stored. resolveToken() maps a presented bearer token back
// to its owning user, mirroring the password check in the admin login route.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const { getDb } = require('../db');

// Create a token for a user. Returns { id, raw } — raw is the secret, never re-derivable.
async function createToken(userId, name) {
  const id = nanoid(12);
  const raw = crypto.randomBytes(24).toString('base64url'); // 32-char url-safe secret
  const tokenHash = bcrypt.hashSync(raw, 10);
  await getDb().query(
    'INSERT INTO api_tokens (id, user_id, token_hash, name, created_at) VALUES ($1,$2,$3,$4,$5)',
    [id, userId, tokenHash, name || 'token', new Date().toISOString()]
  );
  return { id, raw };
}

// Resolve a presented raw token to { userId, tokenId }, or null if none match.
// Bumps last_used_at on success. Compares against every token's hash (bcrypt is
// intentionally slow, but token counts per user are tiny).
async function resolveToken(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // Revocation is a hard DELETE, so every row here is an active token — there is
  // no revoked-but-present row a raw token could still match. If revocation ever
  // becomes a soft-delete, add a WHERE filter here to exclude revoked rows.
  const { rows } = await getDb().query('SELECT id, user_id, token_hash FROM api_tokens');
  for (const row of rows) {
    if (bcrypt.compareSync(raw, row.token_hash)) {
      await getDb().query('UPDATE api_tokens SET last_used_at = $1 WHERE id = $2',
        [new Date().toISOString(), row.id]);
      return { userId: row.user_id, tokenId: row.id };
    }
  }
  return null;
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
