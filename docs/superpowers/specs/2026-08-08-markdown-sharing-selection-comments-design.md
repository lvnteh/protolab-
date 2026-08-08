# Markdown Sharing + Text-Selection Commenting — Design

**Date:** 2026-08-08
**Status:** Approved (design), pending implementation plan

## Summary

Add two capabilities to proto-share:

1. **Markdown (`.md`) file sharing.** Admins can upload a `.md` file; the system
   renders it server-side into a styled, readable HTML document for viewers.
2. **Text-selection commenting.** Viewers can select a passage of text with the
   mouse and leave a comment anchored to that passage. This works on **both**
   rendered-Markdown documents and existing HTML documents, as a new commenting
   method *alongside* the current element pins and general comments.

The raw uploaded file (`.md` or `.html`) remains the source of truth. Markdown
is rendered to HTML at **view time**, then the existing feedback SDK is injected
unchanged — so the whole reviewer UI (toolbar, sidebar, pins, replies, explain
mode) works on Markdown documents with no SDK awareness of the source format.

## Product decisions (locked during brainstorming)

- **Where Markdown is rendered:** server-side, at view time (raw `.md` is source
  of truth; restyling never requires re-upload).
- **How a selection comment appears afterward:** persistent tag-colored text
  highlight **plus** a numbered margin marker; hovering/clicking either opens the
  comment popover.
- **Feature parity:** text-selection comments reuse the **full** existing pin
  feature set — tags (bug/copy/question/idea/other), threaded replies, 5-minute
  edit/delete window, sidebar listing, version stamping, resolution.
- **Comment methods on a Markdown doc:** text-selection **+** element pins **+**
  general comments (all three available).
- **Anchoring model:** robust anchor — quote + prefix/suffix + character offsets,
  resolved by offset, verified by quote, with context-search fallback
  (W3C Web Annotation / Hypothesis style). Self-healing across re-renders and
  versions.
- **Markdown stack:** `markdown-it` (`html: false`) + `sanitize-html`
  (pure-Node, no jsdom).

## Architecture

### File-type model

