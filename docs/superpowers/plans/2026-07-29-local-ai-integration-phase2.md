# Local-AI Integration — Phase 2 (MCP server + manifest) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a local stdio MCP server (in `mcp/`) plus a tracked `.protoshare.json` manifest so the developer's Claude Code can pull feedback, pull source, push drafts, publish, and check status through native tools instead of curl — every rule still enforced by the Phase 1 REST layer.

**Architecture:** The MCP server is a **thin client** — no business logic; it only translates tool calls into `/api/v1` HTTP requests and formats responses. The MCP SDK is ESM, so the entry point `mcp/server.mjs` is ESM, but all testable logic (manifest read/write, HTTP client, tool handlers) lives in CommonJS modules under `mcp/lib/*.cjs` that the existing root Jest suite can `require()` directly. The MCP package has its **own `package.json`** (like the sibling `meetassist-mcp` project) so its heavy dependency tree never ships to the deployed app. The manifest maps local HTML file → prototype id and records last-pulled/last-pushed version numbers (the `baseVersion` source for conflict detection); the token lives only in `.env`.

**Tech Stack:** Node 26 (global `fetch`/`FormData`/`Blob` from undici), `@modelcontextprotocol/sdk` (ESM), `zod` for tool input schemas, root Jest 30 + supertest for the CJS logic tests.

---

## File Structure

```
mcp/
  package.json          # NEW — type:module, name "protoshare-mcp", deps: SDK + zod. Isolated from root.
  server.mjs            # NEW — ESM entry. Wires 6 tools → handlers. Thin; not unit-tested.
  lib/
    manifest.cjs        # NEW — load/save .protoshare.json; resolve file→id; bump lastPulled/lastPushed.
    client.cjs          # NEW — ProtoshareClient: base URL (arg) + token (arg); fetch wrappers per endpoint.
    handlers.cjs        # NEW — 6 pure handler fns (list/pull/source/push/publish/status) → { text }.
  README.md             # NEW — install + Claude Code registration instructions.
.protoshare.example.json # NEW (tracked) — documented template the developer copies into THEIR prototype repo.
.env.example            # MODIFY — already documents PROTOSHARE_TOKEN; add PROTOSHARE_MANIFEST note.
tests/
  mcp-manifest.test.js  # NEW — CJS, requires ../mcp/lib/manifest.cjs. tmp-file round-trips, resolve, bumps.
  mcp-client.test.js    # NEW — CJS, requires ../mcp/lib/client.cjs. Correct URL/method/headers/body per call.
  mcp-handlers.test.js  # NEW — CJS, requires ../mcp/lib/handlers.cjs with a fake client + tmp manifest.
```

**Why `.protoshare.json` is not committed to THIS repo:** the manifest belongs in the *prototype* repo where the developer runs Claude Code, not in proto-share itself. Committing a stub with placeholder ids would be misleading. We ship `.protoshare.example.json` as the documented template instead. The server resolves the manifest path from `PROTOSHARE_MANIFEST` (absolute path) or `./.protoshare.json` relative to `cwd`.

**Module-format contract (critical, verified against SDK 1.30.0):**
- Root `package.json` is `"type": "commonjs"` → any `.cjs` file is unambiguously CJS regardless of location. The root Jest suite `require('../mcp/lib/*.cjs')` works with zero transform.
- `mcp/package.json` is `"type": "module"` → `server.mjs` is ESM and can `import { McpServer }` from the SDK. It imports the CJS libs via default import: `import manifestLib from './lib/manifest.cjs'` (Node ESM↔CJS interop exposes `module.exports` as the default export).

---

## Task 1: Scaffold the isolated MCP package

**Files:**
- Create: `mcp/package.json`
- Create: `mcp/.gitignore`

- [ ] **Step 1: Write `mcp/package.json`**

```json
{
  "name": "protoshare-mcp",
  "version": "1.0.0",
  "description": "Local stdio MCP server for the proto-share local-AI integration. Thin client over the deployed /api/v1 REST surface.",
  "type": "module",
  "private": true,
  "bin": { "protoshare-mcp": "server.mjs" },
  "scripts": {
    "start": "node server.mjs"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "zod": "^3.25.0"
  }
}
```

- [ ] **Step 2: Write `mcp/.gitignore`**

```
node_modules/
```

- [ ] **Step 3: Install the MCP package deps (verifies the manifest is valid)**

Run: `cd mcp && npm install && cd ..`
Expected: `node_modules/` created under `mcp/`, `@modelcontextprotocol/sdk` and `zod` resolved, no errors. (`mcp/package-lock.json` is created — commit it.)

