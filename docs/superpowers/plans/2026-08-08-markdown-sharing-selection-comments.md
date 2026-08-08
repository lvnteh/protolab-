# Markdown Sharing + Text-Selection Commenting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins upload `.md` files that render as formatted documents, and add text-selection commenting (select prose → comment) on both Markdown and HTML documents, alongside existing element pins.

**Architecture:** Raw `.md` is the source of truth, rendered to sanitized HTML at view time (`markdown-it` + `sanitize-html`), wrapped in a document shell, then the existing feedback SDK is injected unchanged. Text-selection comments are a new `type='range'` in the existing `comments` table, anchored by quote + prefix/suffix + char offsets (self-healing, Hypothesis-style). A shared `anchor.js` serializes selections and resolves anchors on both the live viewer and the admin preview.

**Tech Stack:** Node/Express (CommonJS), Postgres (`pg`), Supabase Storage, Jest + supertest, vanilla-JS SDKs. New deps: `markdown-it`, `sanitize-html`.

**Design spec:** `docs/superpowers/specs/2026-08-08-markdown-sharing-selection-comments-design.md`

---

## Conventions for every task

- **DB-gated tests:** server tests run only when `DATABASE_URL` is set (`const hasDb = !!process.env.DATABASE_URL; (hasDb ? describe : describe.skip)(...)`). Pure-function tests (markdown, anchor) do NOT need a DB and always run.
- **Run a single test file:** `npx jest tests/<file> --runInBand`
- **Run everything:** `npm test`
- **Lint:** `npm run lint` (must pass before every commit; `npm run check` runs lint + tests).
- **Commit discipline:** commit after each task's tests are green. Do NOT push or open PRs (workspace rule: never commit without explicit request — but for plan execution, per-task commits are the expected workflow; if the operator prefers otherwise they will say so).
- **Test DB availability:** if `DATABASE_URL` is unset, server-route tasks' tests are skipped — that is expected locally; note it and move on rather than treating skips as failures.

---

## File structure

| File | Responsibility |
|------|----------------|
| `src/services/markdown.js` | **new** — pure `render(rawMd) → { html }`: markdown-it (`html:false`) → sanitize-html |
| `src/views/markdown-shell.html` | **new** — typographic HTML document wrapper with `{{content}}` |
| `public/sdk/anchor.js` | **new** — shared `serializeSelection` / `resolveAnchor` (also exports for Node tests) |
| `src/services/filetype.js` | **new** — one-liner helpers: extension→content_type, content_type→mime/ext |
| `src/db.js` | migrations: `content_type` columns, widen comment CHECK, anchor columns |
| `src/services/storage.js` | accept a content-type argument instead of hardcoding `text/html` |
| `src/services/versions.js` | carry `content_type` through `createDraft`; resolve it for delivery |
| `src/routes/delivery.js` | branch on content_type; render Markdown before inject |
| `src/routes/admin.js` | accept `.md`; derive ext + content_type on upload |
| `src/routes/apiV1.js` | accept `.md`; derive ext + content_type on push |
| `src/routes/api.js` | `type:'range'` + anchor persistence and read |
| `public/sdk/feedback.js` | selection → draft; range highlight + margin marker; sidebar rows |
| `public/sdk/preview.js` | read-only range highlights + markers |
| `src/views/admin-upload.html` | `accept=".html,.md"`, label + hint copy |
| `mcp/lib/client.cjs` | infer MIME/extension from filename |
| `package.json` | add `markdown-it`, `sanitize-html` |

---

## Task 1: Add markdown + sanitizer dependencies

**Files:**
- Modify: `package.json` (dependencies)

- [ ] **Step 1: Install the two runtime deps (pinned)**

Run:
```bash
npm install markdown-it@14.1.0 sanitize-html@2.13.1
```
Expected: `package.json` gains both under `dependencies`; `package-lock.json` updated; no audit errors that block.

- [ ] **Step 2: Verify they load under Node 22**

Run:
```bash
node -e "const M=require('markdown-it');const s=require('sanitize-html');console.log(new M().render('# hi'), s('<b>x</b><script>1</script>'))"
```
Expected: prints `<h1>hi</h1>` (with newline) then `<b>x</b>` (script stripped).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add markdown-it + sanitize-html for markdown sharing"
```

---

## Task 2: File-type helper

A tiny pure module mapping between filename extension, the stored `content_type`
enum (`'html'` | `'markdown'`), and the MIME type for storage/serving. Centralizing
this keeps the `.html`/`.md` branching out of every route.

**Files:**
- Create: `src/services/filetype.js`
- Test: `tests/filetype.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/filetype.test.js
const ft = require('../src/services/filetype');

test('contentTypeForFilename maps extensions', () => {
  expect(ft.contentTypeForFilename('a.md')).toBe('markdown');
  expect(ft.contentTypeForFilename('a.markdown')).toBe('markdown');
  expect(ft.contentTypeForFilename('a.HTML')).toBe('html');
  expect(ft.contentTypeForFilename('a.html')).toBe('html');
});

test('contentTypeForFilename returns null for unsupported', () => {
  expect(ft.contentTypeForFilename('a.txt')).toBeNull();
  expect(ft.contentTypeForFilename('a.png')).toBeNull();
  expect(ft.contentTypeForFilename('noext')).toBeNull();
});

test('isAccepted mirrors contentTypeForFilename', () => {
  expect(ft.isAccepted('x.md')).toBe(true);
  expect(ft.isAccepted('x.html')).toBe(true);
  expect(ft.isAccepted('x.gif')).toBe(false);
});

