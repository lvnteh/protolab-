// tests/docs-routes.test.js
const express = require('express');
const request = require('supertest');
const { createDocsRouter } = require('../src/routes/docs');

function app(overrides = {}) {
  const repos = { r1: { id: 'r1', org_id: 'org1', owner: 'acme', repo: 'widgets', html_url: 'h', default_branch: 'main' } };
  const deps = {
    tokenAvailable: () => true,
    docsRepos: {
      listRepos: async () => Object.values(repos),
      getRepo: async (org, id) => (repos[id] && repos[id].org_id === org ? repos[id] : null),
      addRepo: async ({ url }) => ({ id: 'r2', owner: 'new', repo: 'repo', url }),
      removeRepo: async () => true,
    },
    makeDocSource: () => ({
      listDocs: async () => [{ path: 'a.md', title: 'A', created: null }],
      readDoc: async () => ({ raw: '# A\n', versionSha: 'abc1234', dirty: false }),
      recentVersions: async () => [],
    }),
    makeGhComments: () => ({ list: async () => [{ id: 1, kind: 'note', text: 'hi' }], post: async () => ({ id: 2 }), del: async () => {} }),
    markdown: require('../src/services/markdown'),
    readView: () => '<!doctype html><body>{{content}}<script id="docs-cfg">{{cfg}}</script></body>',
    // test shims for the org guards:
    requireOrg: (req, _res, next) => { req.orgId = 'org1'; req.orgRole = req.headers['x-role'] || 'admin'; next(); },
    requireAdmin: (req, res, next) => { req.orgId = 'org1'; if ((req.headers['x-role'] || 'admin') !== 'admin') return res.status(403).json({ error: 'admin' }); next(); },
    ...overrides,
  };
  const a = express(); a.use(express.json());
  a.use('/docs', createDocsRouter(deps));
  return a;
}

test('GET /docs/enabled is public and reports token availability', async () => {
  const res = await request(app()).get('/docs/enabled');
  expect(res.status).toBe(200); expect(res.body).toEqual({ enabled: true });
  const res2 = await request(app({ tokenAvailable: () => false })).get('/docs/enabled');
  expect(res2.body).toEqual({ enabled: false });
});

test('GET /docs/view 404s for a repo outside the caller org', async () => {
  const res = await request(app()).get('/docs/view').query({ repo: 'nope', path: 'a.md' });
  expect(res.status).toBe(404);
});

test('GET /docs/view renders for an in-org repo', async () => {
  const res = await request(app()).get('/docs/view').query({ repo: 'r1', path: 'a.md' });
  expect(res.status).toBe(200);
  expect(res.text).toContain('data-source-line'); // sourceLines render
  expect(res.text).toContain('abc1234');          // version sha in cfg
});

test('GET /docs/comments is repo-scoped', async () => {
  const res = await request(app()).get('/docs/comments').query({ repo: 'r1', path: 'a.md', sha: 'abc1234' });
  expect(res.status).toBe(200); expect(res.body[0]).toMatchObject({ kind: 'note' });
});

test('POST /docs/repos requires admin', async () => {
  const ok = await request(app()).post('/docs/repos').send({ url: 'https://github.com/new/repo' });
  expect(ok.status).toBe(201);
  const no = await request(app()).post('/docs/repos').set('x-role', 'viewer').send({ url: 'https://github.com/new/repo' });
  expect(no.status).toBe(403);
});

test('POST /docs/repos maps a bad url to 400', async () => {
  const bad = await request(app({ docsRepos: { addRepo: async () => { const e = new Error('not a github.com url'); throw e; }, listRepos: async () => [], getRepo: async () => null, removeRepo: async () => true } }))
    .post('/docs/repos').send({ url: 'https://evil.com/x/y' });
  expect(bad.status).toBe(400);
});

test('POST /docs/repos maps a no-access GitHub error to 502', async () => {
  const res = await request(app({ docsRepos: { addRepo: async () => { throw new Error('no access to acme/widgets (GitHub 404)'); }, listRepos: async () => [], getRepo: async () => null, removeRepo: async () => true } }))
    .post('/docs/repos').send({ url: 'https://github.com/acme/widgets' });
  expect(res.status).toBe(502);
});

test('POST /docs/repos maps a network failure to 502 (not 400)', async () => {
  const res = await request(app({ docsRepos: { addRepo: async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); }, listRepos: async () => [], getRepo: async () => null, removeRepo: async () => true } }))
    .post('/docs/repos').send({ url: 'https://github.com/acme/widgets' });
  expect(res.status).toBe(502);
});

test('POST /docs/comments with a foreign repo id returns 404', async () => {
  const res = await request(app()).post('/docs/comments').send({ repo: 'foreign', path: 'a.md', sha: 'abc1234' });
  expect(res.status).toBe(404);
});

test('DELETE /docs/comments/:id with a foreign ?repo= returns 404', async () => {
  const res = await request(app()).delete('/docs/comments/7').query({ repo: 'foreign' });
  expect(res.status).toBe(404);
});
