// tests/tokens.test.js
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();

const hasDb = !!process.env.DATABASE_URL;
jest.setTimeout(15000);
const { initDb, getDb, closeDb } = require('../src/db');
const { nanoid } = require('nanoid');
const tokens = require('../src/services/tokens');

let userId;
let orgId;

async function createOrg() {
  const id = nanoid(12);
  await getDb().query(
    'INSERT INTO organizations (id, name, created_at) VALUES ($1,$2,$3)',
    [id, `org-${id}`, new Date().toISOString()]
  );
  return id;
}

// resolveToken now requires the token owner to be an ADMIN member of the token's
// org (machine-access recheck, Task 1). Give a user admin membership in an org
// so their tokens resolve.
async function addAdmin(orgId, userId) {
  await getDb().query(
    `INSERT INTO org_memberships (id, org_id, user_id, role, created_at)
     VALUES ($1,$2,$3,'admin',$4) ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'admin'`,
    [nanoid(12), orgId, userId, new Date().toISOString()]
  );
}

(hasDb ? describe : describe.skip)('token service', () => {
  beforeAll(async () => {
    await initDb();
    userId = nanoid(12);
    await getDb().query(
      'INSERT INTO users (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)',
      [userId, `tok-${userId}@sap.com`, 'x', new Date().toISOString()]
    );
    orgId = await createOrg();
    await addAdmin(orgId, userId);
  });
  afterAll(async () => { await closeDb(); });

  test('createToken returns a raw secret and stores only a hash', async () => {
    const { raw, id } = await tokens.createToken(userId, 'laptop', orgId);
    expect(typeof raw).toBe('string');
    expect(raw.length).toBeGreaterThanOrEqual(32);
    const { rows } = await getDb().query('SELECT token_hash FROM api_tokens WHERE id = $1', [id]);
    expect(rows[0].token_hash).not.toBe(raw); // stored value is a hash, not the secret
  });

  test('resolveToken returns the owning user for a valid raw token', async () => {
    const { raw } = await tokens.createToken(userId, 'second', orgId);
    const resolved = await tokens.resolveToken(raw);
    expect(resolved).toMatchObject({ userId });
  });

  test('resolveToken returns null for a bogus token', async () => {
    expect(await tokens.resolveToken('not-a-real-token')).toBeNull();
  });

  test('revokeToken makes the token stop resolving', async () => {
    const { raw, id } = await tokens.createToken(userId, 'third', orgId);
    await tokens.revokeToken(id, orgId);
    expect(await tokens.resolveToken(raw)).toBeNull();
  });

  test('listTokens returns the org\'s tokens without the hash', async () => {
    const fresh = nanoid(12);
    await getDb().query(
      'INSERT INTO users (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)',
      [fresh, `list-${fresh}@sap.com`, 'x', new Date().toISOString()]
    );
    const freshOrgId = await createOrg();
    await addAdmin(freshOrgId, fresh);
    await tokens.createToken(fresh, 'alpha', freshOrgId);
    await tokens.createToken(fresh, 'beta', freshOrgId);
    const list = await tokens.listTokens(freshOrgId);
    expect(list).toHaveLength(2);
    expect(list.map(t => t.name).sort()).toEqual(['alpha', 'beta']);
    expect(list[0]).not.toHaveProperty('token_hash');
  });

  test('apiTokenAuth sets req.userId and req.tokenId for a valid bearer token', async () => {
    const express = require('express');
    const request = require('supertest');
    const apiTokenAuth = require('../src/middleware/apiTokenAuth');
    const { raw, id } = await tokens.createToken(userId, 'mw', orgId);
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

  // Machine-access recheck (Task 1): a token only resolves while its owner is an
  // admin member of the token's org.
  test('resolveToken stops resolving when the owner is demoted to viewer', async () => {
    const u = nanoid(12);
    await getDb().query(
      'INSERT INTO users (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)',
      [u, `demote-${u}@sap.com`, 'x', new Date().toISOString()]);
    const o = await createOrg();
    await addAdmin(o, u);
    const { raw } = await tokens.createToken(u, 'wk', o);
    expect(await tokens.resolveToken(raw)).toMatchObject({ userId: u });
    // Demote to viewer: the token must stop resolving.
    await getDb().query(
      "UPDATE org_memberships SET role = 'viewer' WHERE org_id = $1 AND user_id = $2", [o, u]);
    expect(await tokens.resolveToken(raw)).toBeNull();
  });

  test('resolveToken returns null when the owner is no longer a member of the org', async () => {
    const u = nanoid(12);
    await getDb().query(
      'INSERT INTO users (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)',
      [u, `gone-${u}@sap.com`, 'x', new Date().toISOString()]);
    const o = await createOrg();
    await addAdmin(o, u);
    const { raw } = await tokens.createToken(u, 'wk', o);
    expect(await tokens.resolveToken(raw)).toMatchObject({ userId: u });
    await getDb().query('DELETE FROM org_memberships WHERE org_id = $1 AND user_id = $2', [o, u]);
    expect(await tokens.resolveToken(raw)).toBeNull();
  });
});
