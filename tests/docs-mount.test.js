// tests/docs-mount.test.js
const request = require('supertest');
function freshApp() { jest.resetModules(); return require('../src/server'); }

test('/docs/enabled is public (no login) and returns JSON', async () => {
  const res = await request(freshApp()).get('/docs/enabled');
  expect(res.status).toBe(200);
  expect(typeof res.body.enabled).toBe('boolean');
});

test('/docs requires login (redirects or 403 when unauthenticated)', async () => {
  const res = await request(freshApp()).get('/docs').redirects(0);
  expect([302, 401, 403]).toContain(res.status);
});
