# Docs Repo Switcher — Add-by-URL, Per-Org Registry, GitHub-API Source

**Date:** 2026-10-06
**Status:** Design — approved for planning
**Project:** proto-share (Express 5 + Postgres, CommonJS, Node 22)
**Builds on:** `2026-10-06-github-docs-annotations-design.md` (the `/docs` workflow)

## Purpose

Let users point the `/docs` workflow at **multiple GitHub repositories**, added
**by URL** and remembered across sessions, and switch between them in-app —
running **identically on a local machine and on hosted Railway**. This replaces
the v1 model where `/docs` read a single local git clone fixed at startup via
`DOCS_REPO_PATH`.

The enabling change: files are read through the **GitHub API** instead of a local
clone. "Add a repo" becomes *validate + register* `owner/repo` (no cloning), so
there is nothing to keep on disk — which is what makes local and Railway behave
the same with no persistent volume.

### Who it is for / success criteria

- A reviewer (local or hosted) can **add a GitHub repo by URL**, see it persist
  in a **per-org repo list**, **switch** between repos, browse each repo's `.md`
  tree, and comment — with comments still stored as GitHub commit comments.
- Success = adding `https://github.com/acme/widgets` registers it for the org,
  it survives restarts, appears in the switcher, and its docs render + annotate
  exactly like the v1 single-repo flow — on both local and Railway, with only a
  GitHub token configured.

## Locked decisions

| # | Decision |
|---|----------|
| 1 | **Files read via the GitHub API everywhere** (trees/contents/commits). No clones, no disk, no Railway volume. The v1 local-clone reader is retired for docs. |
| 2 | **Add-by-URL = register, not clone.** Validate the URL is github.com, parse `owner/repo`, verify access via `GET /repos/{owner}/{repo}`, then store. |
| 3 | **Per-org registry.** Repos are scoped to the active organization (reuses existing multi-tenancy). Persisted in a new `docs_repos` Postgres table. |
| 4 | **`/docs` is login-gated.** Viewing requires `requireOrg`; adding/removing repos requires `requireAdmin`. (Closes the v1 gap where `/docs` was unauthenticated.) |
| 5 | **Single configured GitHub token** (`DOCS_GITHUB_TOKEN` → `GITHUB_TOKEN`) for both local and hosted, behind a token-resolution seam. Comments authored as that token's account. Per-user OAuth is a documented future plan, not in this scope. |
| 6 | ⚑ **List economics:** the doc list derives **titles from filenames** (no per-file content fetch) and **date-sort is best-effort** (one bounded recent-commits scan); frontmatter titles are fetched lazily when a doc opens. A short-TTL cache per `(repo, ref)` reduces API calls. |
| 7 | **No new runtime dependency:** GitHub API via global `fetch`; reuse the existing comment codec/SDK. |

## Scope

**In v1:**
- `docs_repos` per-org registry (add / list / remove), management gated to admins.
- Add-by-URL with github.com validation + access verification.
- GitHub-API `docSource` reader: list `.md` (trees), read file @ ref (contents),
  resolve version SHA + recent versions (commits), repo slug (registry).
- Repo-scoped `/docs` routes + a repo switcher and add/remove UI in the top bar.
- Short-TTL in-memory cache for tree/contents/commits per `(repo, ref)`.
- Login guard on `/docs`.
- A `docs/superpowers/plans/2026-10-06-future-per-user-github-oauth.md` future plan.

**Out of v1 (future / documented):**
- Per-user GitHub OAuth and per-user comment attribution (future plan doc).
- Exact per-file frontmatter titles and creation dates in the list without lazy
  fetch/caching (depends on caching maturity / higher rate limits).
- Local-clone-only niceties from v1: reading uncommitted working-tree edits and
  SSE live-reload on local file saves (meaningless without a clone).
- Webhook-driven real-time comment updates (focus + poll refresh is retained).

## Data model

New table (created in `initDb` with `CREATE TABLE IF NOT EXISTS`):

```
docs_repos(
  id            TEXT PRIMARY KEY,       -- nanoid
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner         TEXT NOT NULL,
  repo          TEXT NOT NULL,
  html_url      TEXT NOT NULL,
  default_branch TEXT,
  created_by    TEXT,                   -- user id
  created_at    TEXT NOT NULL
)
UNIQUE(org_id, owner, repo)
```

No file or comment rows — GitHub remains the single store for docs content and
comments. The registry is pure configuration/metadata.

## Source — GitHub-API reader

New implementation behind the existing `docSource` interface (so the v1 shape is
preserved for routes), reading via `api.github.com` with the configured token:

- `listDocs(repo)` → `[{ path, title, created? }]`. One **git-trees** call
  (`GET /repos/{o}/{r}/git/trees/{branch}?recursive=1`), filter `blob` paths
  ending `.md`, exclude `README.md`/`CLAUDE.md`. ⚑ `title` = filename-derived;
  `created` best-effort from a single recent-commits scan (absent → sorts last).
- `readDoc(repo, path, ref)` → `{ raw, versionSha, dirty:false }`. **Contents**
  call at `ref` (default branch HEAD, or a sha); `versionSha` resolved to the
  commit (see below). There is no working tree, so `dirty` is always false.