A prototype's rendering behavior is determined by its file's extension, captured
as a `content_type` of `'html'` | `'markdown'`. Because a *version* owns a file,
`content_type` lives on `prototype_versions` (authoritative) and is mirrored onto
`prototypes` for convenience (the published version's type).

- Upload derives the extension and `content_type` from the uploaded filename.
- Stored filename becomes `${id}.md` / `${versionId}.md` for Markdown (mirrors the
  existing `${id}.html` convention).
- All existing rows default to `'html'` — no backfill required.

### Delivery pipeline

The only structural change is one branch in `GET /p/:token/view`
(`src/routes/delivery.js`):

```
resolve published version + file
  content_type === 'markdown':
      raw .md
        → markdown.render()            // markdown-it (html:false) → sanitize-html
        → wrap in markdown-shell.html  // typographic document shell, {{content}}
        → injectSdk()                  // UNCHANGED: splice feedback.js before </body>
  else (html):
      raw html → injectSdk()           // exactly as today
serve as text/html; charset=utf-8
```

Markdown becomes a complete HTML document *before* `injectSdk` runs, so
`inject.js` and `feedback.js` remain untouched.

### New modules (small, single-purpose)

- **`src/services/markdown.js`** — `render(rawMd) → { html }`. Pure function, no
  DB. `markdown-it` with `html: false` (raw HTML in the `.md` is ignored), then
  `sanitize-html` on the output as defense-in-depth (allow standard formatting
  tags + tables + task-list checkboxes; strip scripts, event handlers, and
  `javascript:` URLs).
- **`src/views/markdown-shell.html`** — the document wrapper with readable
  typographic CSS (max-width column; styled headings, code blocks, tables,
  blockquotes, lists, task lists). Single `{{content}}` placeholder.
- **`public/sdk/anchor.js`** — the range anchoring resolver, framework-free, no
  dependencies. Shared by `feedback.js` (interactive) and `preview.js`
  (read-only admin preview). Two entry points:
  - `serializeSelection(range, root) → anchor` — walk text nodes under `root`
    (document body), compute `start`/`end` char offsets in the concatenated
    visible text, capture `quote`, `prefix` (~32 chars before), `suffix`
    (~32 chars after).
  - `resolveAnchor(anchor, root) → Range | null` — (1) try exact `start`/`end`,
    confirm text equals `quote`; (2) on drift, search document text for `quote`
    (single hit → use it; multiple → pick the occurrence whose surrounding text
    best matches `prefix`/`suffix`); (3) unresolvable → `null`.

## Data model

All migrations are idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` /
atomic constraint drop+add in `initDb()`, following the established
`owner_id` / `org_id` / `parent_id` patterns.

### `content_type`

```sql
ALTER TABLE prototype_versions
  ADD COLUMN IF NOT EXISTS content_type TEXT NOT NULL DEFAULT 'html';
ALTER TABLE prototypes
  ADD COLUMN IF NOT EXISTS content_type TEXT NOT NULL DEFAULT 'html';
```

### Range comments reuse the `comments` table

Text-selection comments are a new `type = 'range'`. Widen the type CHECK
(atomic drop + add, exactly as done for `'reply'`):

```sql
CHECK (type IN ('general', 'element', 'reply', 'range'))
```

Add nullable anchor columns (harmless to all existing rows):

```sql
ALTER TABLE comments ADD COLUMN IF NOT EXISTS anchor_quote  TEXT;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS anchor_prefix TEXT;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS anchor_suffix TEXT;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS anchor_start  INTEGER;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS anchor_end    INTEGER;
```

Field usage by comment type:

| type    | element_selector / x_pct / y_pct | anchor_* | parent_id | tag | version_id |
|---------|----------------------------------|----------|-----------|-----|------------|
| general | —                                | —        | —         | —   | ✓          |
| element | ✓                                | —        | —         | ✓   | ✓          |
| range   | —                                | ✓        | —         | ✓   | ✓          |
| reply   | —                                | —        | ✓         | —   | ✓          |

Reusing the table gives replies, tags, resolution, and version stamping to range
comments with no extra work. `type` disambiguates rendering.

## API changes (backward-compatible)

- **`POST /api/comments`** accepts `type: 'range'` plus an `anchor` object
  (`{ quote, prefix, suffix, start, end }`). Validation: a range comment requires
  a non-empty `quote`; missing anchor → 400. Element/general/reply payloads
  unchanged.
- **`GET /api/comments/:prototypeId`** and the admin preview comment query select
  the new `anchor_*` columns and include them on range rows.
- Authorization, org-scoping, reply rules, edit window, and resolution are all
  unchanged (inherited by living in the same table + endpoints).

## Viewer & admin UX

### Selection commenting (HTML and rendered Markdown)

- In **Comment mode**, releasing a non-collapsed text selection (mouseup) opens
  the **same draft card** used for element pins (tag pills + textarea + Post),
  with the quoted text shown in the selector line. Element-click and text-select
  coexist: a click with no selection → element pin; a selection → range comment.
- After posting: the passage gets a **persistent highlight** in the comment's tag
  color, and a **numbered margin marker** in the left gutter aligned to the
  selection's top. Hovering/clicking either opens the popover (tag, body, author,
  replies, reply box, edit/delete within 5 min) — identical to pin popovers.
- The **sidebar Pins tab** lists range comments alongside element pins (number,
  body preview, reply count). Clicking a row scrolls to and pulses the highlight,
  reusing the existing focus mechanism generalized to a "focus target."
- **Rendering:** highlights wrap the resolved `Range` in `<mark>` segments
  (splitting across element boundaries as needed); markers live in a fixed gutter
  layer (like `#__fb-pins`), repositioned each RAF frame from the Range's
  `getBoundingClientRect()`.
- **Unresolved anchors:** if `resolveAnchor` returns null (text gone after an
  edit/new version), the comment still appears in the sidebar, greyed, labeled
  "text no longer present." Feedback is never lost and never mis-highlighted.

### Rendered-Markdown reading experience

`markdown-shell.html` provides clean document typography (max-width column,
styled headings/code/tables/blockquotes/task-lists) so a shared `.md` reads like
a formatted document.

### Admin side

- **Upload** (`admin-upload.html` + `POST /admin/prototypes` + `apiV1.js`):
  accept `.html,.md`; multer `fileFilter` allows both; filename extension and
  `content_type` derived from the upload; UI label / `accept` / hint updated to
  "HTML or Markdown".
- **Admin preview** (`/prototypes/:id/preview` + `preview.js`): renders Markdown
  the same way; shows read-only range highlights + markers next to existing pins.
- **Storage** (`storage.js`): accept a content type argument instead of
  hardcoding `text/html` (`text/markdown` for `.md`).
- **MCP `protoshare_push`** (`mcp/lib/client.cjs`): infer MIME/extension from the
  local filename rather than hardcoding `text/html`, so the local-AI push path
  round-trips `.md`.

## Testing

Follows existing Jest + supertest patterns.

- **`markdown.test.js`** (new): `render()` output for headings/lists/tables/code;
  `html:false` drops raw HTML; sanitizer strips `<script>`/`onclick`/
  `javascript:`; empty/large input.
- **`anchor.test.js`** (new): serialize→resolve round-trip; exact-offset hit;
  drift recovery via quote search; duplicate-quote disambiguation via
  prefix/suffix; unresolvable → null. (Extract the string-search core so it is
  testable in Node without a full DOM.)
- **`delivery.test.js`** (extend): `.md` upload → `/p/:token/view` returns
  rendered, sanitized, SDK-injected HTML as `text/html`; `.html` path unchanged.
- **`api.test.js`** (extend): `POST` `type:'range'` persists all `anchor_*`
  columns; `GET` returns them; range comments accept replies/tags; a range
  comment with no anchor is rejected.
- **Upload tests** (extend): `.md` accepted; `.txt`/`.png` still rejected;
  filename gets `.md`; `content_type='markdown'` stored.
- **`inject.test.js`**: unchanged (still HTML-in / HTML-out).

## Edge cases

- Selection spanning multiple block/inline elements → multi-segment `<mark>`
  wrapping; anchor uses plaintext offsets, so tag structure is irrelevant.
- Selection inside a code block → allowed; quote preserved verbatim.
- Re-render / new version shifts text → resolver self-heals or greys out the
  marker (never silently mis-highlights, never loses the comment).
- Sanitizer removes an element a legacy element-pin selector pointed to →
  unchanged from today (pin greys out).
- Markdown containing raw HTML → ignored by `html:false` and stripped by the
  sanitizer (safe by default). Deliberate limitation, not a bug.

## Scope boundaries (explicitly NOT in this feature)

- No rich-text/WYSIWYG editing of Markdown in-app; upload-only, like HTML.
- No file types beyond `.md` (no PDF/docx).
- No live collaborative cursors / real-time presence.
- No change to the anchoring model for existing element pins (they stay
  selector + percentage; only new range comments use anchors).
- No image upload/embedding pipeline for Markdown; relative image links won't
  resolve (documents should use absolute URLs). Noted limitation.

## Impact map (files touched)

| File | Change |
|------|--------|
| `src/db.js` | `content_type` columns; widen comment type CHECK; anchor columns |
| `src/services/markdown.js` | **new** — render + sanitize |
| `src/views/markdown-shell.html` | **new** — document shell |
| `public/sdk/anchor.js` | **new** — shared anchor serialize/resolve |
| `src/routes/delivery.js` | branch on `content_type`; render Markdown before inject |
| `src/routes/admin.js` | accept `.md`; derive extension + `content_type`; upload copy |
| `src/routes/apiV1.js` | accept `.md`; derive extension + `content_type` |
| `src/routes/api.js` | `type:'range'` + anchor persistence and read |
| `src/services/storage.js` | content-type argument (not hardcoded `text/html`) |
| `src/services/versions.js` | carry `content_type` through version creation |
| `public/sdk/feedback.js` | selection → draft; highlight + marker render; sidebar |
| `public/sdk/preview.js` | read-only range highlights + markers |
| `src/views/admin-upload.html` | `accept=".html,.md"`, label + hint copy |
| `mcp/lib/client.cjs` | infer MIME/extension from filename |
| `package.json` | add `markdown-it`, `sanitize-html` |
| `tests/*` | new + extended tests above |