- [ ] **Step 4: Commit**

```bash
git add mcp/package.json mcp/.gitignore mcp/package-lock.json
git commit -m "feat(mcp): scaffold isolated protoshare-mcp package (ESM, own deps)"
```

---

## Task 2: Manifest module (`mcp/lib/manifest.cjs`)

**Files:**
- Create: `mcp/lib/manifest.cjs`
- Test: `tests/mcp-manifest.test.js`

The manifest shape (from the design spec §4):

```jsonc
{
  "remote": "https://protolab.up.railway.app",
  "prototypes": {
    "checkout.html": { "id": "aB3x…", "lastPulled": 2, "lastPushed": 3 }
  }
}
```

- [ ] **Step 1: Write the failing test**

```javascript
// tests/mcp-manifest.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const manifest = require('../mcp/lib/manifest.cjs');

function tmpManifest(contents) {
  const p = path.join(os.tmpdir(), `mani-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  if (contents !== undefined) fs.writeFileSync(p, contents);
  return p;
}

test('load returns parsed manifest with defaults for missing prototypes map', () => {
  const p = tmpManifest(JSON.stringify({ remote: 'https://x.example.com' }));
  const m = manifest.load(p);
  expect(m.remote).toBe('https://x.example.com');
  expect(m.prototypes).toEqual({});
});

test('load throws a clear error when the file is missing', () => {
  const p = tmpManifest(undefined);
  expect(() => manifest.load(p)).toThrow(/manifest not found/i);
});

test('load throws a clear error when remote is absent', () => {
  const p = tmpManifest(JSON.stringify({ prototypes: {} }));
  expect(() => manifest.load(p)).toThrow(/remote/i);
});

test('resolveId returns the id for a known file key', () => {
  const m = { remote: 'r', prototypes: { 'a.html': { id: 'ID_A' } } };
  expect(manifest.resolveId(m, 'a.html')).toBe('ID_A');
});

test('resolveId returns the input unchanged when it is not a known file (treated as an id)', () => {
  const m = { remote: 'r', prototypes: { 'a.html': { id: 'ID_A' } } };
  expect(manifest.resolveId(m, 'ID_A')).toBe('ID_A');
  expect(manifest.resolveId(m, 'unknown-id')).toBe('unknown-id');
});

test('baseVersion returns max(lastPulled,lastPushed) for a file, or undefined when unknown', () => {
  const m = { remote: 'r', prototypes: {
    'a.html': { id: 'ID_A', lastPulled: 2, lastPushed: 3 },
    'b.html': { id: 'ID_B', lastPulled: 5 },
    'c.html': { id: 'ID_C' },
  } };
  expect(manifest.baseVersion(m, 'a.html')).toBe(3);
  expect(manifest.baseVersion(m, 'b.html')).toBe(5);
  expect(manifest.baseVersion(m, 'c.html')).toBeUndefined();
  expect(manifest.baseVersion(m, 'ID_A')).toBe(3); // resolves via id too
});

test('recordPull/recordPush persist version numbers to disk keyed by file', () => {
  const p = tmpManifest(JSON.stringify({ remote: 'r', prototypes: { 'a.html': { id: 'ID_A' } } }));
  let m = manifest.load(p);
  manifest.recordPull(m, 'a.html', 2, p);
  manifest.recordPush(m, 'a.html', 3, p);
  const reloaded = manifest.load(p);
  expect(reloaded.prototypes['a.html'].lastPulled).toBe(2);
  expect(reloaded.prototypes['a.html'].lastPushed).toBe(3);
});