- `resolveVersionSha(repo, path)` → latest commit touching the path
  (`GET /commits?path=&per_page=1`).
- `recentVersions(repo, path)` → `GET /commits?path=&per_page=N` → `[{sha,date,subject}]`.
- `repoSlug(repo)` → `{ owner, repo }` straight from the registry row.
- Frontmatter/H1 title for a specific doc is parsed when `readDoc` fetches it (so
  the open document shows its real title even though the tree used filenames).

**Caching:** a small in-memory TTL cache (per `(repo, ref)` for trees, per
`(repo, path, ref)` for contents, per `(repo, path)` for commit lists) to keep
browsing responsive and well under rate limits. Invalidated by TTL; a manual
refresh busts it for the active doc.

**Path safety:** `path` is still validated (no `..`/absolute/non-`.md`) before it
is interpolated into any API URL; `sha`/`ref` validated `^[0-9a-f]{7,64}$` or a
known branch name. `owner/repo` always come from the registry, never the client.

## Routes

All doc routes are **repo-scoped**: a `repo` id resolves against the caller's org
registry; a repo not in the caller's org → 404 (don't reveal it).

- `GET /docs` — `requireOrg`. Home: the org's repos + switcher; empty state with
  an "Add a repo" prompt when none.
- `GET /docs/view?repo=&path=&sha=` — `requireOrg`. Rendered doc + SDK.
- `GET /docs/comments?repo=&path=&sha=` / `POST` / `DELETE /docs/comments/:id?repo=` — `requireOrg`.
- `GET /docs/repos` — `requireOrg`. The org's registry (for the switcher).
- `POST /docs/repos {url}` — `requireAdmin`. Validate + verify access + insert
  (409 on duplicate, 400 on bad/non-github URL, 404/403 when the token can't see it).
- `DELETE /docs/repos/:id` — `requireAdmin`. Remove from the org registry.

## UI

Reuses the v1 docs shell/SDK, adding to the top bar:
- a **repo switcher** `<select>` of the org's repos (changing it reloads `/docs?repo=`);
- an **"Add repo"** affordance (paste a GitHub URL → `POST /docs/repos` → refresh
  the switcher), admin-only;
- a **remove** control per repo (admin-only);
- an **empty state** when the org has no repos yet.
The tree (collapsible/search/sort/resize), inline commenting, highlights, and
focus/poll auto-refresh all carry over unchanged, now parameterized by `repo`.

## Security

- Add-by-URL: host must be **github.com**; parse `owner/repo`; **verify via
  `GET /repos/{owner}/{repo}`** (the token can see it) before storing. Reject
  otherwise with a clear message.
- No SSRF: the server only calls `api.github.com` with parsed `owner/repo`,
  never the user-supplied URL.
- Management (`add`/`remove`) is **admin-only**; viewing requires org membership.
- The token is server-side only, never sent to the browser (unchanged from v1).
- Repo access is always re-scoped to the caller's org on every request.

## Local + Railway parity

Behavior is identical in both environments; the only required configuration is
the **GitHub token** env var. No `DOCS_REPO_PATH`, no clone, no disk, so Railway
needs **no persistent volume**. The registry lives in the same Postgres the app
already uses in both environments. `/docs` mounts whenever the feature is enabled
(token present) rather than being gated on a local path.

## Supersession of the v1 clone model

This changes the just-built `/docs` v1: file access moves from a local clone to
the GitHub API; `DOCS_REPO_PATH` is replaced by the per-org registry + token;
`/docs` gains the login guard; routes gain a `repo` parameter. Carried over
unchanged: the comment-body codec, GitHub commit-comment storage, FBAnchor
highlighting, the styled 3-pane shell, tree search/sort/collapse/resize, the
inline composer, and focus/poll auto-refresh.

## Future — per-user GitHub OAuth

A separate plan doc (`docs/superpowers/plans/2026-10-06-future-per-user-github-oauth.md`)
captures: a GitHub OAuth (or GitHub App) connect flow, per-user token storage,
reads and comment authorship under the acting user's identity, and the migration
from the single configured token. Free from GitHub (within rate limits); the cost
is build effort. The v1 token-resolution seam is designed so this drops in.

## Testing

- **Registry**: CRUD + per-org scoping + duplicate/foreign-repo rejection (supertest + DB).
- **Add-by-URL**: URL parsing/validation (github.com only), access-verification
  branch, duplicate 409, non-github 400 — unit + route tests with a fake `fetch`.
- **API reader**: trees→`.md` filtering, contents read @ ref, commit resolution,
  cache hit/miss — against a fake `fetch`; **no live GitHub**.
- **Path/sha validation** preserved.
- **UI**: pure helpers (switcher state, add-form payload) unit-tested.

## Open questions / later

- Caching strategy depth (in-memory vs shared) once multi-instance on Railway.
- Exact titles/dates in the list once caching or OAuth higher limits allow per-file fetches.
- Pagination for repos with >1000 tree entries or long commit histories.
