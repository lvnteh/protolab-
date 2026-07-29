// src/middleware/apiTokenAuth.js
// Machine-facing auth for /api/v1/*. Parses a Bearer token, resolves it to a
// user via the token service, and sets req.userId. The session-cookie adminAuth
// and this never mix — /api/v1 is bearer-only, /admin is cookie-only.
const { resolveToken } = require('../services/tokens');

async function apiTokenAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ error: 'Missing bearer token.' });
    const resolved = await resolveToken(match[1].trim());
    if (!resolved) return res.status(401).json({ error: 'Invalid or revoked token.' });
    req.userId = resolved.userId;
    req.tokenId = resolved.tokenId;
    next();
  } catch (err) {
    // NEVER log the raw bearer token (match[1]). If token context is ever
    // needed here, mask it (e.g. token.slice(0, 4) + '***'); the error object
    // below does not contain the token.
    console.error('apiTokenAuth error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
}

module.exports = apiTokenAuth;
