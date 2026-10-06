const { createGhComments } = require('../src/services/ghComments');
const { encodeBody } = require('../src/services/ghCommentCodec');

function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const h = handlers(url, opts);
    return {
      ok: (h.status || 200) < 400,
      status: h.status || 200,
      async json() { return h.json; },
    };
  };
  fn.calls = calls;
  return fn;
}

const anchor = { quote: 'x', prefix: '', suffix: '', start: 0, end: 1 };

test('list filters by path and parses the codec', async () => {
  const fetchImpl = fakeFetch(() => ({
    json: [
      { id: 1, user: { login: 'ann' }, created_at: 't', html_url: 'u1', path: null,
        body: encodeBody({ text: 'q', kind: 'question', path: 'a.md', line: 3, anchor }) },
      { id: 2, user: { login: 'bob' }, created_at: 't', html_url: 'u2', path: null,
        body: encodeBody({ text: 'other', kind: 'note', path: 'b.md', line: 1, anchor }) },
    ],
  }));
  const gh = createGhComments({ owner: 'o', repo: 'r', token: 't', fetchImpl });
  const out = await gh.list('deadbeef', 'a.md');
  expect(out.map((c) => c.id)).toEqual([1]);
  expect(out[0]).toMatchObject({ kind: 'question', line: 3, author: 'ann', hasMeta: true });
});

test('a native github comment (no codec) falls back to github path', async () => {
  const fetchImpl = fakeFetch(() => ({
    json: [{ id: 9, user: { login: 'x' }, created_at: 't', html_url: 'u', path: 'a.md', body: 'typed on github' }],
  }));
  const gh = createGhComments({ owner: 'o', repo: 'r', token: 't', fetchImpl });
  const out = await gh.list('sha', 'a.md');
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ hasMeta: false, kind: 'note', text: 'typed on github' });
});

test('post sends an encoded body to the commit comments endpoint', async () => {
  const fetchImpl = fakeFetch((url, opts) => ({
    json: { id: 5, user: { login: 'me' }, created_at: 't', html_url: 'h', path: null, body: JSON.parse(opts.body).body },
  }));
  const gh = createGhComments({ owner: 'o', repo: 'r', token: 't', fetchImpl });
  const c = await gh.post('abc', { path: 'a.md', line: 7, text: 'fix this', kind: 'change-request', anchor });
  expect(fetchImpl.calls[0].url).toBe('https://api.github.com/repos/o/r/commits/abc/comments');
  expect(fetchImpl.calls[0].method).toBe('POST');
  expect(c).toMatchObject({ id: 5, kind: 'change-request', path: 'a.md', line: 7 });
});

test('del hits the comment delete endpoint', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 204, json: null }));
  const gh = createGhComments({ owner: 'o', repo: 'r', token: 't', fetchImpl });
  await gh.del(42);
  expect(fetchImpl.calls[0]).toMatchObject({ url: 'https://api.github.com/repos/o/r/comments/42', method: 'DELETE' });
});

test('a non-ok response throws', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 403, json: { message: 'rate limited' } }));
  const gh = createGhComments({ owner: 'o', repo: 'r', token: 't', fetchImpl });
  await expect(gh.list('sha', 'a.md')).rejects.toThrow(/403/);
});

test('resolveToken prefers env, else errors clearly when gh is unavailable', () => {
  const { resolveToken } = require('../src/services/ghComments');
  expect(resolveToken({ env: { DOCS_GITHUB_TOKEN: 'tok' } })).toBe('tok');
  const throwingExec = () => { throw new Error('gh missing'); };
  expect(() => resolveToken({ env: {}, exec: throwingExec })).toThrow(/No GitHub token/);
});
