// tests/docs-routes.test.js
const express = require('express');
const request = require('supertest');
const { createDocsRouter } = require('../src/routes/docs');

function appWith(overrides = {}) {
  const docSource = {
    listDocs: async () => [{ path: 'a.md', title: 'A' }],
    readDoc: async () => ({ raw: '# A\n\npara\n', versionSha: 'sha123', dirty: false }),
    repoSlug: async () => ({ owner: 'o', repo: 'r' }),
    recentVersions: async () => [{ sha: 'sha123', date: '2026-10-06', subject: 'init' }],
    ...overrides.docSource,
  };
  const ghComments = {
    list: async () => [{ id: 1, kind: 'note', text: 'hi', line: 1, path: 'a.md', anchor: null, author: 'me', hasMeta: true }],
    post: async (sha, c) => ({ id: 2, ...c, author: 'me', hasMeta: true }),
    del: async () => {},
    ...overrides.ghComments,
  };
  const markdown = require('../src/services/markdown');
  const readView = () => '<!doctype html><html><body>{{content}}<script id="docs-cfg">{{cfg}}</script></body></html>';
  const app = express();
  app.use(express.json());
  app.use('/docs', createDocsRouter({ docSource, ghComments, markdown, readView }));
  return app;
}

test('GET /docs lists docs', async () => {
  const res = await request(appWith()).get('/docs');
  expect(res.status).toBe(200);
  expect(res.text).toContain('a.md');
});

test('GET /docs/view renders with source lines and the version sha', async () => {
  const res = await request(appWith()).get('/docs/view').query({ path: 'a.md' });
  expect(res.status).toBe(200);
  expect(res.text).toContain('data-source-line="1"');
  expect(res.text).toContain('sha123');
});

test('GET /docs/comments returns the GitHub comments for the sha+path', async () => {
  const res = await request(appWith()).get('/docs/comments').query({ path: 'a.md', sha: 'sha123' });
  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(1);
  expect(res.body[0]).toMatchObject({ kind: 'note', text: 'hi' });
});

test('POST /docs/comments posts to GitHub and returns the created comment', async () => {
  const res = await request(appWith()).post('/docs/comments')
    .send({ path: 'a.md', sha: 'sha123', line: 2, kind: 'question', text: 'why?', anchor: null });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ id: 2, kind: 'question', text: 'why?' });
});

test('DELETE /docs/comments/:id returns 204', async () => {
  const res = await request(appWith()).delete('/docs/comments/7');
  expect(res.status).toBe(204);
});

test('POST is rejected when the file has no committed version', async () => {
  const app = appWith({ docSource: { readDoc: async () => ({ raw: '# x', versionSha: null, dirty: true }) } });
  const res = await request(app).post('/docs/comments')
    .send({ path: 'new.md', sha: null, line: 1, kind: 'note', text: 'x', anchor: null });
  expect(res.status).toBe(409);
});
