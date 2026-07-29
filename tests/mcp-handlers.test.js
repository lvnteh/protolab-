const handlers = require('../mcp/lib/handlers.cjs');

// Build a ctx with a fake client (records calls, returns canned data), an
// in-memory manifest, and in-memory file I/O.
function makeCtx(overrides = {}) {
  const calls = [];
  const files = overrides.files || {};
  const client = {
    list: async () => (calls.push(['list']), overrides.list || []),
    feedback: async (id) => (calls.push(['feedback', id]), overrides.feedback || { prototype: { id, name: 'X', publishedVersion: 1, draftVersion: null }, comments: [], explanations: [] }),
    source: async (id, v) => (calls.push(['source', id, v]), overrides.source != null ? overrides.source : '<html></html>'),
    versions: async (id) => (calls.push(['versions', id]), overrides.versions || [{ version: 1, status: 'published' }]),
    pushVersion: async (id, opts) => (calls.push(['pushVersion', id, opts]), overrides.push || { version: 2, status: 'draft' }),
    publish: async (id, v) => (calls.push(['publish', id, v]), overrides.publish || { version: 2, status: 'published' }),
    resolveComment: async (id, commentId, v) => (calls.push(['resolveComment', id, commentId, v]), overrides.resolve || { ok: true }),
  };
  const manifest = overrides.manifest || { remote: 'https://r', prototypes: { 'checkout.html': { id: 'ID_C', lastPulled: 1 } } };
  const saved = [];
  const ctx = {
    client,
    manifest,
    manifestPath: '/tmp/fake-manifest.json',
    readFile: (p) => { if (!(p in files)) { const e = new Error('no'); e.code = 'ENOENT'; throw e; } return files[p]; },
    writeFile: (p, data) => { files[p] = data; },
    // manifest.save is stubbed via saveManifest injection
    saveManifest: (m) => { saved.push(JSON.parse(JSON.stringify(m))); },
  };
  return { ctx, calls, files, saved, manifest };
}

test('list formats each prototype with id, name and versions', async () => {
  const { ctx, calls } = makeCtx({ list: [
    { id: 'ID_C', name: 'Checkout', shareLink: 'https://r/p/t', publishedVersion: 2, draftVersion: 3 },
  ] });
  const text = await handlers.list(ctx, {});
  expect(calls[0]).toEqual(['list']);
  expect(text).toMatch(/Checkout/);
  expect(text).toMatch(/ID_C/);
  expect(text).toMatch(/published v2/i);
  expect(text).toMatch(/draft v3/i);
});

test('pull resolves file→id, returns feedback, and records lastPulled', async () => {
  const { ctx, calls, saved } = makeCtx({
    feedback: { prototype: { id: 'ID_C', name: 'Checkout', publishedVersion: 2, draftVersion: null },
      comments: [{ id: 'c1', tag: 'bug', comment: 'broken', madeAgainstVersion: 2, resolved: false, replies: [] }],
      explanations: [{ elementSelector: '.x', body: 'does y' }] },
  });
  const text = await handlers.pull(ctx, { file_or_id: 'checkout.html' });
  expect(calls[0]).toEqual(['feedback', 'ID_C']); // resolved via manifest
  expect(text).toMatch(/broken/);
  expect(text).toMatch(/\.x/);
  // lastPulled advanced to publishedVersion (2) and manifest saved
  expect(saved.length).toBe(1);
  expect(saved[0].prototypes['checkout.html'].lastPulled).toBe(2);
});

test('source writes the HTML to the local file when file_or_id is a known file', async () => {
  const { ctx, files } = makeCtx({ source: '<html>live</html>' });
  const text = await handlers.source(ctx, { file_or_id: 'checkout.html' });
  expect(files['checkout.html']).toBe('<html>live</html>');
  expect(text).toMatch(/checkout\.html/);
});

test('push reads the local file, sends baseVersion from manifest, records lastPushed', async () => {
  const { ctx, calls, saved } = makeCtx({
    files: { 'checkout.html': '<html>edited</html>' },
    manifest: { remote: 'https://r', prototypes: { 'checkout.html': { id: 'ID_C', lastPulled: 2 } } },
    push: { version: 3, status: 'draft' },
  });
  const text = await handlers.push(ctx, { file: 'checkout.html', note: 'fix cart' });
  const call = calls.find(c => c[0] === 'pushVersion');
  expect(call[1]).toBe('ID_C');
  expect(call[2].baseVersion).toBe(2);            // from manifest max(lastPulled,lastPushed)
  expect(call[2].note).toBe('fix cart');
  expect(Buffer.isBuffer(call[2].buffer)).toBe(true);
  expect(text).toMatch(/draft v3/i);
  expect(saved[0].prototypes['checkout.html'].lastPushed).toBe(3);
});

test('push surfaces a 409 conflict as a clear message', async () => {
  const { ctx } = makeCtx({ files: { 'checkout.html': 'x' } });
  ctx.client.pushVersion = async () => { const e = new Error('x'); e.status = 409; e.body = { currentVersion: 5 }; throw e; };
  const text = await handlers.push(ctx, { file: 'checkout.html' });
  expect(text).toMatch(/conflict/i);
  expect(text).toMatch(/version 5/i);
});

