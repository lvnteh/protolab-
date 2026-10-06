# GitHub-Backed `.md` Docs Review + Commit-Comment Annotations

**Date:** 2026-10-06
**Status:** Design — approved for planning
**Project:** proto-share (Express 5 + Postgres, CommonJS, Node 22)

## Purpose

Add a **separate workflow** to ProtoLab for reviewing internal `.md` documents
that live in a GitHub repository, independent of the existing prototype
upload/delivery path. A reviewer browses the repo's `.md` files in a folder
tree, reads a rendered document, selects text, and leaves annotations
(questions, change-requests, suggested deletions, notes). Each annotation is
persisted **only on GitHub, as a commit comment** anchored to the exact commit
the document was at — so as a document evolves through commits, each committed
state carries its own, independent set of annotations.

The reference UX is the local `md-preview` tool (`cli/md-preview`, served at
`localhost:3456`): folder tree on the left, rendered document in the middle.
ProtoLab improves on it by injecting its **own** range-anchor review SDK (no
browser extension to install) and by persisting feedback to GitHub rather than
to an external listener.

### Who it is for / success criteria

- **Document authors + engineers** collaborating on internal `.md` docs in a git
  repo, who want reviewer feedback to live in GitHub where they already work.
- Success = a reviewer can open a repo's doc tree locally, annotate a rendered
  `.md` at its current committed version, and have those annotations appear as
  GitHub commit comments anchored to `(commit, path, line)` — with ProtoLab able
  to re-render the exact highlighted span when the doc is reopened at that
  commit. A later commit that changes the file presents a clean, separate
  annotation set.

## Locked decisions

| # | Decision |
|---|----------|
| 1 | **Separate workflow.** New `/docs` route group + new services. The existing prototype/upload/delivery path is untouched. |
| 2 | **Version identity = git commit SHA.** A document's version is its content at a commit; a comment pins to `(repo, path, commit SHA, anchor)`. A file's "current version" = the commit that last modified it (`git log -1 -- <path>`). |
| 3 | **GitHub is the single store** for annotations, as **commit comments** (native `(commit, path, line)` anchoring, no PR required). ProtoLab persists **no** comment state for this workflow. |
| 4 | **Operator's GitHub token** authors the comments (from `gh auth token` or `GITHUB_TOKEN`/`DOCS_GITHUB_TOKEN`). Comments are authored as that real GitHub user. Token stays server-side. |
| 5 | **Local-first now, hosted later.** Runs on the operator's machine against a local clone; repo-source and auth are behind interfaces so a hosted server-clone / per-user-OAuth mode can be added without reshaping the data model. |
| 6 | **Rendered view** (not raw). Reviewers comment on rendered HTML; a rendered→raw line-mapping layer (`data-source-line` from markdown-it `token.map`) yields the exact raw-file line GitHub needs. |
| 7 | **Annotate + typed change-requests.** Action kinds: `question`, `change-request`, `delete` (suggest deletion), `note`. All are plain text sent to GitHub, typed via the comment-body codec. |
| 8 | **Dirty working tree:** render the *committed* SHA's content (not unsaved edits) with a banner; comments always attach to a real commit, so rendered content never mismatches the anchor. |
| 9 | **No new runtime dependency:** `ghComments` uses Node 22 global `fetch` (consistent with the existing MCP client), not `@octokit/rest`. |

## Scope

**In v1:**
- Browse a local clone's `.md` files as a folder tree.
- Render a selected doc (reusing `markdown.js`) at its current committed version,
  or an older version via `?sha=`.
- Select text → annotate (question / change-request / delete / note) → persisted
  as a GitHub commit comment anchored to `(sha, path, line)`.
- Read existing commit comments for `(sha, path)` back and render them
  (highlight + sidebar), re-anchoring exactly from ProtoLab's embedded metadata.
- Delete an annotation (own comment) via GitHub.
- Flat replies (commit comments do not thread natively) via a `replyTo` field in
  the body codec.
- SSE live-reload when a local file changes.

**Out of v1 (interfaces leave the door open):**
- In-place editing of the `.md` and committing back to the repo.
- md-preview's domain-specific action providers (table-cell roles, evaluation
  matrix, mark-as-proposal) and LLM ("submit to pi") submission.