test('recordPull is a no-op-safe when the target is an id not present as a file key', () => {
  const p = tmpManifest(JSON.stringify({ remote: 'r', prototypes: { 'a.html': { id: 'ID_A' } } }));
  const m = manifest.load(p);
  // Passing the id (not the file) should still update the a.html entry via reverse lookup.
  manifest.recordPull(m, 'ID_A', 7, p);
  expect(manifest.load(p).prototypes['a.html'].lastPulled).toBe(7);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/mcp-manifest.test.js`
Expected: FAIL — `Cannot find module '../mcp/lib/manifest.cjs'`.

- [ ] **Step 3: Write the implementation**

```javascript
// mcp/lib/manifest.cjs
// Reads and writes the local .protoshare.json manifest that maps a local HTML
// file to its deployed prototype id and records the last-pulled / last-pushed
// version numbers (the baseVersion source for conflict detection). The token is
// NEVER stored here — it lives in the environment. This module is pure I/O over
// the manifest file; it holds no network or business logic.
const fs = require('fs');

// Load and validate the manifest at `filePath`. Throws with a clear, actionable
// message on missing file / bad JSON / missing remote. Guarantees a
// `.prototypes` object so callers never need to null-check it.
function load(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(`Manifest not found at ${filePath}. Copy .protoshare.example.json to .protoshare.json in your prototype repo and set PROTOSHARE_MANIFEST if it lives elsewhere.`);
    }
    throw e;
  }
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    throw new Error(`Manifest at ${filePath} is not valid JSON.`);
  }
  if (!m || typeof m.remote !== 'string' || !m.remote) {
    throw new Error(`Manifest at ${filePath} must have a non-empty "remote" URL.`);
  }
  if (!m.prototypes || typeof m.prototypes !== 'object') m.prototypes = {};
  return m;
}

// Find the file-key whose entry matches `fileOrId` either by key or by .id.
// Returns the file key, or null if it only matches as a bare id / not at all.
function fileKeyFor(m, fileOrId) {
  if (m.prototypes[fileOrId]) return fileOrId; // direct file-key hit
  for (const [file, entry] of Object.entries(m.prototypes)) {
    if (entry && entry.id === fileOrId) return file;
  }
  return null;
}

// Resolve a file-key OR a raw id to a prototype id. A known file → its id; an
// unknown value is assumed to already BE an id and returned unchanged.
function resolveId(m, fileOrId) {
  const key = fileKeyFor(m, fileOrId);
  if (key) return m.prototypes[key].id;
  return fileOrId;
}

// The version a local edit was based on = the highest version we've seen for
// this file (max of lastPulled/lastPushed). undefined when we've never synced,
// which tells the caller to omit baseVersion (server skips the conflict check).
function baseVersion(m, fileOrId) {
  const key = fileKeyFor(m, fileOrId);
  if (!key) return undefined;
  const e = m.prototypes[key];
  const vals = [e.lastPulled, e.lastPushed].filter(v => typeof v === 'number');
  return vals.length ? Math.max(...vals) : undefined;
}

function save(m, filePath) {
  fs.writeFileSync(filePath, JSON.stringify(m, null, 2) + '\n');
}

function ensureEntry(m, fileOrId) {
  const key = fileKeyFor(m, fileOrId);
  if (key) return key;
  // Not a known file or id: create a bare entry keyed by the given value,
  // storing it as the id (best effort — lets status/record work pre-first-pull).
  m.prototypes[fileOrId] = { id: fileOrId };
  return fileOrId;
}

function recordPull(m, fileOrId, version, filePath) {
  const key = ensureEntry(m, fileOrId);
  m.prototypes[key].lastPulled = version;
  save(m, filePath);
}

function recordPush(m, fileOrId, version, filePath) {
  const key = ensureEntry(m, fileOrId);
  m.prototypes[key].lastPushed = version;
  save(m, filePath);
}

module.exports = { load, save, resolveId, fileKeyFor, baseVersion, recordPull, recordPush };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/mcp-manifest.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp/lib/manifest.cjs tests/mcp-manifest.test.js
git commit -m "feat(mcp): add manifest module (load/resolve/baseVersion/record)"
```

---

## Task 3: HTTP client module (`mcp/lib/client.cjs`)

**Files:**
- Create: `mcp/lib/client.cjs`
- Test: `tests/mcp-client.test.js`

The client takes `{ baseUrl, token, fetchImpl }` so tests inject a fake `fetch`. It maps each method to exactly one `/api/v1` call with the right method, URL, `Authorization` header, and body. On non-2xx it throws an `Error` carrying `.status` and `.body` so handlers can format 409/404/401 clearly.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/mcp-client.test.js
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

test('constructor throws when token is missing', () => {
  expect(() => new ProtoshareClient({ baseUrl: 'x', token: '' })).toThrow(/token/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/mcp-client.test.js`
Expected: FAIL — `Cannot find module '../mcp/lib/client.cjs'`.

- [ ] **Step 3: Write the implementation**