test('publish reports the promoted version', async () => {
  const { ctx, calls } = makeCtx({ publish: { version: 3, status: 'published' } });
  const text = await handlers.publish(ctx, { file_or_id: 'checkout.html', version: 3 });
  expect(calls.find(c => c[0] === 'publish')).toEqual(['publish', 'ID_C', 3]);
  expect(text).toMatch(/published v3/i);
});

test('status compares manifest versions against the remote', async () => {
  const { ctx } = makeCtx({
    manifest: { remote: 'https://r', prototypes: { 'checkout.html': { id: 'ID_C', lastPulled: 1, lastPushed: 2 } } },
    versions: [{ version: 3, status: 'draft' }, { version: 2, status: 'published' }],
  });
  const text = await handlers.status(ctx, { file_or_id: 'checkout.html' });
  expect(text).toMatch(/local/i);
  expect(text).toMatch(/remote/i);
  expect(text).toMatch(/3/); // remote latest
});

test('resolve marks a comment addressed in a version', async () => {
  const { ctx, calls } = makeCtx({});
  const text = await handlers.resolve(ctx, { file_or_id: 'checkout.html', comment_id: 'c1', version: 3 });
  expect(calls.find(c => c[0] === 'resolveComment')).toEqual(['resolveComment', 'ID_C', 'c1', 3]);
  expect(text).toMatch(/resolved/i);
  expect(text).toMatch(/c1/);
});

test('pull records max(published, draft) so an existing draft does not cause a stale base', async () => {
  // Server has published v2 and an unpublished draft v3 (authored elsewhere).
  // A fresh client pulling must record 3, not 2, so its next push sends
  // baseVersion=3 and matches the server's MAX-based conflict guard.
  const { ctx, saved } = makeCtx({
    manifest: { remote: 'https://r', prototypes: { 'checkout.html': { id: 'ID_C' } } },
    feedback: { prototype: { id: 'ID_C', name: 'Checkout', publishedVersion: 2, draftVersion: 3 },
      comments: [], explanations: [] },
  });
  await handlers.pull(ctx, { file_or_id: 'checkout.html' });
  expect(saved[0].prototypes['checkout.html'].lastPulled).toBe(3);
});

test('pull formats element selectors and nested replies', async () => {
  const { ctx } = makeCtx({
    feedback: { prototype: { id: 'ID_C', name: 'Checkout', publishedVersion: 1, draftVersion: null },
      comments: [{ id: 'c1', tag: 'bug', comment: 'broken', madeAgainstVersion: 1, resolved: false,
        element: { selector: '#btn' }, replies: [{ comment: 'agreed', email: 'a@b.c' }] }],
      explanations: [] },
  });
  const text = await handlers.pull(ctx, { file_or_id: 'checkout.html' });
  expect(text).toMatch(/@ #btn/);
  expect(text).toMatch(/↳ agreed/);
});

test('list reports when there are no prototypes', async () => {
  const { ctx } = makeCtx({ list: [] });
  expect(await handlers.list(ctx, {})).toMatch(/No prototypes found/i);
});

test('source returns HTML inline when the argument is a bare id (no local file mapping)', async () => {
  const { ctx, files } = makeCtx({ source: '<html>inline</html>' });
  const text = await handlers.source(ctx, { file_or_id: 'UNKNOWN_ID' });
  expect(text).toBe('<html>inline</html>');
  expect(Object.keys(files)).not.toContain('UNKNOWN_ID'); // nothing written
});

test('status falls back to the id when the file is unknown', async () => {
  const { ctx } = makeCtx({ versions: [{ version: 1, status: 'published' }] });
  const text = await handlers.status(ctx, { file_or_id: 'ID_ONLY' });
  expect(text).toMatch(/Status for ID_ONLY/);
  expect(text).toMatch(/lastPulled v—/);
});

test('push surfaces 404 and 401 with clear messages', async () => {
  const mk = () => makeCtx({ files: { 'checkout.html': 'x' } });
  const c1 = mk(); c1.ctx.client.pushVersion = async () => { const e = new Error('x'); e.status = 404; throw e; };
  expect(await handlers.push(c1.ctx, { file: 'checkout.html' })).toMatch(/not found/i);
  const c2 = mk(); c2.ctx.client.pushVersion = async () => { const e = new Error('x'); e.status = 401; throw e; };
  expect(await handlers.push(c2.ctx, { file: 'checkout.html' })).toMatch(/unauthorized/i);
});

test('push reports when the local file is missing', async () => {
  const { ctx } = makeCtx({}); // no files
  expect(await handlers.push(ctx, { file: 'missing.html' })).toMatch(/not found/i);
});

test('publish surfaces 404 and rethrows unexpected errors', async () => {
  const a = makeCtx({}); a.ctx.client.publish = async () => { const e = new Error('x'); e.status = 404; throw e; };
  expect(await handlers.publish(a.ctx, { file_or_id: 'checkout.html' })).toMatch(/not found/i);
  const b = makeCtx({}); b.ctx.client.publish = async () => { throw new Error('boom'); };
  await expect(handlers.publish(b.ctx, { file_or_id: 'checkout.html' })).rejects.toThrow('boom');
});
