// tests/doc-source.test.js
const { createDocSource, assertSafePath } = require('../src/services/docSource');

// fake fetch keyed by URL substring
function fake(routes) {
  return async (url) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    const r = key ? routes[key] : { status: 404, json: {} };
    return { ok: (r.status || 200) < 400, status: r.status || 200, async json() { return r.json; }, async text() { return r.text || ''; } };
  };
}

const base64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('listDocs filters .md blobs and excludes README/CLAUDE', async () => {
  const ds = createDocSource({ owner: 'o', repo: 'r', token: 't', fetchImpl: fake({
    '/git/trees/main': { json: { tree: [
      { path: 'guide/intro.md', type: 'blob' },
      { path: 'README.md', type: 'blob' },
      { path: 'img/logo.png', type: 'blob' },
      { path: 'guide', type: 'tree' },
    ] } },
    '/commits?': { json: [] },
  }) });
  const docs = await ds.listDocs();
  expect(docs.map((d) => d.path)).toEqual(['guide/intro.md']);
  expect(docs[0]).toHaveProperty('title');
  expect(docs[0]).toHaveProperty('created');
});

test('readDoc decodes contents at a ref and resolves the version sha', async () => {
  const ds = createDocSource({ owner: 'o', repo: 'r', token: 't', fetchImpl: fake({
    '/contents/guide/intro.md': { json: { content: base64('# Intro\nhi'), encoding: 'base64' } },
    '/commits?path=guide%2Fintro.md': { json: [{ sha: 'abcdef1234567' }] },
  }) });
  const doc = await ds.readDoc('guide/intro.md');
  expect(doc.raw).toContain('# Intro');
  expect(doc.versionSha).toBe('abcdef1234567');
  expect(doc.dirty).toBe(false);
});

test('rejects unsafe path and bad ref before fetching', async () => {
  const ds = createDocSource({ owner: 'o', repo: 'r', token: 't', fetchImpl: fake({}) });
  await expect(ds.readDoc('../../etc/passwd')).rejects.toThrow(/unsafe/i);
  await expect(ds.readDoc('a/b.md', 'not a ref!')).rejects.toThrow(/ref/i);
});