```javascript
// mcp/lib/client.cjs
// Thin HTTP wrapper over the deployed /api/v1 surface. One method per endpoint;
// no business logic. Auth is a static bearer token. fetch/FormData/Blob are
// Node globals (>=18); fetchImpl is injectable for tests. Non-2xx responses
// throw an Error carrying .status and the parsed .body so callers format them.
class ProtoshareClient {
  constructor({ baseUrl, token, fetchImpl } = {}) {
    if (!token) throw new Error('A PROTOSHARE_TOKEN is required to talk to the remote.');
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, ''); // trim trailing slash
    this.token = token;
    this.fetch = fetchImpl || globalThis.fetch;
  }

  get _authHeader() { return { Authorization: `Bearer ${this.token}` }; }

  async _request(path, { method = 'GET', headers = {}, body } = {}) {
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { ...this._authHeader, ...headers },
      body,
    });
    if (res.ok === false || (res.status && res.status >= 400)) {
      let parsed = null;
      try { parsed = await res.json(); } catch { /* non-JSON error body */ }
      const err = new Error(`Request ${method} ${path} failed with ${res.status}`);
      err.status = res.status;
      err.body = parsed;
      throw err;
    }
    return res;
  }

  async list() {
    return (await this._request('/api/v1/prototypes')).json();
  }

  async feedback(id) {
    return (await this._request(`/api/v1/prototypes/${id}/feedback`)).json();
  }

  async source(id, version) {
    const q = version != null ? `?version=${encodeURIComponent(version)}` : '';
    return (await this._request(`/api/v1/prototypes/${id}/source${q}`)).text();
  }

  async versions(id) {
    return (await this._request(`/api/v1/prototypes/${id}/versions`)).json();
  }

  async pushVersion(id, { buffer, filename, note, baseVersion } = {}) {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'text/html' }), filename || 'prototype.html');
    if (note != null && note !== '') form.append('note', String(note));
    if (baseVersion != null) form.append('baseVersion', String(baseVersion));
    // NB: do NOT set Content-Type — fetch derives the multipart boundary from FormData.
    return (await this._request(`/api/v1/prototypes/${id}/versions`, { method: 'POST', body: form })).json();
  }

  async publish(id, version) {
    const payload = version != null ? { version } : {};
    return (await this._request(`/api/v1/prototypes/${id}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })).json();
  }
}

module.exports = { ProtoshareClient };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/mcp-client.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp/lib/client.cjs tests/mcp-client.test.js
git commit -m "feat(mcp): add HTTP client wrapping the /api/v1 surface"
```

---

## Task 4: Tool handlers (`mcp/lib/handlers.cjs`)

**Files:**
- Create: `mcp/lib/handlers.cjs`
- Test: `tests/mcp-handlers.test.js`

Handlers are the glue: resolve `file_or_id` via the manifest, call the client, format a concise human-readable text result, and bump the manifest after pull/push. Each handler is `async (ctx, args) => string` where `ctx = { client, manifest, manifestPath, readFile, writeFile }`. `readFile`/`writeFile` are injected so `pull`/`source`/`push` file I/O is testable without touching the real disk.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/mcp-handlers.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/mcp-handlers.test.js`
Expected: FAIL — `Cannot find module '../mcp/lib/handlers.cjs'`.

- [ ] **Step 3: Write the implementation**

