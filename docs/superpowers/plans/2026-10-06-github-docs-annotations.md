# GitHub-Backed `.md` Docs Review + Commit-Comment Annotations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an isolated `/docs` workflow that browses a local git clone's `.md` files, renders them, and lets reviewers annotate — persisting annotations only to GitHub as commit comments pinned to a commit SHA.

**Architecture:** Three new, interface-bounded units — `docSource` (local git reader), `ghComments` (GitHub commit-comments client + body codec), `docs` routes — plus an opt-in `sourceLines` mode on the existing markdown renderer and a reused range-anchor SDK in a new "docs" mode. No new DB tables; GitHub is the single store.

**Tech Stack:** Node 22, Express 5, CommonJS, markdown-it 14 + sanitize-html, global `fetch` (no new dependency), `git` CLI via `child_process`, Jest + supertest.

**Spec:** `docs/superpowers/specs/2026-10-06-github-docs-annotations-design.md`

## Global Constraints

- Node 22; CommonJS (`require`/`module.exports`); Express 5.
- **No new runtime dependency** — `ghComments` uses global `fetch`; git via `child_process`.
- Existing prototype/upload/delivery path and `markdown.render` default output must stay **byte-identical** (the `sourceLines` option is opt-in, default off).
- GitHub is the **single store** for annotations — no new DB tables, no comment persistence in Postgres for this workflow.
- Comments authored via the **operator's token** (`DOCS_GITHUB_TOKEN` → `GITHUB_TOKEN` → `gh auth token`); the token is **server-side only**, never sent to the browser.
- `owner/repo` is derived from the clone's `origin` remote; no arbitrary-repo posting.
- `/docs` mounts **only when `DOCS_REPO_PATH` is set** — the app is unaffected when it is absent.
- Commit messages: Conventional Commits, **no footer** (match repo history).

## Review Focus

- **Path traversal in `?path=`** (`../../etc/passwd`, absolute paths, non-`.md`): `docSource` must reject anything outside the repo or not ending in `.md`. → Task 3, Step adds `assertSafePath` + test.
- **Third-party / malformed comment bodies** (no codec block, invalid JSON, a comment authored natively on GitHub): `list` must never throw; degrade to a plain line-less note. → Task 2 (parse) + Task 4 (list tolerance) tests.
- **Never-committed file** (no SHA): viewable from the working tree, but commenting disabled; nothing crashes. → Task 3 `readDoc` null-SHA test.
- **SSH vs HTTPS `origin` remotes** (`git@github.com:o/r.git` vs `https://github.com/o/r.git`): `repoSlug` parses both. → Task 3 test.
- **Missing GitHub token**: a clear, actionable error — not a stack trace, and not at module load. → Task 4 `resolveToken` test.

---

### Task 1: Opt-in source-line annotation in the markdown renderer

**Files:**
- Modify: `src/services/markdown.js`
- Test: `tests/markdown-sourcelines.test.js` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `render(rawMd, opts?)` where `opts.sourceLines === true` injects `data-source-line="<1-based line>"` on block-level open tags; default/omitted keeps current output byte-identical. Still returns `{ html }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/markdown-sourcelines.test.js
const markdown = require('../src/services/markdown');

test('default render is unchanged (no data-source-line)', () => {
  const { html } = markdown.render('# Title\n\npara\n');
  expect(html).not.toContain('data-source-line');
  expect(html).toContain('<h1>Title</h1>');
});

test('sourceLines injects 1-based line numbers on block tags', () => {
  const { html } = markdown.render('# Title\n\nsecond para on line 3\n', { sourceLines: true });
  expect(html).toContain('<h1 data-source-line="1">Title</h1>');
  expect(html).toMatch(/<p data-source-line="3">second para/);
});

test('data-source-line survives sanitization', () => {
  const { html } = markdown.render('- a\n- b\n', { sourceLines: true });
  expect(html).toMatch(/<li data-source-line="\d+">/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/markdown-sourcelines.test.js -i`
Expected: FAIL — current `render` ignores opts; no `data-source-line`.

- [ ] **Step 3: Implement**

Replace the body of `src/services/markdown.js` to add a second markdown-it instance carrying a line-injection rule, allow the attribute through sanitize, and switch instance on the option:

