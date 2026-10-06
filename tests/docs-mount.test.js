// tests/docs-mount.test.js
const request = require('supertest');

function freshApp(env) {
  jest.resetModules();
  const ORIG = { ...process.env };
  Object.assign(process.env, env);
  const app = require('../src/server');
  process.env = ORIG;
  return app;
}

test('docs routes are absent when DOCS_REPO_PATH is unset', async () => {
  const app = freshApp({ DOCS_REPO_PATH: '' });
  const res = await request(app).get('/docs');
  expect(res.status).toBe(404);
});