```javascript
// mcp/lib/handlers.cjs
// The six MCP tool handlers. Each is async (ctx, args) => string, where the
// string is the human-readable tool result. ctx bundles the injected client,
// the loaded manifest, its path, and file/manifest I/O (injected so the file
// side is testable). No network or storage rules live here — those are the
// REST layer's job; handlers only resolve file↔id, call the client, format
// output, and keep the manifest's lastPulled/lastPushed in sync.
const manifestLib = require('./manifest.cjs');

// Persist the manifest via the injected saver (tests) or the real writer.
function persist(ctx) {
  if (ctx.saveManifest) return ctx.saveManifest(ctx.manifest);
  return manifestLib.save(ctx.manifest, ctx.manifestPath);
}

async function list(ctx) {
  const items = await ctx.client.list();
  if (!items.length) return 'No prototypes found for this token.';
  return items.map(p => {
    const pub = p.publishedVersion != null ? `published v${p.publishedVersion}` : 'no published version';
    const draft = p.draftVersion != null ? `, draft v${p.draftVersion}` : '';
    return `• ${p.name} [${p.id}] — ${pub}${draft}\n  ${p.shareLink || ''}`;
  }).join('\n');
}

async function pull(ctx, { file_or_id }) {
  const id = manifestLib.resolveId(ctx.manifest, file_or_id);
  const fb = await ctx.client.feedback(id);
  const open = fb.comments.filter(c => !c.resolved);
  const lines = [];
  lines.push(`Feedback for "${fb.prototype.name}" [${fb.prototype.id}] — published v${fb.prototype.publishedVersion ?? '?'}${fb.prototype.draftVersion != null ? `, draft v${fb.prototype.draftVersion}` : ''}`);
  lines.push('');
  lines.push(`Comments (${open.length} open / ${fb.comments.length} total):`);
  if (!fb.comments.length) lines.push('  (none)');
  for (const c of fb.comments) {
    const tag = c.tag ? `[${c.tag}] ` : '';
    const status = c.resolved ? '✓resolved' : 'open';
    const el = c.element ? ` @ ${c.element.selector}` : '';
    lines.push(`  • (${status}, v${c.madeAgainstVersion}) ${tag}${c.comment}${el} — ${c.email}`);
    for (const r of c.replies || []) lines.push(`      ↳ ${r.comment} — ${r.email}`);
  }
  lines.push('');
  lines.push(`Explanations (${fb.explanations.length}):`);
  for (const e of fb.explanations) lines.push(`  • ${e.elementSelector}: ${e.body}`);

  // Record that we've now seen up to the published version.
  if (fb.prototype.publishedVersion != null) {
    manifestLib.recordPull(ctx.manifest, file_or_id, fb.prototype.publishedVersion, ctx.manifestPath);
    if (ctx.saveManifest) ctx.saveManifest(ctx.manifest); // test seam (recordPull already saved on real disk)
  }
  return lines.join('\n');
}

async function source(ctx, { file_or_id, version }) {
  const id = manifestLib.resolveId(ctx.manifest, file_or_id);
  const html = await ctx.client.source(id, version);
  const fileKey = manifestLib.fileKeyFor(ctx.manifest, file_or_id);
  if (fileKey) {
    ctx.writeFile(fileKey, html);
    return `Wrote ${html.length} bytes of ${version ? `v${version}` : 'the published version'} to ${fileKey}.`;
  }
  // No local file mapping — return the HTML inline so the agent still gets it.
  return html;
}

async function push(ctx, { file, note }) {
  const id = manifestLib.resolveId(ctx.manifest, file);
  const base = manifestLib.baseVersion(ctx.manifest, file);
  let buffer;
  try {
    buffer = Buffer.from(ctx.readFile(file));
  } catch (e) {
    if (e.code === 'ENOENT') return `Local file "${file}" not found — nothing to push.`;
    throw e;
  }
  try {
    const res = await ctx.client.pushVersion(id, { buffer, filename: file, note, baseVersion: base });
    manifestLib.recordPush(ctx.manifest, file, res.version, ctx.manifestPath);
    if (ctx.saveManifest) ctx.saveManifest(ctx.manifest);
    return `Pushed ${file} as draft v${res.version}. Publish it with protoshare_publish to make it live.`;
  } catch (e) {
    if (e.status === 409) {
      const cur = e.body && e.body.currentVersion;
      return `Conflict: the remote moved on (current version ${cur}). Pull the latest source with protoshare_source before pushing again.`;
    }
    if (e.status === 404) return `Prototype for "${file}" not found (or not owned by this token).`;
    if (e.status === 401) return `Unauthorized — check PROTOSHARE_TOKEN.`;
    throw e;
  }
}

async function publish(ctx, { file_or_id, version }) {
  const id = manifestLib.resolveId(ctx.manifest, file_or_id);
  try {
    const res = await ctx.client.publish(id, version);
    return `Published v${res.version}. The share link now serves it.`;
  } catch (e) {
    if (e.status === 409) return `Cannot publish: ${e.body && e.body.error ? e.body.error : 'version not found or already published'}.`;
    if (e.status === 404) return `Prototype not found (or not owned by this token).`;
    throw e;
  }
}

async function status(ctx, { file_or_id }) {
  const id = manifestLib.resolveId(ctx.manifest, file_or_id);
  const key = manifestLib.fileKeyFor(ctx.manifest, file_or_id);
  const entry = key ? ctx.manifest.prototypes[key] : {};
  const remote = await ctx.client.versions(id);
  const latest = remote.length ? Math.max(...remote.map(v => v.version)) : null;
  const published = remote.find(v => v.status === 'published');
  return [
    `Status for ${key || id}:`,
    `  Local:  lastPulled v${entry.lastPulled ?? '—'}, lastPushed v${entry.lastPushed ?? '—'}`,
    `  Remote: latest v${latest ?? '—'}${published ? `, published v${published.version}` : ''}`,
  ].join('\n');
}

module.exports = { list, pull, source, push, publish, status };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/mcp-handlers.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp/lib/handlers.cjs tests/mcp-handlers.test.js
git commit -m "feat(mcp): add tool handlers (list/pull/source/push/publish/status)"
```