```js
const MarkdownIt = require('markdown-it');
const sanitizeHtml = require('sanitize-html');

const BASE_OPTS = { html: false, linkify: true, breaks: false, typographer: true };
const md = new MarkdownIt(BASE_OPTS);

// Separate instance so the default renderer stays untouched.
const mdLines = new MarkdownIt(BASE_OPTS);
mdLines.core.ruler.push('source_line', (state) => {
  for (const token of state.tokens) {
    if (token.nesting === 1 && token.map) {
      token.attrSet('data-source-line', String(token.map[0] + 1));
    }
  }
});

const SANITIZE_OPTIONS = {
  allowedTags: [
    'h1','h2','h3','h4','h5','h6','p','a','ul','ol','li','blockquote','hr','br',
    'strong','em','del','code','pre','span','table','thead','tbody','tr','th','td','img','input',
  ],
  allowedAttributes: {
    '*': ['data-source-line'],
    a: ['href','title'], img: ['src','alt','title'],
    input: ['type','checked','disabled'], span: ['class'], code: ['class'],
    pre: ['class'], th: ['align'], td: ['align'],
  },
  allowedSchemes: ['http','https','mailto'],
  transformTags: {
    input: (tagName, attribs) => ({
      tagName,
      attribs: { type: 'checkbox', disabled: 'disabled', ...(attribs.checked ? { checked: 'checked' } : {}) },
    }),
  },
};

function render(rawMd, opts = {}) {
  const engine = opts.sourceLines ? mdLines : md;
  const rendered = engine.render(String(rawMd == null ? '' : rawMd));
  return { html: sanitizeHtml(rendered, SANITIZE_OPTIONS) };
}

module.exports = { render };
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/markdown-sourcelines.test.js tests/markdown-schema.test.js -i`
Expected: PASS (new file) and PASS (existing markdown tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/services/markdown.js tests/markdown-sourcelines.test.js
git commit -m "feat(markdown): opt-in data-source-line annotation for docs review"
```

---

### Task 2: Comment-body codec (encode / tolerant parse)

**Files:**
- Create: `src/services/ghCommentCodec.js`
- Test: `tests/gh-comment-codec.test.js`

**Interfaces:**
- Produces:
  - `encodeBody({ text, kind, path, line, anchor, tag?, replyTo? })` → `string` (reviewer text + a trailing `<!-- protoshare:v1 {json} -->` block).
  - `parseBody(body)` → `{ text, kind, path, line, anchor, tag, replyTo, hasMeta }`. Never throws. No/invalid block ⇒ `hasMeta:false`, `kind:'note'`, nulls, `text` = full body trimmed.

- [ ] **Step 1: Write the failing test**

```js
// tests/gh-comment-codec.test.js
const { encodeBody, parseBody } = require('../src/services/ghCommentCodec');

const anchor = { quote: 'foo', prefix: 'a ', suffix: ' b', start: 2, end: 5 };

test('round-trips text + metadata', () => {
  const body = encodeBody({ text: 'please clarify', kind: 'question', path: 'a/b.md', line: 12, anchor, tag: 'copy' });
  const p = parseBody(body);
  expect(p.text).toBe('please clarify');
  expect(p.kind).toBe('question');
  expect(p.path).toBe('a/b.md');
  expect(p.line).toBe(12);
  expect(p.anchor).toEqual(anchor);
  expect(p.tag).toBe('copy');
  expect(p.replyTo).toBeNull();
  expect(p.hasMeta).toBe(true);
});

test('a plain GitHub comment with no block degrades gracefully', () => {
  const p = parseBody('just a normal comment typed on github');
  expect(p.hasMeta).toBe(false);
  expect(p.kind).toBe('note');
  expect(p.text).toBe('just a normal comment typed on github');
  expect(p.anchor).toBeNull();
});

test('malformed json in the block does not throw', () => {
  const p = parseBody('hi\n\n<!-- protoshare:v1 {not json} -->');
  expect(p.hasMeta).toBe(false);
  expect(p.text).toContain('hi');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/gh-comment-codec.test.js -i`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```js
// src/services/ghCommentCodec.js
// Encodes/decodes a ProtoLab annotation into a GitHub commit-comment body.
// The body is the reviewer's text plus a trailing machine block carrying the
// kind, file path, raw line, and the durable text anchor so ProtoLab can
// re-highlight the exact span. Parsing is tolerant: any body that is not a
// well-formed ProtoLab block (including comments authored on GitHub directly)
// decodes to a plain note and never throws.
const MARKER_RE = /\n\n<!-- protoshare:v1 ([\s\S]*?) -->\s*$/;

function encodeBody({ text, kind, path = null, line = null, anchor = null, tag = null, replyTo = null }) {
  const meta = { kind, path, line, anchor, tag, replyTo };
  return `${String(text == null ? '' : text).trim()}\n\n<!-- protoshare:v1 ${JSON.stringify(meta)} -->`;
}

function plain(body) {
  return { text: String(body == null ? '' : body).trim(), kind: 'note', path: null, line: null, anchor: null, tag: null, replyTo: null, hasMeta: false };
}

function parseBody(body) {
  const src = String(body == null ? '' : body);
  const m = src.match(MARKER_RE);
  if (!m) return plain(src);
  let meta;
  try { meta = JSON.parse(m[1]); } catch { return plain(src); }
  if (!meta || typeof meta !== 'object') return plain(src);
  return {
    text: src.slice(0, m.index).trim(),
    kind: meta.kind || 'note',
    path: meta.path ?? null,
    line: meta.line ?? null,
    anchor: meta.anchor ?? null,
    tag: meta.tag ?? null,
    replyTo: meta.replyTo ?? null,
    hasMeta: true,
  };
}

module.exports = { encodeBody, parseBody };
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/gh-comment-codec.test.js -i`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/ghCommentCodec.js tests/gh-comment-codec.test.js
git commit -m "feat(docs): commit-comment body codec with tolerant parse"
```

---

### Task 3: `docSource` — local git reader

**Files:**
- Create: `src/services/docSource.js`
- Test: `tests/doc-source.test.js`

**Interfaces:**
- Produces `createDocSource(repoPath)` → object:
  - `listDocs()` → `Promise<Array<{ path, title }>>` (tracked `*.md`, excluding `README.md`/`CLAUDE.md`).
  - `resolveVersionSha(path)` → `Promise<string|null>` (last commit to touch the file; null if never committed).
  - `readDoc(path, sha?)` → `Promise<{ raw, versionSha, dirty }>` (content at `sha` or current version; working-tree read when never committed, with `versionSha:null, dirty:true`).
  - `recentVersions(path, limit=20)` → `Promise<Array<{ sha, date, subject }>>`.
  - `repoSlug()` → `Promise<{ owner, repo }>`.
  - Throws on unsafe `path` (outside repo / not `.md`).

- [ ] **Step 1: Write the failing test**

```js
// tests/doc-source.test.js
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createDocSource } = require('../src/services/docSource');

function sh(cwd, args) { execFileSync('git', args, { cwd, stdio: 'pipe' }); }

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docsrc-'));
  sh(dir, ['init', '-q']);
  sh(dir, ['config', 'user.email', 't@t.t']);
  sh(dir, ['config', 'user.name', 'T']);
  sh(dir, ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
  fs.mkdirSync(path.join(dir, 'guide'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'guide/intro.md'), '---\ntitle: Intro\n---\n# Intro\nhello\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# ignore me\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'init']);
  return dir;
}

test('listDocs returns tracked .md with titles, excludes README', async () => {
  const ds = createDocSource(makeRepo());
  const docs = await ds.listDocs();
  expect(docs).toEqual([{ path: 'guide/intro.md', title: 'Intro' }]);
});

test('resolveVersionSha + readDoc return committed content at a real sha', async () => {
  const ds = createDocSource(makeRepo());
  const sha = await ds.resolveVersionSha('guide/intro.md');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  const doc = await ds.readDoc('guide/intro.md');
  expect(doc.versionSha).toBe(sha);
  expect(doc.raw).toContain('# Intro');
  expect(doc.dirty).toBe(false);
});

test('dirty working tree is reported', async () => {
  const dir = makeRepo();
  const ds = createDocSource(dir);
  fs.appendFileSync(path.join(dir, 'guide/intro.md'), '\nedited\n');
  const doc = await ds.readDoc('guide/intro.md');
  expect(doc.dirty).toBe(true);
  expect(doc.raw).not.toContain('edited'); // committed content, not working tree
});

test('never-committed file reads from the working tree with null sha', async () => {
  const dir = makeRepo();
  const ds = createDocSource(dir);
  fs.writeFileSync(path.join(dir, 'guide/new.md'), '# New\n');
  const doc = await ds.readDoc('guide/new.md');
  expect(doc.versionSha).toBeNull();
  expect(doc.raw).toContain('# New');
  expect(doc.dirty).toBe(true);
});

test('repoSlug parses ssh and https remotes', async () => {
  const ssh = createDocSource(makeRepo());
  expect(await ssh.repoSlug()).toEqual({ owner: 'acme', repo: 'widgets' });

  const dir = makeRepo();
  execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git'], { cwd: dir });
  expect(await createDocSource(dir).repoSlug()).toEqual({ owner: 'acme', repo: 'widgets' });
});

test('rejects path traversal and non-markdown', async () => {
  const ds = createDocSource(makeRepo());
  await expect(ds.readDoc('../../etc/passwd')).rejects.toThrow(/unsafe/i);
  await expect(ds.readDoc('/abs/x.md')).rejects.toThrow(/unsafe/i);
  await expect(ds.readDoc('guide/intro.txt')).rejects.toThrow(/unsafe/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/doc-source.test.js -i`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```js
// src/services/docSource.js
// Reads a local git clone of a docs repo. All git access is isolated here so a
// future hosted/server-clone or GitHub-API implementation can replace this
// module behind the same surface. Paths are validated against traversal.
const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const pexec = promisify(execFile);

const IGNORED = new Set(['README.md', 'CLAUDE.md']);

function createDocSource(repoPath) {
  async function git(args) {
    const { stdout } = await pexec('git', args, { cwd: repoPath, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  }

  // Reject absolute paths, traversal, and non-.md. Returns a normalized posix path.
  function assertSafePath(p) {
    const norm = path.posix.normalize(String(p || ''));
    if (!norm.endsWith('.md') || norm.startsWith('/') || norm.startsWith('..') || norm.includes('../')) {
      throw new Error(`unsafe doc path: ${p}`);
    }
    return norm;
  }

  function titleFor(raw, fallbackPath) {
    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      const t = fm[1].match(/^title:\s*(.+)\s*$/m);
      if (t) return t[1].trim().replace(/^["']|["']$/g, '');
    }
    const h1 = raw.match(/^#\s+(.+)$/m);
    if (h1) return h1[1].trim();
    return path.posix.basename(fallbackPath).replace(/\.md$/, '');
  }

  async function listDocs() {
    const out = await git(['ls-files', '-z', '*.md']);
    const paths = out.split('\0').filter(Boolean)
      .filter((p) => !IGNORED.has(path.posix.basename(p)));
    const docs = [];
    for (const p of paths) {
      let raw = '';
      try { raw = await fs.readFile(path.join(repoPath, p), 'utf8'); } catch { /* unreadable */ }
      docs.push({ path: p, title: titleFor(raw, p) });
    }
    docs.sort((a, b) => a.path.localeCompare(b.path));
    return docs;
  }

  async function resolveVersionSha(p) {
    const safe = assertSafePath(p);
    const out = (await git(['log', '-1', '--format=%H', '--', safe])).trim();
    return out || null;
  }

  async function readDoc(p, sha) {
    const safe = assertSafePath(p);
    const versionSha = sha || await resolveVersionSha(safe);
    if (!versionSha) {
      const raw = await fs.readFile(path.join(repoPath, safe), 'utf8');
      return { raw, versionSha: null, dirty: true };
    }
    const raw = await git(['show', `${versionSha}:${safe}`]);
    const status = (await git(['status', '--porcelain', '--', safe])).trim();
    return { raw, versionSha, dirty: status.length > 0 };
  }

  async function recentVersions(p, limit = 20) {
    const safe = assertSafePath(p);
    const out = await git(['log', `-${limit}`, '--format=%H%x09%cs%x09%s', '--', safe]);
    return out.trim().split('\n').filter(Boolean).map((l) => {
      const [sha, date, subject] = l.split('\t');
      return { sha, date, subject };
    });
  }

  async function repoSlug() {
    const url = (await git(['remote', 'get-url', 'origin'])).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
    if (!m) throw new Error(`cannot parse owner/repo from origin remote: ${url}`);
    return { owner: m[1], repo: m[2] };
  }

  return { listDocs, resolveVersionSha, readDoc, recentVersions, repoSlug };
}

module.exports = { createDocSource };
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/doc-source.test.js -i`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/docSource.js tests/doc-source.test.js
git commit -m "feat(docs): local git doc source with path-safety and version resolution"
```

---

### Task 4: `ghComments` — commit-comments client

**Files:**
- Create: `src/services/ghComments.js`
- Test: `tests/gh-comments.test.js`

**Interfaces:**
- Consumes: `ghCommentCodec` (Task 2).
- Produces:
  - `resolveToken()` → `string` (env → `gh auth token`; throws a clear error if none).
  - `createGhComments({ owner, repo, token, fetchImpl? })` → object:
    - `list(sha, docPath)` → `Promise<Array<Comment>>` filtered to `docPath`.
    - `post(sha, { path, line, text, kind, anchor, tag?, replyTo? })` → `Promise<Comment>`.
    - `del(id)` → `Promise<void>`.
  - `Comment` = `{ id, author, createdAt, htmlUrl, text, kind, path, line, anchor, tag, replyTo, hasMeta }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/gh-comments.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/gh-comments.test.js -i`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```js
// src/services/ghComments.js
// GitHub commit-comments client. GitHub is the single store for docs
// annotations; this module reads/writes them. Line/path/anchor live inside the
// comment body (see ghCommentCodec) because commit-comment positions are
// diff-relative and cannot address arbitrary file lines — ProtoLab re-anchors
// from the body. Uses global fetch (no new dependency).
const { execFileSync } = require('child_process');
const codec = require('./ghCommentCodec');

const API = 'https://api.github.com';

function resolveToken({ env = process.env, exec = execFileSync } = {}) {
  const t = env.DOCS_GITHUB_TOKEN || env.GITHUB_TOKEN;
  if (t) return t;
  try {
    const out = String(exec('gh', ['auth', 'token'], { encoding: 'utf8' })).trim();
    if (out) return out;
  } catch { /* gh not installed or not logged in */ }
  throw new Error('No GitHub token. Set DOCS_GITHUB_TOKEN (or GITHUB_TOKEN), or run `gh auth login`.');
}

function createGhComments({ owner, repo, token, fetchImpl = fetch }) {
  async function gh(method, path, bodyObj) {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'protoshare-docs',
        'Content-Type': 'application/json',
      },
      body: bodyObj ? JSON.stringify(bodyObj) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path} -> ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  function toComment(gc) {
    const parsed = codec.parseBody(gc.body);
    return {
      id: gc.id,
      author: gc.user ? gc.user.login : null,
      createdAt: gc.created_at,
      htmlUrl: gc.html_url,
      path: parsed.path || gc.path || null,
      line: parsed.line,
      text: parsed.text,
      kind: parsed.kind,
      anchor: parsed.anchor,
      tag: parsed.tag,
      replyTo: parsed.replyTo,
      hasMeta: parsed.hasMeta,
    };
  }

  async function list(sha, docPath) {
    const raw = await gh('GET', `/repos/${owner}/${repo}/commits/${sha}/comments?per_page=100`);
    return (raw || []).map(toComment).filter((c) => c.path === docPath);
  }

  async function post(sha, { path, line, text, kind, anchor, tag = null, replyTo = null }) {
    const body = codec.encodeBody({ text, kind, path, line, anchor, tag, replyTo });
    const gc = await gh('POST', `/repos/${owner}/${repo}/commits/${sha}/comments`, { body });
    return toComment(gc);
  }

  async function del(id) {
    await gh('DELETE', `/repos/${owner}/${repo}/comments/${id}`);
  }

  return { list, post, del };
}

module.exports = { resolveToken, createGhComments };
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/gh-comments.test.js -i`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/ghComments.js tests/gh-comments.test.js
git commit -m "feat(docs): github commit-comments client (list/post/delete)"
```

---

### Task 5: Config + opt-in server mount

**Files:**
- Modify: `src/config.js` (add `docsRepoPath`)
- Modify: `src/server.js` (mount `/docs` only when configured)
- Test: `tests/docs-mount.test.js`

**Interfaces:**
- Consumes: `createDocsRouter` (Task 6) — mounted here.
- Produces: `config.docsRepoPath` (`string`); `/docs/*` reachable only when `DOCS_REPO_PATH` is set.

> Depends on Task 6's `createDocsRouter`; implement Task 6 first or stub the mount, then wire. The commit for this task comes after Task 6 exists.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails or passes trivially**

Run: `npx jest tests/docs-mount.test.js -i`
Expected: initially PASS only by accident (no /docs yet). After Task 6 wiring, this guards the opt-in. Keep it.

- [ ] **Step 3: Implement config**

In `src/config.js`, add to the exported object (next to `uploadsPath`):

```js
  docsRepoPath: process.env.DOCS_REPO_PATH || '',
```

- [ ] **Step 4: Implement the mount**

In `src/server.js`, after the other routers are mounted, add:

```js
// Docs review workflow (opt-in, local-first). Mounts only when a local clone
// path is configured, so the hosted app is unaffected when it is absent.
if (config.docsRepoPath) {
  const { createDocsRouter } = require('./routes/docs');
  app.use('/docs', createDocsRouter());
}
```

- [ ] **Step 5: Run tests**

Run: `npx jest tests/docs-mount.test.js -i`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config.js src/server.js tests/docs-mount.test.js
git commit -m "feat(docs): opt-in /docs mount gated on DOCS_REPO_PATH"
```

---

### Task 6: `/docs` routes

**Files:**
- Create: `src/routes/docs.js`
- Create: `src/views/docs-shell.html`
- Test: `tests/docs-routes.test.js`

**Interfaces:**
- Consumes: `docSource` (Task 3), `ghComments` (Task 4), `markdown` (Task 1).
- Produces: `createDocsRouter(deps?)` → Express router. `deps` (for tests) = `{ docSource, ghComments, markdown, readView }`; when omitted, builds real deps from `config` (clone path, token, repo slug).
  - `GET /docs` → shell with the flat doc list as JSON.
  - `GET /docs/view?path=&sha=` → rendered doc (sourceLines) + injected SDK data attrs.
  - `GET /docs/comments?path=&sha=` → `ghComments.list` JSON.
  - `POST /docs/comments` `{ path, sha, line, kind, text, anchor, tag?, replyTo? }` → `ghComments.post`.
  - `DELETE /docs/comments/:id` → 204.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/docs-routes.test.js -i`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the view**

Create `src/views/docs-shell.html` (3-pane; the SDK renders tree + sidebar from `#docs-cfg`):

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Docs — ProtoLab (Beta!)</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;color:hsl(222,47%,11%)}
.docs{display:grid;grid-template-columns:260px 1fr 320px;height:100vh}
.docs__tree{border-right:1px solid hsl(220,13%,91%);overflow:auto;padding:12px}
.docs__doc{overflow:auto;padding:32px 48px;max-width:860px;margin:0 auto;width:100%}
.docs__side{border-left:1px solid hsl(220,13%,91%);overflow:auto;padding:12px}
.docs__banner{background:hsl(42,96%,89%);padding:8px 12px;font-size:13px}
mark{background:hsl(48,96%,76%)}
</style>
</head>
<body>
<div class="docs">
  <nav class="docs__tree" id="docs-tree"></nav>
  <main class="docs__doc">{{banner}}{{content}}</main>
  <aside class="docs__side" id="docs-side"></aside>
</div>
<script id="docs-cfg" type="application/json">{{cfg}}</script>
<script type="module" src="/sdk/docs.js"></script>
</body>
</html>
```

- [ ] **Step 4: Implement the router**

```js
// src/routes/docs.js
// Thin HTTP layer translating between the docs SDK and the git/GitHub services.
// Holds no state. deps are injectable for tests; omitted => built from config.
const fs = require('fs');
const path = require('path');
const express = require('express');

function defaultReadView(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'views', name), 'utf8');
}