test('extForContentType / mimeForContentType', () => {
  expect(ft.extForContentType('markdown')).toBe('md');
  expect(ft.extForContentType('html')).toBe('html');
  expect(ft.mimeForContentType('markdown')).toBe('text/markdown; charset=utf-8');
  expect(ft.mimeForContentType('html')).toBe('text/html; charset=utf-8');
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `npx jest tests/filetype.test.js --runInBand`
Expected: FAIL — `Cannot find module '../src/services/filetype'`.

- [ ] **Step 3: Implement**

```javascript
// src/services/filetype.js
// Single source of truth for how uploaded files map to a stored content_type
// ('html' | 'markdown'), the storage MIME type, and the on-disk extension.
// Keeps .html/.md branching out of the routes.

function contentTypeForFilename(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  return null;
}

function isAccepted(name) {
  return contentTypeForFilename(name) !== null;
}

function extForContentType(ct) {
  return ct === 'markdown' ? 'md' : 'html';
}

function mimeForContentType(ct) {
  return ct === 'markdown'
    ? 'text/markdown; charset=utf-8'
    : 'text/html; charset=utf-8';
}

module.exports = { contentTypeForFilename, isAccepted, extForContentType, mimeForContentType };
```

- [ ] **Step 4: Run it to verify pass**

Run: `npx jest tests/filetype.test.js --runInBand`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/filetype.js tests/filetype.test.js
git commit -m "feat(filetype): add extension↔content_type helper"
```

---

## Task 3: Markdown render service

**Files:**
- Create: `src/services/markdown.js`
- Test: `tests/markdown.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/markdown.test.js
const { render } = require('../src/services/markdown');

test('renders headings, lists, tables, code', () => {
  const { html } = render('# Title\n\n- one\n- two\n\n`code`');
  expect(html).toContain('<h1>Title</h1>');
  expect(html).toContain('<li>one</li>');
  expect(html).toContain('<code>code</code>');
});

test('renders GFM tables', () => {
  const { html } = render('| a | b |\n|---|---|\n| 1 | 2 |');
  expect(html).toContain('<table>');
  expect(html).toContain('<td>1</td>');
});

test('ignores raw HTML in the markdown (html:false)', () => {
  const { html } = render('hello <div onclick="x()">raw</div> world');
  // raw block-level HTML is emitted as escaped text, not a live element
  expect(html).not.toContain('<div onclick');
});

test('sanitizes dangerous output (script/js-url stripped)', () => {
  const { html } = render('[click](javascript:alert(1))\n\n<script>alert(2)</script>');
  expect(html).not.toContain('<script');
  expect(html.toLowerCase()).not.toContain('javascript:');
});

test('empty input yields empty-ish html string', () => {
  const { html } = render('');
  expect(typeof html).toBe('string');
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `npx jest tests/markdown.test.js --runInBand`
Expected: FAIL — `Cannot find module '../src/services/markdown'`.

- [ ] **Step 3: Implement**

```javascript
// src/services/markdown.js
// Render Markdown → safe HTML fragment. Two layers of defense:
//   1. markdown-it with html:false — raw HTML in the source is escaped, not parsed.
//   2. sanitize-html on the output — strips anything unexpected (scripts, event
//      handlers, javascript: URLs) even if it slipped through.
// Pure function, no DB, no I/O — trivially testable.
const MarkdownIt = require('markdown-it');
const sanitizeHtml = require('sanitize-html');

const md = new MarkdownIt({
  html: false,      // do not parse raw HTML tags in the markdown
  linkify: true,    // autolink bare URLs
  breaks: false,
  typographer: true,
});

const SANITIZE_OPTIONS = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'a', 'ul', 'ol', 'li', 'blockquote', 'hr', 'br',
    'strong', 'em', 'del', 'code', 'pre', 'span',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'img', 'input', // input: task-list checkboxes
  ],
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'title'],
    input: ['type', 'checked', 'disabled'],
    span: ['class'],
    code: ['class'],
    pre: ['class'],
    th: ['align'],
    td: ['align'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  // Force task-list checkboxes to stay disabled + drop any stray attributes.
  transformTags: {
    input: (tagName, attribs) => ({
      tagName,
      attribs: { type: 'checkbox', disabled: 'disabled', ...(attribs.checked ? { checked: 'checked' } : {}) },
    }),
  },
};

function render(rawMd) {
  const rendered = md.render(String(rawMd == null ? '' : rawMd));
  const html = sanitizeHtml(rendered, SANITIZE_OPTIONS);
  return { html };
}

module.exports = { render };
```

- [ ] **Step 4: Run it to verify pass**

Run: `npx jest tests/markdown.test.js --runInBand`
Expected: PASS (5 tests). If the `html:false` test fails because markdown-it emits an HTML comment wrapper, adjust the assertion to check `not.toContain('onclick')` only — the security guarantee is that no live handler survives.

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add src/services/markdown.js tests/markdown.test.js
git commit -m "feat(markdown): server-side render + sanitize service"
```

---

## Task 4: DB migrations — content_type + range comment columns

All migrations are idempotent and go in `initDb()` in `src/db.js`, following the
existing `ADD COLUMN IF NOT EXISTS` / atomic constraint drop+add patterns.

**Files:**
- Modify: `src/db.js` (add columns + widen CHECK)
- Test: `tests/markdown-schema.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/markdown-schema.test.js
const hasDb = !!process.env.DATABASE_URL;
const { initDb, getDb, closeDb } = require('../src/db');
const { nanoid } = require('nanoid');

(hasDb ? describe : describe.skip)('markdown schema migrations', () => {
  beforeAll(async () => { await initDb(); });
  afterAll(async () => { await closeDb(); });

  test('prototypes + prototype_versions have content_type defaulting to html', async () => {
    const id = nanoid(12), tok = nanoid(12);
    await getDb().query(
      'INSERT INTO prototypes (id, name, filename, share_token, created_at) VALUES ($1,$2,$3,$4,$5)',
      [id, 'CT', `${id}.html`, tok, new Date().toISOString()]
    );
    const { rows } = await getDb().query('SELECT content_type FROM prototypes WHERE id = $1', [id]);
    expect(rows[0].content_type).toBe('html');
  });

  test("comments type CHECK now allows 'range'", async () => {
    const id = nanoid(12), tok = nanoid(12);
    await getDb().query(
      'INSERT INTO prototypes (id, name, filename, share_token, created_at) VALUES ($1,$2,$3,$4,$5)',
      [id, 'R', `${id}.html`, tok, new Date().toISOString()]
    );
    const cid = nanoid(12);
    await getDb().query(
      `INSERT INTO comments (id, prototype_id, email, type, comment, created_at,
         anchor_quote, anchor_prefix, anchor_suffix, anchor_start, anchor_end)
       VALUES ($1,$2,$3,'range',$4,$5,$6,$7,$8,$9,$10)`,
      [cid, id, 'u@example.com', 'selected text', new Date().toISOString(),
       'selected text', 'before ', ' after', 10, 23]
    );
    const { rows } = await getDb().query('SELECT type, anchor_quote, anchor_start FROM comments WHERE id = $1', [cid]);
    expect(rows[0].type).toBe('range');
    expect(rows[0].anchor_quote).toBe('selected text');
    expect(rows[0].anchor_start).toBe(10);
  });
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `npx jest tests/markdown-schema.test.js --runInBand`
Expected: with a DB, FAIL — `column "content_type" does not exist` (and the range insert violates the current CHECK). Without a DB, SKIPPED (note it and continue to implement anyway).

- [ ] **Step 3: Implement — add content_type columns**

In `src/db.js`, immediately AFTER the `prototypes` table `CREATE TABLE IF NOT EXISTS` block (currently ends near line 29) and after the versions table is created, add these idempotent migrations. Place this block right after the existing `H./J.` comment-column `ALTER`s (after line 208) so it runs with the other additive migrations:

```javascript
  // --- Markdown sharing: content_type on versions (authoritative) + prototypes (mirror) ---
  // Existing rows default to 'html' so every current prototype keeps rendering as HTML.
  await _pool.query(`ALTER TABLE prototype_versions ADD COLUMN IF NOT EXISTS content_type TEXT NOT NULL DEFAULT 'html'`);
  await _pool.query(`ALTER TABLE prototypes         ADD COLUMN IF NOT EXISTS content_type TEXT NOT NULL DEFAULT 'html'`);

  // Range (text-selection) comments: anchor columns. Nullable — only range rows use them.
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS anchor_quote  TEXT`);
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS anchor_prefix TEXT`);
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS anchor_suffix TEXT`);
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS anchor_start  INTEGER`);
  await _pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS anchor_end    INTEGER`);
```

- [ ] **Step 4: Implement — widen the comments type CHECK to include 'range'**

Replace the existing "Widen the type CHECK to also allow 'reply' rows" block
(currently lines ~70-76) so it lists all four types. It stays atomic drop+add:

```javascript
  // Widen the type CHECK to allow 'reply' and 'range' rows (atomic drop + add)
  await _pool.query(`
    DO $$ BEGIN
      ALTER TABLE comments DROP CONSTRAINT IF EXISTS comments_type_check;
      ALTER TABLE comments ADD CONSTRAINT comments_type_check
        CHECK(type IN ('general', 'element', 'reply', 'range'));
    END $$
  `);
```

- [ ] **Step 5: Run it to verify pass**

Run: `npx jest tests/markdown-schema.test.js --runInBand`
Expected: with a DB, PASS (2 tests). Without a DB, SKIPPED.

- [ ] **Step 6: Lint + commit**

```bash
npm run lint
git add src/db.js tests/markdown-schema.test.js
git commit -m "feat(db): content_type columns + range comment anchor columns"
```

---

## Task 5: Storage — content-type argument

`putPrototype` hardcodes `contentType: 'text/html'` for Supabase. Make it accept
a MIME argument (default preserves current behavior so no other caller breaks).

**Files:**
- Modify: `src/services/storage.js:50-60` (`putPrototype`)
- Test: covered indirectly by delivery/upload tasks; no new unit test (local fallback ignores content type).

- [ ] **Step 1: Change the signature**

Replace `putPrototype`:

```javascript
// Store a prototype file. `body` may be a Buffer (from multer memoryStorage)
// or a string. `contentType` sets the stored MIME (defaults to HTML for callers
// that predate markdown support). `upsert: true` so re-uploading overwrites.
async function putPrototype(filename, body, contentType = 'text/html') {
  if (!useSupabase) {
    await fs.promises.mkdir(config.uploadsPath, { recursive: true });
    await fs.promises.writeFile(localPath(filename), body);
    return;
  }
  const { error } = await client()
    .storage.from(config.storageBucket)
    .upload(filename, body, { contentType, upsert: true });
  if (error) throw error;
}
```

- [ ] **Step 2: Verify nothing else breaks (existing callers omit the arg)**

Run: `npm run lint && npx jest tests/versions.test.js tests/delivery.test.js --runInBand`
Expected: lint clean; tests PASS with a DB or SKIP without. (Existing calls pass no content type → default `'text/html'` → unchanged behavior.)

- [ ] **Step 3: Commit**

```bash
git add src/services/storage.js
git commit -m "feat(storage): accept content-type argument (defaults to text/html)"
```

---

## Task 6: Versions service — carry content_type

`createDraft` must record the new version's `content_type`, and delivery needs to
know a published version's `content_type`. Extend both.

**Files:**
- Modify: `src/services/versions.js` (`createDraft`, add `resolvePublished`)
- Test: `tests/versions.test.js` (extend)

- [ ] **Step 1: Write the failing test (append to tests/versions.test.js)**

```javascript
test('createDraft records content_type', async () => {
  // `protoId` is created in this file's existing beforeAll as an html prototype.
  const v = await versions.createDraft(protoId, `${nanoid(12)}.md`, 'md draft', 'markdown');
  const { rows } = await getDb().query('SELECT content_type FROM prototype_versions WHERE id = $1', [v.id]);
  expect(rows[0].content_type).toBe('markdown');
});

test('resolvePublished returns filename + content_type', async () => {
  const info = await versions.resolvePublished(protoId);
  expect(info).toHaveProperty('filename');
  expect(info).toHaveProperty('contentType');
});
```

> If `tests/versions.test.js` does not already expose `protoId`/`nanoid`/`versions`
> at module scope, check its existing `beforeAll` and reuse the identifiers it
> defines (it creates a prototype + v1). Match the file's existing setup rather
> than adding a new one.

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/versions.test.js --runInBand`
Expected: with DB, FAIL — `createDraft` ignores the 4th arg (content_type is `'html'`), and `versions.resolvePublished` is not a function. Without DB, SKIP.

- [ ] **Step 3: Implement — extend `createDraft` with a content_type param**

Replace `createDraft` in `src/services/versions.js`:

```javascript
// Create a new draft version with the next number. Sets prototypes.draft_version_id.
// contentType ('html' | 'markdown') records how this version's file must render;
// defaults to 'html' so existing callers are unaffected.
async function createDraft(prototypeId, filename, note, contentType = 'html') {
  const version = (await latestVersion(prototypeId)) + 1;
  const id = nanoid(12);
  await getDb().query(
    `INSERT INTO prototype_versions (id, prototype_id, version, filename, status, note, created_at, content_type)
     VALUES ($1,$2,$3,$4,'draft',$5,$6,$7)`,
    [id, prototypeId, version, filename, note || null, new Date().toISOString(), contentType]
  );
  await getDb().query('UPDATE prototypes SET draft_version_id = $1 WHERE id = $2', [id, prototypeId]);
  return { id, version, status: 'draft' };
}
```

- [ ] **Step 4: Implement — add `resolvePublished` (filename + content_type)**

Add alongside `resolvePublishedFile` (keep the old one — apiV1 still uses it):

```javascript
// Like resolvePublishedFile but also returns how the file should render.
// Returns null when there is no published version.
async function resolvePublished(prototypeId) {
  const { rows } = await getDb().query(
    `SELECT v.filename, v.content_type FROM prototypes p
     JOIN prototype_versions v ON v.id = p.published_version_id
     WHERE p.id = $1`,
    [prototypeId]
  );
  return rows[0] ? { filename: rows[0].filename, contentType: rows[0].content_type || 'html' } : null;
}
```

Add `resolvePublished` to `module.exports`:

```javascript
module.exports = { latestVersion, createDraft, publish, resolvePublishedFile, resolvePublished, publishedVersionId };
```

- [ ] **Step 5: Run to verify pass**

Run: `npx jest tests/versions.test.js --runInBand`
Expected: with DB, PASS. Without DB, SKIP.

- [ ] **Step 6: Lint + commit**

```bash
npm run lint
git add src/services/versions.js tests/versions.test.js
git commit -m "feat(versions): carry content_type through createDraft + resolvePublished"
```

---

## Task 7: Delivery — render Markdown before injecting the SDK

**Files:**
- Modify: `src/routes/delivery.js:56-81` (the `/view` handler)
- Test: `tests/delivery.test.js` (extend)

- [ ] **Step 1: Write the failing test (append to tests/delivery.test.js)**

```javascript
test('GET /p/:token/view renders a Markdown version to sanitized, SDK-injected HTML', async () => {
  // Publish a markdown version on the existing proto.
  const mdFile = `${protoId}-md.md`;
  await storage.putPrototype(mdFile, '# Hello MD\n\nSome **bold** text.', 'text/markdown; charset=utf-8');
  const v = await versions.createDraft(protoId, mdFile, 'md', 'markdown');
  await versions.publish(protoId, v.version);

  const agent = request.agent(app);
  await agent.post(`/p/${shareToken}/enter`).send('email=allowed@example.com');
  const res = await agent.get(`/p/${shareToken}/view`);

  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/text\/html/);
  expect(res.text).toContain('<h1>Hello MD</h1>');   // rendered markdown
  expect(res.text).toContain('<strong>bold</strong>');
  expect(res.text).toContain('/sdk/feedback.js');     // SDK injected on top of rendered md
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/delivery.test.js --runInBand`
Expected: with DB, FAIL — the raw markdown is served verbatim (no `<h1>`). Without DB, SKIP.

- [ ] **Step 3: Implement — branch on content_type**

In `src/routes/delivery.js`, add requires near the top (after the existing ones):

```javascript
const markdown = require('../services/markdown');
```

Replace the file-resolution + inject portion of the `/:shareToken/view` handler
(currently lines ~66-71, from the `resolvePublishedFile` call through `injectSdk`):

```javascript
  // Serve the published version's file. Markdown versions are rendered to a
  // sanitized HTML document first; HTML versions are served as-is. Either way
  // the SDK is injected into the final HTML.
  const published = await versions.resolvePublished(proto.id);
  const filename = published ? published.filename : proto.filename;
  const contentType = published ? published.contentType : 'html';
  const raw = await storage.getPrototype(filename);
  if (raw === null) return res.status(404).send('Prototype file not found.');

  let documentHtml;
  if (contentType === 'markdown') {
    const { html } = markdown.render(raw);
    documentHtml = readView('markdown-shell.html').split('{{content}}').join(html);
  } else {
    documentHtml = raw;
  }

  const injected = injectSdk(documentHtml, proto.id, req.session.customerEmail);
```

> Note: `versions` and `storage` are already required at the top of delivery.js.
> The existing `resolvePublishedFile` import stays; we just call the new
> `resolvePublished` instead in this handler.

- [ ] **Step 4: Run to verify pass (after Task 8 creates the shell)**

The shell view is created in Task 8. If you are executing strictly in order,
temporarily inline a minimal shell to keep the test green, OR reorder to do Task
8 first. Recommended: **do Task 8 before running this test.** Then:

Run: `npx jest tests/delivery.test.js --runInBand`
Expected: with DB, PASS (existing HTML tests + new Markdown test). Without DB, SKIP.

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add src/routes/delivery.js tests/delivery.test.js
git commit -m "feat(delivery): render markdown versions before SDK injection"
```

---

## Task 8: Markdown document shell view

A minimal, readable HTML wrapper for rendered Markdown. Single `{{content}}`
placeholder. Do this BEFORE running Task 7's test.

**Files:**
- Create: `src/views/markdown-shell.html`

- [ ] **Step 1: Create the shell**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Document</title>
<style>
  *,*::before,*::after{box-sizing:border-box}
  body{margin:0;background:hsl(220,14%,96%);color:hsl(222,47%,11%);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    line-height:1.65;font-size:16px}
  .md-doc{max-width:760px;margin:0 auto;padding:56px 32px 120px;background:#fff;
    min-height:100vh;box-shadow:0 1px 4px rgba(0,0,0,.06)}
  .md-doc h1,.md-doc h2,.md-doc h3,.md-doc h4{line-height:1.25;margin:1.6em 0 .6em;font-weight:700}
  .md-doc h1{font-size:2em;margin-top:0}
  .md-doc h2{font-size:1.5em;border-bottom:1px solid hsl(220,13%,91%);padding-bottom:.2em}
  .md-doc h3{font-size:1.25em}
  .md-doc p{margin:0 0 1em}
  .md-doc a{color:hsl(252,83%,57%)}
  .md-doc ul,.md-doc ol{margin:0 0 1em;padding-left:1.6em}
  .md-doc li{margin:.25em 0}
  .md-doc blockquote{margin:0 0 1em;padding:.4em 1em;border-left:4px solid hsl(252,83%,80%);
    background:hsl(252,83%,98%);color:hsl(222,25%,30%)}
  .md-doc code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;
    background:hsl(220,14%,93%);padding:.15em .4em;border-radius:4px}
  .md-doc pre{background:hsl(222,47%,11%);color:#f8f8f2;padding:16px;border-radius:10px;
    overflow:auto;margin:0 0 1em}
  .md-doc pre code{background:none;padding:0;color:inherit}
  .md-doc table{border-collapse:collapse;width:100%;margin:0 0 1em;font-size:.95em}
  .md-doc th,.md-doc td{border:1px solid hsl(220,13%,88%);padding:8px 12px;text-align:left}
  .md-doc th{background:hsl(220,14%,96%);font-weight:600}
  .md-doc img{max-width:100%;height:auto}
  .md-doc hr{border:none;border-top:1px solid hsl(220,13%,88%);margin:2em 0}
  .md-doc input[type=checkbox]{margin-right:.5em}
</style>
</head>
<body>
<article class="md-doc">
{{content}}
</article>
</body>
</html>
```

- [ ] **Step 2: Verify the placeholder splice works**

Run:
```bash
node -e "const fs=require('fs');const s=fs.readFileSync('src/views/markdown-shell.html','utf8');console.log(s.includes('{{content}}'), s.split('{{content}}').join('<h1>X</h1>').includes('<h1>X</h1>'))"
```
Expected: `true true`.

- [ ] **Step 3: Commit**

```bash
git add src/views/markdown-shell.html
git commit -m "feat(views): add markdown document shell"
```

---

## Task 9: Admin upload accepts .md

**Files:**
- Modify: `src/routes/admin.js:17-20` (multer filter), `:172-201` (POST /prototypes)
- Modify: `src/views/admin-upload.html:68-72` (label, accept, hint)
- Test: `tests/admin-upload-md.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/admin-upload-md.test.js
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();
const hasDb = !!process.env.DATABASE_URL;
const { initDb, getDb, closeDb } = require('../src/db');
const { nanoid } = require('nanoid');
const request = require('supertest');
const express = require('express');
const session = require('express-session');
const adminRouter = require('../src/routes/admin');

let app, userId, orgId;

(hasDb ? describe : describe.skip)('admin upload markdown', () => {
  beforeAll(async () => {
    await initDb();
    // Seed a user + org + admin membership, then stub the session onto every request.
    userId = nanoid(12); orgId = nanoid(12);
    await getDb().query('INSERT INTO users (id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)',
      [userId, `md-${userId}@sap.com`, 'x', new Date().toISOString()]);
    await getDb().query('INSERT INTO organizations (id,name,created_at) VALUES ($1,$2,$3)',
      [orgId, 'MD Org ' + orgId, new Date().toISOString()]);
    await getDb().query(
      "INSERT INTO org_memberships (id,org_id,user_id,role,created_at) VALUES ($1,$2,$3,'admin',$4)",
      [nanoid(12), orgId, userId, new Date().toISOString()]);

    app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    app.use((req, _res, next) => { req.session.userId = userId; req.session.activeOrgId = orgId; next(); });
    app.use('/admin', adminRouter);
  });
  afterAll(async () => { await closeDb(); });

  test('uploads a .md file and stores content_type=markdown with a .md filename', async () => {
    const res = await request(app)
      .post('/admin/prototypes')
      .set('accept', 'application/json')
      .field('name', 'MD Proto')
      .attach('file', Buffer.from('# Doc\n\nHello.'), 'doc.md');
    expect(res.status).toBe(200);
    const id = res.body.id;
    const { rows } = await getDb().query('SELECT filename, content_type FROM prototypes WHERE id = $1', [id]);
    expect(rows[0].content_type).toBe('markdown');
    expect(rows[0].filename.endsWith('.md')).toBe(true);
    const { rows: vrows } = await getDb().query(
      'SELECT content_type, filename FROM prototype_versions WHERE prototype_id = $1', [id]);
    expect(vrows[0].content_type).toBe('markdown');
  });

  test('rejects a .txt file', async () => {
    const res = await request(app)
      .post('/admin/prototypes')
      .field('name', 'Bad')
      .attach('file', Buffer.from('nope'), 'notes.txt');
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/admin-upload-md.test.js --runInBand`
Expected: with DB, FAIL — `.md` is rejected by the current fileFilter (400, no body.id). Without DB, SKIP.

- [ ] **Step 3: Implement — multer filter + require filetype**

In `src/routes/admin.js`, add the require after the existing service requires:

```javascript
const filetype = require('../services/filetype');
```

Replace the multer block (lines ~17-20):

```javascript
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => cb(null, filetype.isAccepted(file.originalname)),
});
```

- [ ] **Step 4: Implement — derive extension + content_type in POST /prototypes**

In the `POST /prototypes` handler, replace the id/filename/version setup and the
`putPrototype` + version insert so they use the uploaded file's content type.
Replace lines ~172-193 (from `if (!req.file)` through the v1 version insert):

```javascript
router.post('/prototypes', orgs.requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).send('Only .html or .md files are accepted.');
  const contentType = filetype.contentTypeForFilename(req.file.originalname) || 'html';
  const id = nanoid(12);
  const shareToken = nanoid(12);
  const filename = `${id}.${filetype.extForContentType(contentType)}`;
  const versionId = nanoid(12);
  await storage.putPrototype(filename, req.file.buffer, filetype.mimeForContentType(contentType));

  const client = await getDb().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO prototypes (id, name, filename, share_token, created_at, owner_id, org_id, content_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, req.body.name || 'Untitled', filename, shareToken, new Date().toISOString(), req.session.userId, req.orgId, contentType]
    );
    // v1 is the original, published from birth.
    await client.query(
      `INSERT INTO prototype_versions (id, prototype_id, version, filename, status, created_at, content_type)
       VALUES ($1,$2,1,$3,'published',$4,$5)`,
      [versionId, id, filename, new Date().toISOString(), contentType]
    );
    await client.query('UPDATE prototypes SET published_version_id = $1 WHERE id = $2', [versionId, id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
```

> The rest of the handler (allowlist parsing, shareLink, JSON/HTML response) is
> unchanged — leave it as-is.

- [ ] **Step 5: Implement — update the upload view copy**

In `src/views/admin-upload.html`, replace lines ~68-72:

```html
      <div class="field">
        <label>Document File</label>
        <div class="file-zone" id="file-zone">
          <input type="file" name="file" id="proto-file" accept=".html,.md,.markdown" required>
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/></svg>
          <div class="file-zone__label"><strong>Click to browse</strong> or drag &amp; drop<br><span style="color:hsl(220,9%,60%);font-size:12px">.html or .md files</span></div>
          <div class="file-zone__name" id="file-name"></div>
        </div>
      </div>
```

- [ ] **Step 6: Run to verify pass**

Run: `npx jest tests/admin-upload-md.test.js --runInBand`
Expected: with DB, PASS (2 tests). Without DB, SKIP.

- [ ] **Step 7: Lint + commit**

```bash
npm run lint
git add src/routes/admin.js src/views/admin-upload.html tests/admin-upload-md.test.js
git commit -m "feat(admin): accept .md uploads (content_type=markdown)"
```

---

## Task 10: apiV1 push accepts .md

The local-AI push path (`POST /api/v1/prototypes/:id/versions`) also hardcodes
`.html`. Mirror the admin change so agents can push `.md` drafts.

**Files:**
- Modify: `src/routes/apiV1.js:14-17` (filter), `:143-167` (push handler), `:116-135` (source content-type)
- Test: `tests/apiv1-md.test.js` (or extend an existing apiV1 test if present)

- [ ] **Step 1: Write the failing test**

```javascript
// tests/apiv1-md.test.js
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();
const hasDb = !!process.env.DATABASE_URL;
const { initDb, getDb, closeDb } = require('../src/db');
const { nanoid } = require('nanoid');
const request = require('supertest');
const express = require('express');
const apiV1Router = require('../src/routes/apiV1');
const tokens = require('../src/services/tokens');

let app, protoId, orgId, userId, rawToken;

(hasDb ? describe : describe.skip)('api v1 markdown push', () => {
  beforeAll(async () => {
    await initDb();
    userId = nanoid(12); orgId = nanoid(12); protoId = nanoid(12);
    await getDb().query('INSERT INTO users (id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)',
      [userId, `v1md-${userId}@sap.com`, 'x', new Date().toISOString()]);
    await getDb().query('INSERT INTO organizations (id,name,created_at) VALUES ($1,$2,$3)',
      [orgId, 'V1 MD Org ' + orgId, new Date().toISOString()]);
    await getDb().query("INSERT INTO org_memberships (id,org_id,user_id,role,created_at) VALUES ($1,$2,$3,'admin',$4)",
      [nanoid(12), orgId, userId, new Date().toISOString()]);
    const vid = nanoid(12);
    await getDb().query('INSERT INTO prototypes (id,name,filename,share_token,created_at,owner_id,org_id,content_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [protoId, 'V1 Proto', `${protoId}.html`, nanoid(12), new Date().toISOString(), userId, orgId, 'html']);
    await getDb().query("INSERT INTO prototype_versions (id,prototype_id,version,filename,status,created_at,content_type) VALUES ($1,$2,1,$3,'published',$4,'html')",
      [vid, protoId, `${protoId}.html`, new Date().toISOString()]);
    await getDb().query('UPDATE prototypes SET published_version_id = $1 WHERE id = $2', [vid, protoId]);
    const t = await tokens.createToken(userId, 'test', orgId);
    rawToken = t.raw;

    app = express();
    app.use(express.json());
    app.use('/api/v1', apiV1Router);
  });
  afterAll(async () => { await closeDb(); });

  test('pushes a .md draft with content_type=markdown', async () => {
    const res = await request(app)
      .post(`/api/v1/prototypes/${protoId}/versions`)
      .set('Authorization', `Bearer ${rawToken}`)
      .attach('file', Buffer.from('# Draft\n\nMD body'), 'draft.md')
      .field('note', 'md push');
    expect(res.status).toBe(201);
    const { rows } = await getDb().query(
      'SELECT content_type, filename FROM prototype_versions WHERE prototype_id = $1 AND version = 2', [protoId]);
    expect(rows[0].content_type).toBe('markdown');
    expect(rows[0].filename.endsWith('.md')).toBe(true);
  });
});
```

> Confirm the `tokens.createToken(userId, name, orgId)` signature against
> `src/services/tokens.js` before running; adjust the call if it differs.

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/apiv1-md.test.js --runInBand`
Expected: with DB, FAIL — `.md` rejected by fileFilter. Without DB, SKIP.

- [ ] **Step 3: Implement — filter + require**

In `src/routes/apiV1.js`, add after existing requires:

```javascript
const filetype = require('../services/filetype');
```

Replace the multer block (lines ~14-17):

```javascript
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => cb(null, filetype.isAccepted(file.originalname)),
});
```

- [ ] **Step 4: Implement — push handler filename + content_type**

In `POST /prototypes/:id/versions`, replace the error message, filename, and
`putPrototype` + `createDraft` calls (lines ~146-157):

```javascript
    if (!req.file) return res.status(400).json({ error: 'Only .html or .md files are accepted.' });

    const latest = await versions.latestVersion(req.params.id);
    const base = parseInt(req.body.baseVersion, 10);
    if (!Number.isNaN(base) && base !== latest) {
      return res.status(409).json({ error: 'Prototype changed since you pulled.', currentVersion: latest });
    }

    const contentType = filetype.contentTypeForFilename(req.file.originalname) || 'html';
    const filename = `${nanoid(12)}.${filetype.extForContentType(contentType)}`;
    await storage.putPrototype(filename, req.file.buffer, filetype.mimeForContentType(contentType));
    try {
      const v = await versions.createDraft(req.params.id, filename, req.body.note, contentType);
      res.status(201).json(v);
    } catch (e) {
```

> The `catch (e)` block (23505 handling) below is unchanged.

- [ ] **Step 5: Implement — source endpoint returns correct content-type**

In `GET /prototypes/:id/source`, the response currently forces `text/html`.
Resolve the version's content type. Replace lines ~120-135:

```javascript
    let filename, contentType;
    if (req.query.version) {
      const v = parseInt(req.query.version, 10);
      if (Number.isNaN(v)) return res.status(400).json({ error: 'version must be an integer.' });
      const { rows } = await getDb().query(
        'SELECT filename, content_type FROM prototype_versions WHERE prototype_id = $1 AND version = $2',
        [req.params.id, v]);
      filename = rows[0] && rows[0].filename;
      contentType = rows[0] && rows[0].content_type;
    } else {
      const pub = await versions.resolvePublished(req.params.id);
      filename = pub && pub.filename;
      contentType = pub && pub.contentType;
    }
    if (!filename) return res.status(404).json({ error: 'Version not found.' });
    const raw = await storage.getPrototype(filename);
    if (raw === null) return res.status(404).json({ error: 'File not found.' });
    res.setHeader('Content-Type', filetype.mimeForContentType(contentType || 'html'));
    res.send(raw);
```

> This serves raw markdown (source) to the machine caller — correct, agents want
> the `.md` source, not rendered HTML. The rendered view stays on `/p/:token/view`.

- [ ] **Step 6: Run to verify pass**

Run: `npx jest tests/apiv1-md.test.js --runInBand`
Expected: with DB, PASS. Without DB, SKIP.

- [ ] **Step 7: Lint + commit**

```bash
npm run lint
git add src/routes/apiV1.js tests/apiv1-md.test.js
git commit -m "feat(apiV1): accept .md pushes + content-type-aware source"
```

---

## Task 11: api.js — persist and read range comments

**Files:**
- Modify: `src/routes/api.js:55-113` (POST /comments), `:115-151` (GET /comments)
- Test: `tests/api.test.js` (extend)

- [ ] **Step 1: Write the failing test (append to tests/api.test.js)**

```javascript
test('POST /api/comments stores a range comment with anchor', async () => {
  const res = await request(app).post('/api/comments').send({
    prototypeId: protoId,
    type: 'range',
    comment: 'This sentence is unclear',
    pageUrl: '/p/abc/view',
    tag: 'copy',
    anchor: { quote: 'unclear sentence', prefix: 'the ', suffix: ' here', start: 42, end: 58 },
  });
  expect(res.status).toBe(201);
  const { rows } = await getDb().query("SELECT * FROM comments WHERE comment = 'This sentence is unclear'");
  const row = rows[0];
  expect(row.type).toBe('range');
  expect(row.anchor_quote).toBe('unclear sentence');
  expect(row.anchor_start).toBe(42);
  expect(row.anchor_end).toBe(58);
  expect(row.tag).toBe('copy');
});

test('POST /api/comments range without anchor quote returns 400', async () => {
  const res = await request(app).post('/api/comments').send({
    prototypeId: protoId,
    type: 'range',
    comment: 'no anchor',
    anchor: { quote: '   ' },
  });
  expect(res.status).toBe(400);
});

test('GET /api/comments returns anchor fields on range comments', async () => {
  const pid = 'range-' + Date.now();
  await getDb().query(
    'INSERT INTO prototypes (id, name, filename, share_token, created_at) VALUES ($1,$2,$3,$4,$5)',
    [pid, 'RangeGet', `${pid}.md`, 'tok-' + pid, new Date().toISOString()]
  );
  await request(app).post('/api/comments').set('x-test-proto', pid).send({
    prototypeId: pid, type: 'range', comment: 'anchored', pageUrl: '/p/x/view',
    anchor: { quote: 'the target', prefix: 'a ', suffix: ' b', start: 1, end: 11 },
  });
  const get = await request(app).get('/api/comments/' + pid).set('x-test-proto', pid);
  expect(get.status).toBe(200);
  const c = get.body.find(x => x.comment === 'anchored');
  expect(c).toBeTruthy();
  expect(c.anchor_quote).toBe('the target');
  expect(c.anchor_start).toBe(1);
  expect(c.type).toBe('range');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/api.test.js --runInBand`
Expected: with DB, FAIL — range type rejected as invalid (POST) and anchor fields absent (GET). Without DB, SKIP.

- [ ] **Step 3: Implement — accept type:'range' + anchor on POST**

In `src/routes/api.js`, in `POST /comments`, destructure `anchor` from the body:

```javascript
    const { prototypeId, type, comment, element, breadcrumb, pageUrl, tag, xPct, yPct, email, parentId, anchor } = req.body;
```

Widen the type guard (currently `if (!['general', 'element'].includes(type))`):

```javascript
    if (!['general', 'element', 'range'].includes(type)) return res.status(400).json({ error: 'Invalid type.' });

    // Range comments require an anchor with a non-empty quote.
    let anchorCols = { quote: null, prefix: null, suffix: null, start: null, end: null };
    if (type === 'range') {
      if (!anchor || !anchor.quote || !String(anchor.quote).trim()) {
        return res.status(400).json({ error: 'Range comment requires an anchor quote.' });
      }
      anchorCols = {
        quote: String(anchor.quote),
        prefix: anchor.prefix != null ? String(anchor.prefix) : null,
        suffix: anchor.suffix != null ? String(anchor.suffix) : null,
        start: Number.isInteger(anchor.start) ? anchor.start : null,
        end: Number.isInteger(anchor.end) ? anchor.end : null,
      };
    }
```

Replace the main INSERT (the non-reply insert) so it writes the anchor columns:

```javascript
    await getDb().query(
      `INSERT INTO comments
        (id, prototype_id, email, type, element_selector, element_label, element_tag,
         breadcrumb, comment, page_url, created_at, tag, x_pct, y_pct, version_id,
         anchor_quote, anchor_prefix, anchor_suffix, anchor_start, anchor_end)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        id, prototypeId, commentEmail, type,
        element?.selector || null,
        element?.label    || null,
        element?.tagName  || null,
        breadcrumb ? JSON.stringify(breadcrumb) : null,
        comment.trim(),
        pageUrl || null,
        new Date().toISOString(),
        VALID_TAGS.includes(tag) ? tag : null,
        typeof xPct === 'number' ? xPct : null,
        typeof yPct === 'number' ? yPct : null,
        versionId,
        anchorCols.quote, anchorCols.prefix, anchorCols.suffix, anchorCols.start, anchorCols.end,
      ]
    );
```

- [ ] **Step 4: Implement — return anchor fields on GET /comments**

In `GET /comments/:prototypeId`, extend the SELECT column list to include the
anchor fields and `type`:

```javascript
    const { rows } = await getDb().query(
      `SELECT id, email, type, element_selector, element_label, comment, created_at, tag, x_pct, y_pct, page_url, parent_id,
              anchor_quote, anchor_prefix, anchor_suffix, anchor_start, anchor_end
       FROM comments
       WHERE prototype_id = $1
       ORDER BY created_at ASC`,
      [req.params.prototypeId]
    );
```

> The existing parent/reply grouping and `order`/`replies` mapping stay unchanged;
> the new columns simply ride along on each parent row.

- [ ] **Step 5: Run to verify pass**

Run: `npx jest tests/api.test.js --runInBand`
Expected: with DB, PASS (existing + 3 new). Without DB, SKIP.

- [ ] **Step 6: Lint + commit**

```bash
npm run lint
git add src/routes/api.js tests/api.test.js
git commit -m "feat(api): persist + return range comments with text anchors"
```

---

## Task 12: Shared anchor module (`public/sdk/anchor.js`)

Serializes a DOM Selection into a durable anchor and resolves an anchor back to a
Range. The string-matching core is pure and Node-testable; the DOM glue is thin.
Exposed both as a browser global (`window.FBAnchor`) and via `module.exports` for
Jest.

**Files:**
- Create: `public/sdk/anchor.js`
- Test: `tests/anchor.test.js`

- [ ] **Step 1: Write the failing test (pure core only — no DOM)**

```javascript
// tests/anchor.test.js
const A = require('../public/sdk/anchor');

// locateQuote(fullText, anchor) → { start, end } | null
test('exact offset hit is confirmed by quote', () => {
  const text = 'The quick brown fox jumps.';
  const anchor = { quote: 'quick brown', prefix: 'The ', suffix: ' fox', start: 4, end: 15 };
  expect(A.locateQuote(text, anchor)).toEqual({ start: 4, end: 15 });
});

test('recovers when offsets drift but quote is unique', () => {
  const text = 'INSERTED. The quick brown fox jumps.';
  const anchor = { quote: 'quick brown', prefix: 'The ', suffix: ' fox', start: 4, end: 15 };
  expect(A.locateQuote(text, anchor)).toEqual({ start: 14, end: 25 });
});

test('disambiguates duplicate quotes via prefix/suffix', () => {
  const text = 'cat here and cat there';
  const anchor = { quote: 'cat', prefix: 'and ', suffix: ' there', start: 13, end: 16 };
  expect(A.locateQuote(text, anchor)).toEqual({ start: 13, end: 16 });
});

test('returns null when quote is absent', () => {
  const text = 'nothing to see';
  const anchor = { quote: 'absent phrase', prefix: '', suffix: '', start: 0, end: 5 };
  expect(A.locateQuote(text, anchor)).toBeNull();
});

test('empty quote → null', () => {
  expect(A.locateQuote('abc', { quote: '', start: 0, end: 0 })).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/anchor.test.js --runInBand`
Expected: FAIL — `Cannot find module` / `A.locateQuote is not a function`.

- [ ] **Step 3: Implement**

```javascript
// public/sdk/anchor.js
// Durable text anchoring shared by feedback.js (interactive) and preview.js
// (read-only). An anchor = { quote, prefix, suffix, start, end } where start/end
// are character offsets into the document's visible text. Resolution self-heals:
// exact offsets first, then unique-quote search, then prefix/suffix-scored search.
//
// Dual export: browser global window.FBAnchor + CommonJS for Jest. The pure core
// (locateQuote) has no DOM dependency and is unit-tested directly.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node/Jest
  if (root) root.FBAnchor = api;                                             // browser
})(typeof window !== 'undefined' ? window : null, function () {
  const CTX = 32; // chars of prefix/suffix context to capture

  // --- pure core: find the anchor's [start,end) in fullText ---
  function locateQuote(fullText, anchor) {
    const quote = anchor && anchor.quote ? String(anchor.quote) : '';
    if (!quote) return null;

    // 1. Exact offsets, confirmed by quote.
    if (Number.isInteger(anchor.start) && Number.isInteger(anchor.end) &&
        fullText.slice(anchor.start, anchor.end) === quote) {
      return { start: anchor.start, end: anchor.end };
    }

    // 2. Collect every occurrence of the quote.
    const hits = [];
    let i = fullText.indexOf(quote);
    while (i !== -1) { hits.push(i); i = fullText.indexOf(quote, i + 1); }
    if (hits.length === 0) return null;
    if (hits.length === 1) return { start: hits[0], end: hits[0] + quote.length };

    // 3. Multiple hits — score each by how well surrounding text matches
    //    the stored prefix/suffix, then by proximity to the original start.
    const prefix = anchor.prefix ? String(anchor.prefix) : '';
    const suffix = anchor.suffix ? String(anchor.suffix) : '';
    let best = null, bestScore = -Infinity;
    for (const h of hits) {
      const before = fullText.slice(Math.max(0, h - prefix.length), h);
      const after = fullText.slice(h + quote.length, h + quote.length + suffix.length);
      let score = commonSuffixLen(before, prefix) + commonPrefixLen(after, suffix);
      if (Number.isInteger(anchor.start)) score -= Math.abs(h - anchor.start) / 1e6; // tiny tiebreak
      if (score > bestScore) { bestScore = score; best = h; }
    }
    return best == null ? null : { start: best, end: best + quote.length };
  }

  function commonPrefixLen(a, b) {
    let n = 0; const m = Math.min(a.length, b.length);
    while (n < m && a[n] === b[n]) n++;
    return n;
  }
  function commonSuffixLen(a, b) {
    let n = 0; const m = Math.min(a.length, b.length);
    while (n < m && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
  }

  // --- DOM glue (browser only; guarded so Node require() is safe) ---

  // Concatenate visible text nodes under root, tracking each node's start offset.
  function textIndex(root) {
    const doc = root.ownerDocument || document;
    const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */, null);
    let text = '';
    const nodes = []; // { node, start, end }
    let n;
    while ((n = walker.nextNode())) {
      const start = text.length;
      text += n.nodeValue;
      nodes.push({ node: n, start, end: text.length });
    }
    return { text, nodes };
  }

  function offsetToPoint(nodes, offset) {
    for (const e of nodes) {
      if (offset >= e.start && offset <= e.end) return { node: e.node, offset: offset - e.start };
    }
    const last = nodes[nodes.length - 1];
    return last ? { node: last.node, offset: last.node.nodeValue.length } : null;
  }

  // Selection → anchor. Returns null for a collapsed/empty selection.
  function serializeSelection(range, root) {
    const { text, nodes } = textIndex(root);
    const map = new Map(nodes.map(e => [e.node, e.start]));
    function abs(container, off) {
      if (map.has(container)) return map.get(container) + off;
      // container is an element: fall back to the nearest text node boundary
      const walker = (root.ownerDocument || document).createTreeWalker(container, 4, null);
      const first = walker.nextNode();
      return first && map.has(first) ? map.get(first) : 0;
    }
    let start = abs(range.startContainer, range.startOffset);
    let end = abs(range.endContainer, range.endOffset);
    if (start > end) { const t = start; start = end; end = t; }
    const quote = text.slice(start, end);
    if (!quote.trim()) return null;
    return {
      quote,
      prefix: text.slice(Math.max(0, start - CTX), start),
      suffix: text.slice(end, end + CTX),
      start, end,
    };
  }

  // anchor → DOM Range (or null if unresolvable).
  function resolveAnchor(anchor, root) {
    const { text, nodes } = textIndex(root);
    if (!nodes.length) return null;
    const loc = locateQuote(text, anchor);
    if (!loc) return null;
    const startPt = offsetToPoint(nodes, loc.start);
    const endPt = offsetToPoint(nodes, loc.end);
    if (!startPt || !endPt) return null;
    const range = (root.ownerDocument || document).createRange();
    range.setStart(startPt.node, startPt.offset);
    range.setEnd(endPt.node, endPt.offset);
    return range;
  }

  return { locateQuote, serializeSelection, resolveAnchor, textIndex, CTX };
});
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest tests/anchor.test.js --runInBand`
Expected: PASS (5 tests). Only the pure core is exercised in Node; the DOM glue is validated later via manual/browser verification in Task 18.

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add public/sdk/anchor.js tests/anchor.test.js
git commit -m "feat(sdk): shared durable text-anchor module"
```

---

## Task 13: Load anchor.js ahead of the SDKs (inject.js)

Both `feedback.js` and `preview.js` depend on `window.FBAnchor`. Inject the
`anchor.js` tag immediately before each SDK tag.

**Files:**
- Modify: `src/services/inject.js` (`sdkScript`, `previewScript`)
- Test: `tests/inject.test.js` (extend)

- [ ] **Step 1: Write the failing test (append to tests/inject.test.js)**

```javascript
test('injectSdk loads anchor.js before feedback.js', () => {
  const result = injectSdk(BARE_HTML, 'p1', 'a@b.com');
  expect(result).toContain('/sdk/anchor.js');
  expect(result.indexOf('/sdk/anchor.js')).toBeLessThan(result.indexOf('/sdk/feedback.js'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/inject.test.js --runInBand`
Expected: FAIL — `/sdk/anchor.js` not present.

- [ ] **Step 3: Implement**

In `src/services/inject.js`, update `sdkScript` to prepend the anchor tag:

```javascript
function sdkScript(protoId, email) {
  return `<script src="/sdk/anchor.js"></script>\n`
    + `<script src="/sdk/feedback.js" data-proto-id="${escAttr(protoId)}" data-email="${encodeURIComponent(email)}"></script>`;
}
```

And `previewScript` likewise:

```javascript
function previewScript(protoId, highlightId, commentsJson) {
  return `<script src="/sdk/anchor.js"></script>\n`
    + `<script src="/sdk/preview.js" data-proto-id="${escAttr(protoId)}" data-highlight-comment="${escAttr(highlightId)}" data-comments="${escAttr(commentsJson)}"></script>`;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest tests/inject.test.js --runInBand`
Expected: PASS (existing 4 + new 1).

- [ ] **Step 5: Commit**

```bash
git add src/services/inject.js tests/inject.test.js
git commit -m "feat(inject): load shared anchor.js before feedback/preview SDKs"
```

---

## Task 14: feedback.js — selection → comment, highlight + margin marker

This is the largest client change. It has no Jest coverage (DOM/interaction);
correctness is verified in the browser (Task 18). Implement in focused edits.

**Files:**
- Modify: `public/sdk/feedback.js`

- [ ] **Step 1: Capture a text selection in Comment mode → open the draft card**

Add a `mouseup` listener (near the existing comment-mode click handler, ~line
1231). It must run BEFORE the click handler's element-pin path, so track a
"just made a selection" flag to suppress the element-pin click that follows.

```javascript
  /* ── comment mode: text selection → range draft ── */
  let rangeDraft = null;   // { anchor } for a pending selection comment
  let suppressNextClick = false;

  document.addEventListener('mouseup', () => {
    if (mode !== 'comment') return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    // Ignore selections inside our own UI.
    if (range.commonAncestorContainer.nodeType === 1 &&
        range.commonAncestorContainer.closest &&
        range.commonAncestorContainer.closest('#__fb-toolbar,#__fb-draft-card,#__fb-sidebar')) return;
    const anchor = window.FBAnchor && window.FBAnchor.serializeSelection(range, document.body);
    if (!anchor) return;
    rangeDraft = { anchor };
    draft = null;                 // ensure the element-pin draft path is inactive
    suppressNextClick = true;     // swallow the click that ends this mouseup
    openDraftCard('“' + anchor.quote.slice(0, 60) + (anchor.quote.length > 60 ? '…' : '') + '”');
    sel.removeAllRanges();
  });
```

In the existing comment-mode click handler (the `document.addEventListener('click', … , true)` at ~line 1231), bail early if we just handled a selection:

```javascript
  document.addEventListener('click', e => {
    if (mode !== 'comment') return;
    if (suppressNextClick) { suppressNextClick = false; e.preventDefault(); e.stopPropagation(); return; }
    if (e.target.closest('#__fb-draft-card') || e.target.closest('.fb-pin') || e.target.closest('.fb-cluster') || e.target.closest('#__fb-toolbar')) return;
    // … existing element-pin logic unchanged …
```

- [ ] **Step 2: Submit a range comment from the draft card**

The draft card's submit handler (~line 1299) currently always posts an `element`
comment. Branch on `rangeDraft`:

```javascript
  document.getElementById('__fb-draft-submit').addEventListener('click', async () => {
    const text = document.getElementById('__fb-draft-textarea').value.trim();
    if (!text) return;
    const btn = document.getElementById('__fb-draft-submit');
    btn.disabled = true;
    btn.textContent = 'Posting…';
    try {
      if (rangeDraft) {
        await postComment({
          type: 'range',
          comment: text,
          pageUrl: location.href,
          tag: rangeDraft.tagSel || null,
          anchor: rangeDraft.anchor,
          breadcrumb: navHistory,
        });
      } else if (draft) {
        await postComment({
          type: 'element',
          element: { selector: draft.selector, label: '', tagName: '' },
          comment: text, pageUrl: location.href, tag: draft.tag,
          xPct: draft.xPct, yPct: draft.yPct, breadcrumb: navHistory,
        });
      } else { btn.disabled = false; btn.textContent = 'Post comment'; return; }
      closeDraft();
      showToast('Comment posted.');
      await loadPins();
    } catch (_) {
      showToast('Failed to post comment.', true);
      btn.disabled = false;
      btn.textContent = 'Post comment';
    }
  });
```

Update `closeDraft` to also clear the range draft:

```javascript
  function closeDraft() {
    draft = null;
    rangeDraft = null;
    draftCard.classList.remove('visible');
  }
```

And the tag-row handler (~line 1283) must record the tag for a range draft too.
At the end of the click handler where it sets `draft.tag = t`, also set the range
selection:

```javascript
    if (!isActive) {
      pill.classList.add('active');
      pill.style.background = TAG_COLOR[t];
      pill.style.color = '#fff';
      if (draft) draft.tag = t;
      if (rangeDraft) rangeDraft.tagSel = t;
    } else {
      if (draft) draft.tag = null;
      if (rangeDraft) rangeDraft.tagSel = null;
    }
```

- [ ] **Step 3: Split pins into element pins vs range comments after load**

In `loadPins()` (~line 594), the response is split into `pins`/`generalComments`.
Separate range comments so they render differently:

```javascript
        const all = await resp.json();
        pins = all.filter(c => c.element_selector);
        rangeComments = all.filter(c => c.type === 'range' && c.anchor_quote);
        generalComments = all.filter(c => !c.element_selector && c.type !== 'range' && !c.parent_id);
```

Declare `let rangeComments = [];` in the state block (~line 542, near `let pins = []`).

- [ ] **Step 4: Render range highlights + margin markers**

Add a highlight layer + a render function driven by the same RAF loop. Add near
the pin container creation (~line 441):

```javascript
  const rangeLayer = document.createElement('div');
  rangeLayer.id = '__fb-ranges';
  rangeLayer.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483637';
  document.body.appendChild(rangeLayer);
```

Add a render function that resolves each anchor, wraps it in `<mark>`, and drops a
numbered marker in the left gutter. Call it from the RAF loop and after load:

```javascript
  function renderRangeLayer() {
    // Clear previous marks + markers.
    document.querySelectorAll('mark.__fb-mark').forEach(m => {
      const parent = m.parentNode; while (m.firstChild) parent.insertBefore(m.firstChild, m); parent.removeChild(m);
    });
    rangeLayer.innerHTML = '';
    if (mode === 'review' || mode === 'explain') return;

    rangeComments.forEach((c, idx) => {
      if (c.page_url && pageKeyOf(c.page_url) !== currentPageKey()) return;
      const anchor = { quote: c.anchor_quote, prefix: c.anchor_prefix, suffix: c.anchor_suffix, start: c.anchor_start, end: c.anchor_end };
      const range = window.FBAnchor && window.FBAnchor.resolveAnchor(anchor, document.body);
      if (!range) { c.__unresolved = true; return; }
      c.__unresolved = false;
      const color = TAG_COLOR[c.tag] || TAG_COLOR.other;
      // Wrap the range (may span nodes) in mark(s).
      let rect;
      try {
        const mark = document.createElement('mark');
        mark.className = '__fb-mark';
        mark.style.cssText = `background:${hexWithAlpha(color)};color:inherit;border-radius:2px;cursor:pointer`;
        mark.dataset.rangeId = c.id;
        range.surroundContents(mark);
        rect = mark.getBoundingClientRect();
        mark.addEventListener('click', ev => { ev.stopPropagation(); openRangePopover(c, mark); });
      } catch (_) {
        // surroundContents throws if the range partially selects a node; fall back
        // to a marker-only anchor at the range's client rect.
        rect = range.getBoundingClientRect();
      }
      // Margin marker in the left gutter.
      const marker = document.createElement('div');
      marker.className = 'fb-pin';
      // position:fixed → use viewport-relative rect.top directly (no scroll offset).
      marker.style.cssText = `left:8px;top:${rect.top}px;background:${color};pointer-events:auto;position:fixed`;
      marker.textContent = idx + 1;
      marker.addEventListener('click', ev => { ev.stopPropagation(); openRangePopover(c, marker); });
      rangeLayer.appendChild(marker);
    });
  }

  function hexWithAlpha(hsl) { return hsl.replace(')', ',0.28)').replace('hsl(', 'hsla('); }
```

> `openRangePopover(c, anchorEl)` reuses the existing popover markup. Implement it
> as a thin wrapper that builds the same `.fb-popover` content used by
> `renderPinEl` (tag, body, meta, replies, reply form, edit/delete within the
> edit window). To avoid duplicating ~80 lines, extract the popover-building
> portion of `renderPinEl` into a shared `buildPopover(comment)` helper and call
> it from both. Keep the existing pin behavior identical.

- [ ] **Step 5: Wire renderRangeLayer into the RAF loop + load + mode switch + nav**

- In `recomputePositions()` (end, before `rafId = requestAnimationFrame(...)`), call `renderRangeLayer()` when not in review/explain. (Cheap enough per frame; if perf matters, only re-run when scroll/resize changed — acceptable to call each frame for v1.)
- In `loadPins()` success path, after `renderSidebar()`, call `renderRangeLayer()`.
- In `setMode()`, after `renderPinLayer()`, call `renderRangeLayer()`.
- In `recordNav()`, after `renderPinLayer()`, call `renderRangeLayer()`.

- [ ] **Step 6: Show range comments in the sidebar Pins tab**

In `renderSidebar()` (~line 629), include resolved range comments in the list.
Build a combined array of element pins + range comments for the current page,
each rendered as a `fb-sidebar-pin-row`. For range rows, the body preview is the
comment text and clicking scrolls to the mark (or greys out if `__unresolved`).
Add, after the `pagePins.forEach(...)` block, a `rangeComments` loop that appends
rows with the same markup, and for unresolved ones add a muted "text no longer
present" note. Update the badge counts to include range comments.

- [ ] **Step 7: Lint**

Run: `npm run lint`
Expected: clean (fix any unused-var / style issues the linter flags).

- [ ] **Step 8: Commit**

```bash
git add public/sdk/feedback.js
git commit -m "feat(sdk): text-selection comments — highlight, margin marker, sidebar"
```

---

## Task 15: Admin preview — render Markdown + read-only range highlights

The admin preview (`GET /admin/prototypes/:id/preview`) currently serves the raw
published file and injects `preview.js`. It must render Markdown the same way as
delivery, include range-comment anchor data, and `preview.js` must draw read-only
highlights + markers.

**Files:**
- Modify: `src/routes/admin.js:354-383` (preview handler)
- Modify: `public/sdk/preview.js`

- [ ] **Step 1: Render Markdown + select anchor fields in the preview handler**

In `src/routes/admin.js`, the preview route reads `proto.filename` and injects.
Update it to (a) render markdown, (b) select the anchor columns. Add `markdown`
to the requires (`const markdown = require('../services/markdown');`) and replace
the body of `GET /prototypes/:id/preview`:

```javascript
router.get('/prototypes/:id/preview', orgs.requireOrg, async (req, res) => {
  const proto = await getOrgPrototype(req.params.id, req.orgId);
  if (!proto) return res.status(404).send('Prototype not found.');
  if (path.basename(proto.filename) !== proto.filename) return res.status(400).send('Invalid prototype filename.');
  const raw = await storage.getPrototype(proto.filename);
  if (raw === null) return res.status(404).send('Prototype file not found.');

  const highlightId = req.query.comment || '';
  const { rows: allCommentRows } = await getDb().query(
    `SELECT id, email, type, element_selector, element_label, comment, created_at, tag, x_pct, y_pct, page_url, parent_id,
            anchor_quote, anchor_prefix, anchor_suffix, anchor_start, anchor_end
     FROM comments WHERE prototype_id = $1
     ORDER BY created_at ASC`,
    [proto.id]
  );

  const replyMap = {};
  allCommentRows.filter(r => r.parent_id).forEach(r => {
    if (!replyMap[r.parent_id]) replyMap[r.parent_id] = [];
    replyMap[r.parent_id].push({ id: r.id, email: r.email, comment: r.comment, created_at: r.created_at });
  });
  const comments = allCommentRows
    .filter(r => !r.parent_id)
    .map((r, i) => ({ ...r, order: i + 1, replies: replyMap[r.id] || [] }));

  let documentHtml = raw;
  if ((proto.content_type || 'html') === 'markdown') {
    const { html } = markdown.render(raw);
    documentHtml = readView('markdown-shell.html').split('{{content}}').join(html);
  }

  const html = injectPreview(documentHtml, proto.id, highlightId, JSON.stringify(comments));
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
});
```

> `getOrgPrototype(req.params.id, req.orgId)` returns `*`, so `proto.content_type`
> is available. `readView` and `markdown` are module-scope in admin.js after the
> require is added.

- [ ] **Step 2: preview.js — draw read-only range highlights + markers**

In `public/sdk/preview.js`, after the existing pin setup, add a pass over range
comments that resolves each anchor and wraps it in a non-interactive `<mark>`
plus a numbered gutter marker whose click shows the same tooltip as pins:

```javascript
  // Range (text-selection) comments — read-only highlights + gutter markers.
  const rangeComments = comments.filter(c => c.type === 'range' && c.anchor_quote);
  function renderRanges() {
    document.querySelectorAll('mark.__fb-mark').forEach(m => {
      const p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m);
    });
    rangeComments.forEach(c => {
      const anchor = { quote: c.anchor_quote, prefix: c.anchor_prefix, suffix: c.anchor_suffix, start: c.anchor_start, end: c.anchor_end };
      const range = window.FBAnchor && window.FBAnchor.resolveAnchor(anchor, document.body);
      if (!range) return;
      try {
        const mark = document.createElement('mark');
        mark.className = '__fb-mark';
        const color = pinColor(c.tag);
        mark.style.cssText = `background:${color.replace('hsl(', 'hsla(').replace(')', ',0.28)')};border-radius:2px;cursor:pointer`;
        range.surroundContents(mark);
        mark.addEventListener('click', e => { e.stopPropagation(); showTooltip(c, mark); });
      } catch (_) { /* partial-node range: skip highlight, pin list still shows it */ }
    });
  }
  // Run after the DOM/markdown has settled; retry a couple of frames like pins do.
  requestAnimationFrame(() => requestAnimationFrame(renderRanges));
```

> `showTooltip(c, el)` already exists and positions relative to any element —
> reuse it directly.

- [ ] **Step 3: Lint + commit**

```bash
npm run lint
git add src/routes/admin.js public/sdk/preview.js
git commit -m "feat(preview): render markdown + read-only range highlights"
```

---

## Task 16: MCP client — infer MIME from filename

**Files:**
- Modify: `mcp/lib/client.cjs:52`

- [ ] **Step 1: Replace the hardcoded MIME**

The push helper hardcodes `type: 'text/html'`. Infer from the filename extension:

```javascript
    const isMd = /\.(md|markdown)$/i.test(filename || '');
    const mime = isMd ? 'text/markdown' : 'text/html';
    form.append('file', new Blob([buffer], { type: mime }), filename || 'prototype.html');
```

- [ ] **Step 2: Verify the MCP package still loads / tests pass**

Run:
```bash
cd mcp && npm test 2>/dev/null || echo "no mcp tests — verify require() loads"; node -e "require('./lib/client.cjs');console.log('ok')"; cd ..
```
Expected: `ok` (module loads). If the mcp package has its own tests, they pass.

- [ ] **Step 3: Commit**

```bash
git add mcp/lib/client.cjs
git commit -m "feat(mcp): infer upload MIME from filename (.md support)"
```

---

## Task 17: Full suite + lint gate

**Files:** none (verification task)

- [ ] **Step 1: Run the whole suite**

Run: `npm run check`
Expected: lint clean; all tests PASS (or SKIP where `DATABASE_URL` is unset).
If a DB is available locally, ensure the new schema/api/delivery/upload tests run
and pass — set `DATABASE_URL` to a scratch Postgres if needed.

- [ ] **Step 2: Commit any lint fixes**

```bash
git add -A
git commit -m "chore: lint + full-suite green for markdown feature" || echo "nothing to commit"
```

---

## Task 18: Manual browser verification (definition of done)

**Files:** none (manual). Use the `run` skill / a local server with a scratch DB.

- [ ] **Step 1: Start the app** with `DATABASE_URL` pointing at a scratch Postgres and Supabase creds absent (local-disk fallback). `npm start`.

- [ ] **Step 2: Upload a `.md`** via `/admin/upload` (a doc with headings, a list, a table, a code block, bold text). Confirm it saves and a share link is generated.

- [ ] **Step 3: Open the share link, enter an allowlisted email**, confirm the Markdown renders as a styled document (shell typography) with the feedback toolbar on top.

- [ ] **Step 4: Comment mode → select a sentence with the mouse.** Confirm the draft card opens showing the quoted text; pick a tag; post. Confirm a colored highlight + numbered gutter marker appear on the passage.

- [ ] **Step 5: Hover/click the highlight and the marker** → popover with tag/body/author; add a reply; confirm it appears. Confirm edit/delete within 5 minutes works.

- [ ] **Step 6: Reload the page** → the highlight + marker reappear on the same text (anchor resolves). Confirm the sidebar Pins tab lists the range comment and clicking it scrolls to the highlight.

- [ ] **Step 7: Repeat selection commenting on an HTML prototype** (upload an `.html`) → confirm text-selection comments work there too, coexisting with element pins (click an element → pin; select text → range).

- [ ] **Step 8: Admin preview** (`/admin/prototypes/:id` → preview) → confirm the Markdown renders and range highlights + pins show read-only, and the tooltip opens on click.

- [ ] **Step 9: Edit the document to remove the anchored text, publish a new version** → confirm the range comment survives, appears greyed in the sidebar as "text no longer present," and no incorrect highlight is drawn.

---

## Self-review checklist (author-run after writing)

- [ ] Every spec section maps to a task (rendering, anchoring, parity, both doc types, MCP, tests, edge cases).
- [ ] No placeholders — every code step shows real code.
- [ ] Type/name consistency: `content_type` column, `contentTypeForFilename`/`extForContentType`/`mimeForContentType`, `resolvePublished` (new) vs `resolvePublishedFile` (kept), `FBAnchor.serializeSelection`/`resolveAnchor`/`locateQuote`, `type:'range'`, `anchor_*` columns — used identically across tasks.
- [ ] Edge cases covered: unresolvable anchor (grey-out), partial-node range (surroundContents fallback), `.txt` rejection, empty markdown.