- Two-way sync: comments authored natively on GitHub are shown read-only; they
  are not merged/round-tripped beyond display.
- Hosted mode (server-side clone on a persistent volume; per-user OAuth).

## Architecture & components

New, isolated units — each small, single-purpose, and testable in isolation:

### `src/services/docSource.js` — local git reader (interface)
Reads the configured local clone. Plain `git` CLI calls via `child_process`.
- `listTree()` → nested tree of `.md` entries `{ path, title, versionSha }`
  (glob `**/*.md`; ignore `README.md`/`CLAUDE.md`; `title` from a minimal
  front-matter reader — a small local parser, no new dependency per decision 9,
  falling back to the filename).
- `resolveVersionSha(path)` → `git log -1 --format=%H -- <path>` (null if the
  file was never committed).
- `readDoc(path, sha?)` → `{ raw, versionSha, dirty }`. `raw` is the content at
  `sha` (default = `resolveVersionSha(path)`) via `git show <sha>:<path>`;
  `dirty` = working tree has uncommitted changes for `path`.
- `recentVersions(path)` → `git log --format=... -- <path>` for the switcher.
- `repoSlug()` → `owner/repo` parsed from the `origin` remote URL.

The interface is what a future hosted/server-clone or GitHub-API implementation
replaces; routes depend only on this surface.

### `src/services/ghComments.js` — commit-comments client + codec (interface)
GitHub REST via global `fetch`, operator token in the `Authorization` header.
- `list(sha, path)` → ProtoLab comment objects. Fetches
  `GET /repos/{owner}/{repo}/commits/{sha}/comments`, filters to `path`, parses
  the embedded codec block (see below). Comments without a block degrade to a
  line-anchored, non-highlighted entry.
- `post(sha, { path, line, body })` → `POST .../commits/{sha}/comments`.
- `del(id)` → `DELETE .../comments/{id}`.
- **Body codec** (encode/parse) — a pure, separately unit-tested function pair.

### `src/routes/docs.js` — `/docs` (thin translators)
- `GET /docs` → `docSource.listTree()` → `docs-shell.html` tree pane.
- `GET /docs/view?path=&sha=` → `readDoc` → `markdown.render(raw, { sourceLines:true })`
  → shell + injected SDK (+ dirty banner, version switcher). CSP as per the
  existing markdown view.
- `GET /docs/comments?path=&sha=` → `ghComments.list` (JSON for the SDK).
- `POST /docs/comments` `{ path, sha, line, kind, text, anchor, replyTo? }` →
  `ghComments.post` → created comment.
- `DELETE /docs/comments/:id` → `ghComments.del`.

### Reused / extended
- **`src/services/markdown.js`**: add opt-in `render(raw, { sourceLines })` that
  injects `data-source-line="<n>"` on block-level open tokens (from markdown-it
  `token.map[0] + 1`) and adds `data-source-line` to the sanitize allowlist for
  those tags. **Default off** — existing prototype rendering is byte-identical.
- **Range-anchor SDK** (`public/sdk/*`): a "docs" mode reusing selection capture,
  highlight rendering, and the sidebar. New behavior: on selection, walk to the
  nearest `data-source-line` ancestor to compute the GitHub line; action menu
  offers the four kinds; posts/reads via `/docs/comments`.
- **`docs-shell.html`**: 3-pane layout (tree | rendered doc | annotation sidebar).

## Versioning semantics