function buildRealDeps() {
  const config = require('../config');
  const markdown = require('../services/markdown');
  const { createDocSource } = require('../services/docSource');
  const { createGhComments, resolveToken } = require('../services/ghComments');
  const docSource = createDocSource(config.docsRepoPath);
  let client = null;
  // Async factory: build the GitHub client once, lazily (needs repoSlug + token).
  const ghComments = async () => {
    if (!client) {
      const { owner, repo } = await docSource.repoSlug();
      client = createGhComments({ owner, repo, token: resolveToken() });
    }
    return client;
  };
  return { docSource, ghComments, markdown, readView: defaultReadView };
}

function createDocsRouter(deps) {
  const router = express.Router();
  const resolved = deps || buildRealDeps();
  const { docSource, markdown, readView = defaultReadView } = resolved;
  // ghComments is an async factory in real wiring, or a ready object in tests.
  const resolveGh = typeof resolved.ghComments === 'function'
    ? resolved.ghComments
    : async () => resolved.ghComments;

  router.get('/', async (_req, res, next) => {
    try {
      const docs = await docSource.listDocs();
      const html = readView('docs-shell.html')
        .split('{{banner}}').join('')
        .split('{{content}}').join('')
        .split('{{cfg}}').join(JSON.stringify({ mode: 'list', docs }).replace(/</g, '\\u003c'));
      res.send(html);
    } catch (e) { next(e); }
  });

  router.get('/view', async (req, res, next) => {
    try {
      const { raw, versionSha, dirty } = await docSource.readDoc(req.query.path, req.query.sha || undefined);
      const { html } = markdown.render(raw, { sourceLines: true });
      const banner = dirty
        ? `<div class="docs__banner">Uncommitted local changes are hidden; comments attach to ${versionSha ? versionSha.slice(0, 7) : 'this file once committed'}.</div>`
        : '';
      const versions = await docSource.recentVersions(req.query.path).catch(() => []);
      const cfg = { mode: 'view', path: req.query.path, sha: versionSha, commentable: !!versionSha, versions };
      const out = readView('docs-shell.html')
        .split('{{banner}}').join(banner)
        .split('{{content}}').join(html)
        .split('{{cfg}}').join(JSON.stringify(cfg).replace(/</g, '\\u003c'));
      res.send(out);
    } catch (e) { next(e); }
  });

  router.get('/comments', async (req, res, next) => {
    try {
      const client = await resolveGh();
      res.json(await client.list(req.query.sha, req.query.path));
    } catch (e) { next(e); }
  });

  router.post('/comments', async (req, res, next) => {
    try {
      const { path: p, sha, line, kind, text, anchor, tag, replyTo } = req.body;
      const doc = await docSource.readDoc(p, sha || undefined);
      if (!doc.versionSha) return res.status(409).json({ error: 'Commit this file before annotating.' });
      const client = await resolveGh();
      const created = await client.post(doc.versionSha, { path: p, line, kind, text, anchor, tag, replyTo });
      res.status(201).json(created);
    } catch (e) { next(e); }
  });

  router.delete('/comments/:id', async (req, res, next) => {
    try {
      const client = await resolveGh();
      await client.del(req.params.id);
      res.status(204).end();
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = { createDocsRouter };
```

- [ ] **Step 5: Run tests**

Run: `npx jest tests/docs-routes.test.js -i`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/routes/docs.js src/views/docs-shell.html tests/docs-routes.test.js
git commit -m "feat(docs): /docs routes (tree, view, comments CRUD)"
```

---

### Task 7: Docs SDK (tree + rendered-view annotation)

**Files:**
- Create: `public/sdk/docs.js`
- Test: `tests/docs-sdk.test.js`

**Interfaces:**
- Consumes: `/docs/*` endpoints (Task 6); reuses `/sdk/anchor.js` (`FBAnchor.serializeSelection`, `wrapRange`) when present in the browser.
- Produces (pure, exported for test):
  - `nearestSourceLine(node)` → `number|null` (walk ancestors for `data-source-line`).
  - `buildTree(docs)` → nested `{ name, path?, title?, children? }` from flat `[{path,title}]`.
  - `commentPayload({ path, sha, line, kind, text, anchor })` → the POST body object.

- [ ] **Step 1: Write the failing test**

```js
// tests/docs-sdk.test.js
const { nearestSourceLine, buildTree, commentPayload } = require('../public/sdk/docs.js');

test('nearestSourceLine walks up to the annotated block', () => {
  const block = { getAttribute: (a) => (a === 'data-source-line' ? '5' : null), parentElement: null };
  const leaf = { getAttribute: () => null, parentElement: block };
  expect(nearestSourceLine(leaf)).toBe(5);
  expect(nearestSourceLine({ getAttribute: () => null, parentElement: null })).toBeNull();
});

test('buildTree nests by directory', () => {
  const tree = buildTree([{ path: 'guide/intro.md', title: 'Intro' }, { path: 'readme-ish/a.md', title: 'A' }]);
  const guide = tree.children.find((n) => n.name === 'guide');
  expect(guide.children[0]).toMatchObject({ name: 'intro.md', path: 'guide/intro.md', title: 'Intro' });
});

test('commentPayload shapes the POST body', () => {
  const p = commentPayload({ path: 'a.md', sha: 's', line: 3, kind: 'question', text: 'q', anchor: { quote: 'x' } });
  expect(p).toEqual({ path: 'a.md', sha: 's', line: 3, kind: 'question', text: 'q', anchor: { quote: 'x' }, tag: null, replyTo: null });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/docs-sdk.test.js -i`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `public/sdk/docs.js`. Export the pure helpers for Node tests; guard all DOM/`fetch` work behind a `typeof document` check so `require()` in tests is side-effect-free (mirrors `public/sdk/anchor.js`).

```js
// public/sdk/docs.js
// Docs-mode review client: renders the folder tree + annotation sidebar and
// turns a rendered-text selection into a GitHub commit comment. Reuses
// FBAnchor (anchor.js) for durable text anchoring; the raw line for GitHub
// comes from the nearest [data-source-line] block injected by the renderer.

function nearestSourceLine(node) {
  let el = node;
  while (el) {
    const v = el.getAttribute && el.getAttribute('data-source-line');
    if (v != null) return parseInt(v, 10);
    el = el.parentElement;
  }
  return null;
}

function buildTree(docs) {
  const root = { name: '', children: [] };
  for (const doc of docs) {
    const parts = doc.path.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = isFile ? { name: part, path: doc.path, title: doc.title } : { name: part, children: [] };
        node.children.push(child);
      }
      if (!isFile) node = child;
    });
  }
  return root;
}

function commentPayload({ path, sha, line, kind, text, anchor, tag = null, replyTo = null }) {
  return { path, sha, line, kind, text, anchor, tag, replyTo };
}

// ---- DOM/runtime wiring (browser only) ----
if (typeof document !== 'undefined') {
  const cfgEl = document.getElementById('docs-cfg');
  const cfg = cfgEl ? JSON.parse(cfgEl.textContent) : { mode: 'list', docs: [] };

  async function renderList() {
    const tree = buildTree(cfg.docs);
    const host = document.getElementById('docs-tree');
    const render = (node, depth) => node.children.map((c) => c.path
      ? `<div style="padding-left:${depth * 12}px"><a href="/docs/view?path=${encodeURIComponent(c.path)}">${c.title || c.name}</a></div>`
      : `<div style="padding-left:${depth * 12}px"><b>${c.name}/</b></div>${render(c, depth + 1)}`).join('');
    if (host) host.innerHTML = render(tree, 0);
  }

  async function loadComments() {
    const res = await fetch(`/docs/comments?path=${encodeURIComponent(cfg.path)}&sha=${encodeURIComponent(cfg.sha)}`);
    const comments = await res.json();
    const side = document.getElementById('docs-side');
    if (side) side.innerHTML = comments.map((c) =>
      `<div class="docs__comment" data-id="${c.id}"><b>${c.kind}</b> — ${c.author || ''}<br>${c.text}</div>`).join('');
    // Re-highlight each anchored comment with FBAnchor if available.
    if (window.FBAnchor) {
      for (const c of comments) {
        if (c.anchor) { try { window.FBAnchor.wrapRange(document.querySelector('.docs__doc'), c.anchor); } catch { /* drifted */ } }
      }
    }
  }

  async function onSelect() {
    if (!cfg.commentable) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const anchor = window.FBAnchor ? window.FBAnchor.serializeSelection(document.querySelector('.docs__doc'), sel) : null;
    const line = nearestSourceLine(sel.anchorNode && sel.anchorNode.parentElement);
    const kind = window.prompt('Kind: question / change-request / delete / note', 'question') || 'note';
    const text = window.prompt('Your comment:');
    if (!text) return;
    const res = await fetch('/docs/comments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(commentPayload({ path: cfg.path, sha: cfg.sha, line, kind, text, anchor })),
    });
    if (res.ok) loadComments();
    else window.alert('Could not post to GitHub — your draft is kept. ' + res.status);
  }

  if (cfg.mode === 'list') renderList();
  else {
    loadComments();
    document.querySelector('.docs__doc').addEventListener('mouseup', onSelect);
  }
}

if (typeof module !== 'undefined') module.exports = { nearestSourceLine, buildTree, commentPayload };
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/docs-sdk.test.js -i`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full suite + lint**

Run: `npm test && npm run lint`
Expected: all suites green; lint 0 errors.

- [ ] **Step 6: Commit**

```bash
git add public/sdk/docs.js tests/docs-sdk.test.js
git commit -m "feat(docs): docs-mode review SDK (tree, rendered-view annotation)"
```

---

### Task 8: SSE live-reload on local file change

**Files:**
- Create: `src/services/reloadHub.js`
- Modify: `src/routes/docs.js` (SSE endpoint + `fs.watch` → hub)
- Modify: `public/sdk/docs.js` (subscribe + reload)
- Test: `tests/reload-hub.test.js`

**Interfaces:**
- Produces: `createReloadHub()` → `{ subscribe(fn)->unsub, broadcast(msg='reload'), size() }`; `GET /docs/__events` → `text/event-stream` emitting `reload` when a watched `.md` changes.

- [ ] **Step 1: Write the failing test**

```js
// tests/reload-hub.test.js
const { createReloadHub } = require('../src/services/reloadHub');

test('broadcast reaches current subscribers; unsubscribe stops delivery', () => {
  const hub = createReloadHub();
  const a = []; const b = [];
  const unsubA = hub.subscribe((m) => a.push(m));
  hub.subscribe((m) => b.push(m));
  hub.broadcast();
  expect(a).toEqual(['reload']);
  expect(b).toEqual(['reload']);
  unsubA();
  hub.broadcast('again');
  expect(a).toEqual(['reload']);
  expect(b).toEqual(['reload', 'again']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/reload-hub.test.js -i`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the hub**

```js
// src/services/reloadHub.js
// Tiny fan-out registry for SSE live-reload. Pure and framework-free so it is
// trivially testable; the route wires fs.watch into broadcast().
function createReloadHub() {
  const subs = new Set();
  return {
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    broadcast(msg = 'reload') {
      for (const fn of subs) { try { fn(msg); } catch { subs.delete(fn); } }
    },
    size() { return subs.size; },
  };
}
module.exports = { createReloadHub };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/reload-hub.test.js -i`
Expected: PASS.

- [ ] **Step 5: Wire the endpoint and client**

In `src/routes/docs.js`, add the require at the top:

```js
const { createReloadHub } = require('../services/reloadHub');
```

In `buildRealDeps()`'s return, add `watchRoot: config.docsRepoPath`. Then inside `createDocsRouter`, after `const resolveGh = …`, add:

```js
  const hub = createReloadHub();
  if (resolved.watchRoot) {
    try {
      require('fs').watch(resolved.watchRoot, { recursive: true }, (_e, name) => {
        if (!name || name.endsWith('.md')) hub.broadcast();
      });
    } catch { /* recursive watch unsupported on this platform; skip live-reload */ }
  }

  router.get('/__events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    if (res.flushHeaders) res.flushHeaders();
    const unsub = hub.subscribe((msg) => res.write(`data: ${msg}\n\n`));
    req.on('close', unsub);
  });
```

In `public/sdk/docs.js`, inside the `else` branch of the `cfg.mode` wiring (view mode), after `loadComments()`:

```js
    try { new EventSource('/docs/__events').onmessage = () => location.reload(); } catch { /* no SSE */ }
```

- [ ] **Step 6: Run the full suite + lint, then commit**

Run: `npm test && npm run lint`
Expected: all suites green; lint 0 errors.

```bash
git add src/services/reloadHub.js src/routes/docs.js public/sdk/docs.js tests/reload-hub.test.js
git commit -m "feat(docs): SSE live-reload on local .md changes"
```

> Live-reload (fs.watch → SSE → `location.reload`) is verified in the manual check below; the automated test covers the fan-out hub, the one piece with non-trivial logic.

---

## Manual verification (after all tasks)

With a local clone and a token:

```bash
export DOCS_REPO_PATH=/absolute/path/to/a/cloned/docs-repo
export DOCS_GITHUB_TOKEN=$(gh auth token)
npm start
# open http://localhost:1337/docs  → tree → open a doc → select text → comment
# confirm the comment appears on the commit in GitHub, and reopening the doc re-highlights it
```