---

## Task 5: MCP server entry (`mcp/server.mjs`)

**Files:**
- Create: `mcp/server.mjs`

This is the thin ESM wrapper. It reads config from the environment, loads the manifest, builds the client and ctx, and registers six tools whose callbacks delegate to the handlers. No unit test (it is I/O wiring over already-tested units); it is smoke-tested manually in Step 3.

- [ ] **Step 1: Write the implementation**

```javascript
// mcp/server.mjs
// Local stdio MCP server for the proto-share local-AI integration. Thin ESM
// wrapper: it wires six tools to the (CommonJS, unit-tested) handlers. All
// rules live in the deployed /api/v1 REST layer — this process only translates
// tool calls into HTTP requests. Run locally and registered with Claude Code.
//
//   PROTOSHARE_TOKEN     required — the API token from the admin "API Tokens" panel
//   PROTOSHARE_MANIFEST  optional — path to .protoshare.json (default ./.protoshare.json)
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import manifestLib from './lib/manifest.cjs';
import clientLib from './lib/client.cjs';
import handlers from './lib/handlers.cjs';

const { ProtoshareClient } = clientLib;

const manifestPath = path.resolve(process.env.PROTOSHARE_MANIFEST || './.protoshare.json');
const token = process.env.PROTOSHARE_TOKEN;

if (!token) {
  process.stderr.write('Fatal: PROTOSHARE_TOKEN is not set. Generate one in the admin "API Tokens" panel.\n');
  process.exit(1);
}

let manifest;
try {
  manifest = manifestLib.load(manifestPath);
} catch (err) {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
}

const client = new ProtoshareClient({ baseUrl: manifest.remote, token });
const ctx = {
  client,
  manifest,
  manifestPath,
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  writeFile: (p, data) => fs.writeFileSync(p, data),
};

// Wrap a handler so a thrown error becomes an MCP error result rather than
// crashing the server; the message is surfaced to the calling agent.
function tool(fn) {
  return async (args) => {
    try {
      return { content: [{ type: 'text', text: await fn(ctx, args) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  };
}

const server = new McpServer({ name: 'protoshare', version: '1.0.0' });

server.tool('protoshare_list', 'List the prototypes this token can access, with their published/draft versions.',
  {}, tool(handlers.list));

server.tool('protoshare_pull', 'Fetch all feedback (comments, replies, explanations) for a prototype. Accepts a local file name from the manifest or a prototype id.',
  { file_or_id: z.string().describe('Local HTML file (from .protoshare.json) or prototype id') },
  tool(handlers.pull));

server.tool('protoshare_source', 'Download the published (or a specific) version HTML. If the argument is a known local file, it is written to that file.',
  { file_or_id: z.string().describe('Local HTML file or prototype id'),
    version: z.number().int().optional().describe('Specific version number (defaults to published)') },
  tool(handlers.source));

server.tool('protoshare_push', 'Upload the local HTML file as a new DRAFT version (does not affect the live share link). Sends the manifest baseVersion for conflict detection.',
  { file: z.string().describe('Local HTML file to upload (must be a key in .protoshare.json)'),
    note: z.string().optional().describe('Optional note describing the change') },
  tool(handlers.push));

server.tool('protoshare_publish', 'Promote a draft to live. The share link starts serving it. Defaults to the latest draft.',
  { file_or_id: z.string().describe('Local HTML file or prototype id'),
    version: z.number().int().optional().describe('Version to publish (defaults to latest draft)') },
  tool(handlers.publish));

server.tool('protoshare_status', 'Show the local (manifest) vs remote version summary for a prototype.',
  { file_or_id: z.string().describe('Local HTML file or prototype id') },
  tool(handlers.status));

try {
  const transport = new StdioServerTransport();
  await server.connect(transport);
} catch (err) {
  process.stderr.write(`Fatal: failed to start MCP server: ${err}\n`);
  process.exit(1);
}
```

- [ ] **Step 2: Verify the server module loads and registers tools (no live remote needed)**

Create a throwaway check that imports the SDK wiring without connecting stdio. Run:

```bash
cd mcp && PROTOSHARE_TOKEN=dummy.secret PROTOSHARE_MANIFEST=/dev/null node --input-type=module -e "
import fs from 'node:fs';
// /dev/null has no remote → load() should throw the friendly manifest error, proving wiring is reachable.
try { await import('./server.mjs'); } catch (e) { console.log('caught', e.message); }
" 2>&1 | head -5; cd ..
```

