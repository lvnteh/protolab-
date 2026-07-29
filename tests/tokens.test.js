// tests/tokens.test.js
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();

const hasDb = !!process.env.DATABASE_URL;
jest.setTimeout(15000);
const { initDb, getDb, closeDb } = require('../src/db');
const { nanoid } = require('nanoid');
const tokens = require('../src/services/tokens');

let userId;

(hasDb ? describe : describe.skip)('token service', () => {
  beforeAll(async () => {
    await initDb();
    userId = nanoid(12);
    await getDb().query(
      'INSERT INTO users (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)',
      [userId, `tok-${userId}@sap.com`, 'x', new Date().toISOString()]
    );
  });
  afterAll(async () => { await closeDb(); });

  test('createToken returns a raw secret and stores only a hash', async () => {
    const { raw, id } = await tokens.createToken(userId, 'laptop');
    expect(typeof raw).toBe('string');
    expect(raw.length).toBeGreaterThanOrEqual(32);
    const { rows } = await getDb().query('SELECT token_hash FROM api_tokens WHERE id = $1', [id]);
    expect(rows[0].token_hash).not.toBe(raw); // stored value is a hash, not the secret
  });

  test('resolveToken returns the owning user for a valid raw token', async () => {
    const { raw } = await tokens.createToken(userId, 'second');
    const resolved = await tokens.resolveToken(raw);
    expect(resolved).toMatchObject({ userId });
  });

  test('resolveToken returns null for a bogus token', async () => {
    expect(await tokens.resolveToken('not-a-real-token')).toBeNull();
  });

  test('revokeToken makes the token stop resolving', async () => {
    const { raw, id } = await tokens.createToken(userId, 'third');
    await tokens.revokeToken(id, userId);
    expect(await tokens.resolveToken(raw)).toBeNull();
  });

  test('listTokens returns the user\'s tokens without the hash', async () => {
    const fresh = nanoid(12);
    await getDb().query(
      'INSERT INTO users (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)',
      [fresh, `list-${fresh}@sap.com`, 'x', new Date().toISOString()]
    );
    await tokens.createToken(fresh, 'alpha');
    await tokens.createToken(fresh, 'beta');
    const list = await tokens.listTokens(fresh);
    expect(list).toHaveLength(2);
    expect(list.map(t => t.name).sort()).toEqual(['alpha', 'beta']);
    expect(list[0]).not.toHaveProperty('token_hash');
  });

  test('apiTokenAuth sets req.userId and req.tokenId for a valid bearer token', async () => {
    const express = require('express');
    const request = require('supertest');
    const apiTokenAuth = require('../src/middleware/apiTokenAuth');
    const { raw, id } = await tokens.createToken(userId, 'mw');
    const app = express();
    app.get('/whoami', apiTokenAuth, (req, res) => res.json({ userId: req.userId, tokenId: req.tokenId }));
    const res = await request(app).get('/whoami').set('Authorization', `Bearer ${raw}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(userId);
    expect(res.body.tokenId).toBe(id);
  });

  test('apiTokenAuth 401s when the Authorization header is missing', async () => {
    const express = require('express');
    const request = require('supertest');
    const apiTokenAuth = require('../src/middleware/apiTokenAuth');
    const app = express();
    app.get('/whoami', apiTokenAuth, (req, res) => res.json({ userId: req.userId }));
    const res = await request(app).get('/whoami');
    expect(res.status).toBe(401);
  });

  test('apiTokenAuth 401s for an unknown token', async () => {
    const express = require('express');
    const request = require('supertest');
    const apiTokenAuth = require('../src/middleware/apiTokenAuth');
    const app = express();
    app.get('/whoami', apiTokenAuth, (req, res) => res.json({ userId: req.userId }));
    const res = await request(app).get('/whoami').set('Authorization', 'Bearer nope');
    expect(res.status).toBe(401);
  });

  test('resolveToken returns null when the id prefix is unknown', async () => {
    expect(await tokens.resolveToken('nonexistentid.somesecret')).toBeNull();
  });

  test('resolveToken returns null for a malformed token (no dot / empty parts)', async () => {
    expect(await tokens.resolveToken('nodot')).toBeNull();
    expect(await tokens.resolveToken('.secretonly')).toBeNull();
    expect(await tokens.resolveToken('idonly.')).toBeNull();
  });
});
