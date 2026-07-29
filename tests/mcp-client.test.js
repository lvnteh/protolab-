const { ProtoshareClient } = require('../mcp/lib/client.cjs');

// A fake fetch that records the last call and returns a canned response.
function fakeFetch(response) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    return {
      ok: response.ok !== false,
      status: response.status || 200,
      headers: { get: (h) => (response.headers || {})[h.toLowerCase()] || null },
      async json() { return response.json; },
      async text() { return response.text != null ? response.text : ''; },
    };
  };
  fn.calls = calls;
  return fn;
}

function makeClient(fetchImpl) {
  return new ProtoshareClient({ baseUrl: 'https://host.example.com', token: 'ID.secret', fetchImpl });
}

test('list() GETs /api/v1/prototypes with a bearer header', async () => {
  const f = fakeFetch({ json: [{ id: 'p1' }] });
  const out = await makeClient(f).list();
  expect(f.calls[0].url).toBe('https://host.example.com/api/v1/prototypes');
  expect((f.calls[0].opts.method || 'GET')).toBe('GET');
  expect(f.calls[0].opts.headers.Authorization).toBe('Bearer ID.secret');
  expect(out).toEqual([{ id: 'p1' }]);
});

test('feedback(id) GETs the feedback endpoint', async () => {
  const f = fakeFetch({ json: { prototype: { id: 'p1' }, comments: [], explanations: [] } });
  const out = await makeClient(f).feedback('p1');
  expect(f.calls[0].url).toBe('https://host.example.com/api/v1/prototypes/p1/feedback');
  expect(out.prototype.id).toBe('p1');
});

test('source(id) returns text; source(id,version) adds ?version=N', async () => {
  const f = fakeFetch({ text: '<html>v2</html>', headers: { 'content-type': 'text/html' } });
  const c = makeClient(f);
  await c.source('p1');
  expect(f.calls[0].url).toBe('https://host.example.com/api/v1/prototypes/p1/source');
  await c.source('p1', 2);
  expect(f.calls[1].url).toBe('https://host.example.com/api/v1/prototypes/p1/source?version=2');
});

test('versions(id) GETs the versions list', async () => {
  const f = fakeFetch({ json: [{ version: 2, status: 'published' }] });
  await makeClient(f).versions('p1');
  expect(f.calls[0].url).toBe('https://host.example.com/api/v1/prototypes/p1/versions');
});

test('pushVersion POSTs multipart with file, note and baseVersion', async () => {
  const f = fakeFetch({ status: 201, json: { version: 3, status: 'draft' } });
  const out = await makeClient(f).pushVersion('p1', {
    buffer: Buffer.from('<html>x</html>'), filename: 'checkout.html', note: 'fix', baseVersion: 2,
  });
  const { url, opts } = f.calls[0];
  expect(url).toBe('https://host.example.com/api/v1/prototypes/p1/versions');
  expect(opts.method).toBe('POST');
  expect(opts.headers.Authorization).toBe('Bearer ID.secret');
  expect(opts.body).toBeInstanceOf(FormData);
  expect(opts.body.get('note')).toBe('fix');
  expect(opts.body.get('baseVersion')).toBe('2');
  expect(opts.body.get('file')).toBeInstanceOf(Blob);
  expect(out).toEqual({ version: 3, status: 'draft' });
});

test('pushVersion omits baseVersion when undefined', async () => {
  const f = fakeFetch({ status: 201, json: { version: 2, status: 'draft' } });
  await makeClient(f).pushVersion('p1', { buffer: Buffer.from('x'), filename: 'a.html' });
  expect(f.calls[0].opts.body.get('baseVersion')).toBeNull();
});

test('publish POSTs JSON; omits version when not given', async () => {
  const f = fakeFetch({ json: { version: 3, status: 'published' } });
  const c = makeClient(f);
  await c.publish('p1', 3);
  expect(f.calls[0].opts.method).toBe('POST');
  expect(f.calls[0].opts.headers['Content-Type']).toBe('application/json');
  expect(JSON.parse(f.calls[0].opts.body)).toEqual({ version: 3 });
  await c.publish('p1');
  expect(JSON.parse(f.calls[1].opts.body)).toEqual({});
});

test('a non-2xx response throws an Error with .status and parsed .body', async () => {
  const f = fakeFetch({ ok: false, status: 409, json: { error: 'stale', currentVersion: 2 } });
  await expect(makeClient(f).publish('p1', 3)).rejects.toMatchObject({
    status: 409, body: { error: 'stale', currentVersion: 2 },
  });
});

test('resolveComment POSTs JSON to the resolve endpoint with the version', async () => {
  const f = fakeFetch({ json: { ok: true } });
  const c = makeClient(f);
  await c.resolveComment('p1', 'c1', 3);
  expect(f.calls[0].url).toBe('https://host.example.com/api/v1/prototypes/p1/comments/c1/resolve');
  expect(f.calls[0].opts.method).toBe('POST');
  expect(f.calls[0].opts.headers['Content-Type']).toBe('application/json');
  expect(JSON.parse(f.calls[0].opts.body)).toEqual({ version: 3 });
});

test('resolveComment omits version when not given', async () => {
  const f = fakeFetch({ json: { ok: true } });
  await makeClient(f).resolveComment('p1', 'c1');
  expect(JSON.parse(f.calls[0].opts.body)).toEqual({});
});

test('constructor throws when token is missing', () => {
  expect(() => new ProtoshareClient({ baseUrl: 'x', token: '' })).toThrow(/token/i);
});