Expected: the process exits via the `Fatal:` manifest branch (proving imports resolve and the SDK + zod load). A clean `node -c`-style parse plus the friendly error is success. (Full stdio smoke test happens in Task 7.)

- [ ] **Step 3: Commit**

```bash
git add mcp/server.mjs
git commit -m "feat(mcp): add stdio server entry wiring six tools to handlers"
```

---

## Task 6: Manifest template + docs

**Files:**
- Create: `.protoshare.example.json`
- Create: `mcp/README.md`
- Modify: `.env.example`

- [ ] **Step 1: Write `.protoshare.example.json`**

```json
{
  "remote": "https://your-protolab.up.railway.app",
  "prototypes": {
    "checkout.html": { "id": "PASTE_PROTOTYPE_ID_HERE" }
  }
}
```

- [ ] **Step 2: Write `mcp/README.md`**

````markdown
# protoshare-mcp

A local stdio [MCP](https://modelcontextprotocol.io) server that lets Claude Code
pull feedback from, and push versioned updates to, a deployed proto-share
prototype — without leaving your editor. It is a thin client over the deployed
`/api/v1` REST surface; every rule is enforced server-side.

## Setup

1. **Install deps** (once):
   ```bash
   cd mcp && npm install
   ```
2. **Generate an API token** in the proto-share admin UI → *API Tokens* → *Generate*.
   Copy it (shown once).
3. **Create a manifest** in your prototype repo. Copy `.protoshare.example.json`
   to `.protoshare.json` and fill in `remote` and each prototype `id`
   (from `protoshare_list` or the admin URL). The manifest is safe to commit —
   the token is NOT stored in it.
4. **Register with Claude Code** (in your prototype repo):
   ```bash
   claude mcp add protoshare -- env \
     PROTOSHARE_TOKEN=<your-token> \
     PROTOSHARE_MANIFEST=$PWD/.protoshare.json \
     node /absolute/path/to/proto-share/mcp/server.mjs
   ```

## Tools

| Tool | Purpose |
|------|---------|
| `protoshare_list` | List prototypes this token can access |
| `protoshare_pull` | Fetch comments + replies + explanations |
| `protoshare_source` | Download published/specific HTML (writes to the local file) |
| `protoshare_push` | Upload the local file as a draft |
| `protoshare_publish` | Promote a draft to live |
| `protoshare_status` | Local vs remote version summary |

## Environment

| Var | Required | Default | Meaning |
|-----|----------|---------|---------|
| `PROTOSHARE_TOKEN` | yes | — | API token (`id.secret`) from the admin panel |
| `PROTOSHARE_MANIFEST` | no | `./.protoshare.json` | Path to the manifest |

The `remote` base URL comes from the manifest, not the environment.
````

- [ ] **Step 3: Update `.env.example`** — append a manifest note under the existing `PROTOSHARE_TOKEN` block.

Replace the existing trailing comment block:

```
# Local-AI integration (Phase 2 MCP client uses this; generate it in the admin
# "API Tokens" panel). Server-side needs no new env — tokens live in the DB.
# PROTOSHARE_TOKEN=paste-a-generated-token-here
```

with:

```
# Local-AI integration — the MCP client (mcp/server.mjs) uses these on the
# DEVELOPER'S machine; the deployed server needs neither (tokens live in the DB).
# Generate the token in the admin "API Tokens" panel (shown once).
# PROTOSHARE_TOKEN=paste-a-generated-token-here
# PROTOSHARE_MANIFEST=./.protoshare.json   # path to the manifest (default shown)
```

- [ ] **Step 4: Commit**

```bash
git add .protoshare.example.json mcp/README.md .env.example
git commit -m "docs(mcp): add manifest template, README, and env notes"
```

---

## Task 7: End-to-end smoke test against a live local server

**Files:** none (verification only).

This proves the whole loop works against the real REST layer with a real token — the unit tests mocked the client, so this is the integration seam.

- [ ] **Step 1: Start the app against the local DB in the background**

```bash
DATABASE_URL='postgresql://postgres:postgres@localhost:5433/postgres' PGSSLMODE=disable \
  ADMIN_EMAIL=admin@sap.com ADMIN_PASSWORD_HASH="$(node -e "console.log(require('bcryptjs').hashSync('pw123456',10))")" \
  BASE_URL=http://localhost:3000 node src/server.js &
sleep 2
```

- [ ] **Step 2: Log in, upload a prototype, and generate a token via curl (cookie jar)**

```bash
JAR=$(mktemp)
curl -s -c "$JAR" -b "$JAR" -X POST http://localhost:3000/admin/login \
  --data 'email=admin@sap.com&password=pw123456' -o /dev/null
echo '<html><body>v1</body></html>' > /tmp/smoke.html
PID=$(curl -s -c "$JAR" -b "$JAR" -H 'Accept: application/json' -F name=Smoke -F file=@/tmp/smoke.html \
  http://localhost:3000/admin/prototypes | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).id))')
TOKEN=$(curl -s -c "$JAR" -b "$JAR" -X POST http://localhost:3000/admin/tokens --data 'name=smoke' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).token))')
echo "PID=$PID TOKEN=$TOKEN"
```

- [ ] **Step 3: Write a manifest and drive the handlers through the real client**

```bash
cat > /tmp/smoke-manifest.json <<EOF
{ "remote": "http://localhost:3000", "prototypes": { "smoke.html": { "id": "$PID" } } }
EOF
cd mcp && node --input-type=module -e "
import clientLib from './lib/client.cjs';
import handlers from './lib/handlers.cjs';
import manifestLib from './lib/manifest.cjs';
import fs from 'node:fs';
const manifestPath='/tmp/smoke-manifest.json';
const manifest=manifestLib.load(manifestPath);
const client=new clientLib.ProtoshareClient({baseUrl:manifest.remote,token:process.env.TOKEN});
const ctx={client,manifest,manifestPath,readFile:p=>fs.readFileSync(p,'utf8'),writeFile:(p,d)=>fs.writeFileSync(p,d)};
console.log('--- list ---\n'+await handlers.list(ctx,{}));
console.log('--- pull ---\n'+await handlers.pull(ctx,{file_or_id:'smoke.html'}));
fs.writeFileSync('/tmp/smoke.html','<html><body>v2 edited</body></html>');
process.chdir('/tmp'); // so push reads /tmp/smoke.html? no — read by key. Use absolute:
" TOKEN="$TOKEN" 2>&1 | head -30; cd ..
```

Expected: `list` shows the Smoke prototype with `published v1`; `pull` shows `0 open / 0 total` comments. (Push in Step 4 uses the real file path.)

> **Note for implementer:** the handler reads the file by its manifest key relative to `cwd`. For the smoke test, run node from a directory where `smoke.html` exists, or temporarily key the manifest to an absolute path. Adjust the harness so `push` finds the file; the goal is to confirm a real 201 draft + 200 publish round-trip. Document the exact commands you ran and their output.

- [ ] **Step 4: Confirm push→publish round-trips, then tear down**

Drive `handlers.push` then `handlers.publish`, then `handlers.source` and confirm the served HTML changed to the published draft. Finally:

```bash
kill %1 2>/dev/null
```

Expected: push returns `draft v2`, publish returns `published v2`, source returns the `v2 edited` HTML. Record the output in the task notes.

- [ ] **Step 5: Run the full test suite to confirm nothing regressed**

Run: `DATABASE_URL='postgresql://postgres:postgres@localhost:5433/postgres' PGSSLMODE=disable npx jest --runInBand`
Expected: all suites green except the 2 known pre-existing `inject.test.js` failures. The 3 new MCP suites (manifest/client/handlers) pass and do NOT require `DATABASE_URL` (they mock everything).

- [ ] **Step 6: Commit (if any harness fixes were needed) — otherwise nothing to commit**

```bash
git commit --allow-empty -m "test(mcp): verify end-to-end pull/push/publish against a live local server"
```

---

## Self-Review

- **Spec coverage:** MCP server (§3) ✓ six tools; manifest (§4) ✓ tracked template + resolve/baseVersion; `.env.example` note ✓; tests/mcp ✓ split into manifest/client/handlers. Delivery/REST unchanged (Phase 1).
- **Deviations (justified, noted in-plan):** (1) `.protoshare.json` shipped as `.protoshare.example.json` because the live manifest belongs in the *prototype* repo, not proto-share. (2) Own `mcp/package.json` so SDK deps don't ship to the deployed app (mirrors meetassist-mcp). (3) CJS `lib/*.cjs` + ESM `server.mjs` so the root Jest suite tests the logic without an ESM transform.
- **Type consistency:** client method names (`list/feedback/source/versions/pushVersion/publish`) match handler call sites and the fake client in tests. Manifest fn names (`load/save/resolveId/fileKeyFor/baseVersion/recordPull/recordPush`) match across module, handlers, and tests.
- **No placeholders:** every code step is complete.
```