- The version a comment binds to is always a **committed** SHA. Default view =
  `resolveVersionSha(path)` (the file's last-touching commit).
- `?sha=<sha>` renders that historical version (`git show <sha>:<path>`) and shows
  that commit's annotations. A switcher lists `recentVersions(path)`.
- A **never-committed** file (no SHA) is viewable but **not commentable**: the SDK
  disables the action menu with "commit this file before annotating."
- **Dirty working tree** (uncommitted edits to the path): the center pane renders
  the committed SHA's content, with a banner noting local edits are hidden and
  comments attach to `<sha7>`. This guarantees rendered content matches the
  anchor commit.

## Comment codec

A commit comment body is the reviewer's text followed by one machine block:

```
<reviewer message>

<!-- protoshare:v1 {"kind":"question|change-request|delete|note",
  "anchor":{"quote":"…","prefix":"…","suffix":"…","start":N,"end":M},
  "tag":"…?","replyTo":"<commentId>?"} -->
```

- `kind` drives sidebar styling/labels; `anchor` is ProtoLab's existing durable
  text anchor (used to re-highlight the exact span on re-render); `replyTo`
  threads flat commit comments; `tag` optional.
- `line` is sent to GitHub as the native anchor; it is derived, not stored in the
  block (the block is content-anchored, resilient to line drift within a commit).
- Parsing is tolerant: a missing/invalid block ⇒ a line-anchored, non-highlighted
  comment (covers comments authored directly on GitHub). The parser never throws
  on third-party content.

## Data flow

1. **Browse** — `GET /docs` → `listTree()` → tree pane.
2. **View** — `GET /docs/view?path=&sha=` → `readDoc` → `markdown.render(…, {sourceLines:true})`
   → shell + SDK. SDK calls `GET /docs/comments?path=&sha=` → `ghComments.list`
   → highlights + sidebar.
3. **Annotate** — selection → nearest `data-source-line` ⇒ raw line; build anchor;
   `POST /docs/comments` → `ghComments.post` → SDK inserts the returned comment.
4. **Delete** — `DELETE /docs/comments/:id` → `ghComments.del`.

## UX / layout

Three panes: **folder tree | rendered document | annotation sidebar**. Tree is
nested from the git file list, labelled by frontmatter `title`. A version
indicator shows the current short SHA with a switcher over recent commits. The
selection menu offers Question / Request change / Suggest deletion / Note. SSE
live-reload refreshes the view when the underlying local file changes.

## Errors & security

- **No token** → a clear setup message (how to `gh auth login` or set the env var).
- **Not a git repo / bad `DOCS_REPO_PATH`** → startup/route error with guidance.
- **Never-committed file** → commenting disabled with an explanation.
- **GitHub API / rate-limit error** → non-destructive toast; the draft annotation
  stays in the composer so nothing is lost.
- **`git show` miss** (bad path/sha) → 404.
- **Security**: operator token is read server-side from env/`gh` and never sent to
  the browser; `owner/repo` is pinned to the clone's `origin` remote (no
  arbitrary-repo posting); markdown is sanitized and the view carries the same CSP
  as the existing markdown delivery.

## Configuration

- `DOCS_REPO_PATH` — absolute path to the local clone (required to enable `/docs`).
- `DOCS_GITHUB_TOKEN` / `GITHUB_TOKEN` — fallback to `gh auth token` if unset.
- `owner/repo` — derived from the clone's `origin` remote (no separate config).
- The `/docs` routes mount only when `DOCS_REPO_PATH` is set, so the feature is
  opt-in and the existing app is unaffected when it is absent.

## Interfaces for hosted-later

- `docSource` interface: local-git implementation now; a server-clone (persistent
  volume + scheduled/webhook `git pull`) or GitHub-contents-API implementation
  later, with no change to routes or the comment model.
- Auth: operator-token now; per-user GitHub OAuth later, isolated behind a
  token-resolution function.
- `ghComments` is mode-agnostic and unchanged across local/hosted.

## Testing

- **`docSource`** — unit tests over a temp git-repo fixture (init, commit, edit,
  dirty): `listTree`, `resolveVersionSha`, `readDoc` at HEAD and an older sha,
  dirty detection, `repoSlug` parsing (ssh + https remotes).
- **Codec** — pure round-trip encode→parse tests, plus tolerant-parse tests
  (missing block, malformed JSON, extra GitHub text).
- **`ghComments`** — against a fake `fetch` (mirrors the existing MCP client test
  pattern): list filtering by path, post payload shape, delete, degrade-on-no-block.
- **Routes** — supertest with `docSource` + `ghComments` mocked; no live GitHub.
- **`markdown` sourceLines** — blocks carry correct `data-source-line`; sanitize
  keeps the attribute; default-off path unchanged.
- **SDK** — DOM anchor + source-line resolution unit tests (following the existing
  anchor test suite).
- **No live GitHub calls in any test.**

## Open questions / future

- Hosted mode: persistent clone lifecycle, per-user OAuth, accountless-reviewer
  attribution (bot token + name-in-body).
- Two-way sync of GitHub-native comments beyond read-only display.
- In-place editing + commit as its own project.
