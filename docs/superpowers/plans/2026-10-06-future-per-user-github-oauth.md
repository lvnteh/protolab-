# FUTURE: Per-user GitHub OAuth in the docs workflow

> **Status:** Deferred. Captured 2026-10-06 at feature design time while
> implementing the docs repo switcher (see
> `docs/superpowers/specs/2026-10-06-docs-repo-switcher-design.md`).
> The current implementation uses a single server-side `DOCS_GITHUB_TOKEN`
> for all reads and all comment authorship. This plan describes the upgrade.
>
> **For agentic workers:** Use `superpowers:subagent-driven-development` or
> `superpowers:executing-plans` when this is picked up. Each phase is
> independently shippable. Re-verify every file:line against the live tree —
> this plan was written against the 2026-10-06 tree.

**Goal:** Move from a single configured token (one GitHub account authors all
comments, accesses all repos) to per-user OAuth tokens so that:

- Comments are attributed to the acting ProtoLab user's GitHub identity.
- Private-repo access is granted only to users who have connected their account.
- Rate limits scale with users (5 000 req/hr per authenticated user) rather
  than being shared from one service account.
- The app can be hosted for multiple teams without requiring every team to
  share or rotate one PAT.

**Out of scope for the current feature.** The single-token path is the
correct starting point; this plan is the follow-up.

---

## 1. GitHub OAuth App vs GitHub App

| Factor | OAuth App | GitHub App |
|--------|-----------|------------|
| Who authorizes | Individual users | An org/repo admin installs it |
| Token type | User OAuth token (classic or fine-grained) | Installation token (short-lived) |
| Rate limit | 5 000 req/hr per user | 15 000 req/hr per installation |
| Scope granularity | Coarse (e.g. `repo`, `public_repo`) | Fine-grained per-permission |
| Private-repo reads | Yes, if user grants `repo` scope | Yes, if installed on the repo |
| Comment authorship | Comments appear as the user | Comments appear as the app bot |
| Cost | Free within rate limits | Free within rate limits |
| Build effort | Lower — standard PKCE-less OAuth 2 code flow | Higher — app installation UX + webhook handling |

**Recommendation: OAuth App.** Comment authorship appearing as the actual
user (not a bot) is the primary UX goal. The OAuth App code flow is simpler
to implement and free from GitHub within rate limits. A GitHub App upgrade
can follow if installation-level tokens are later needed for CI/automation.

---

## 2. Connect/callback flow

```
ProtoLab /admin/github/connect
  │
  └──► GitHub OAuth authorization URL
       https://github.com/login/oauth/authorize
         ?client_id=<GITHUB_OAUTH_CLIENT_ID>
         &redirect_uri=<APP_HOST>/admin/github/callback
         &scope=repo           (or public_repo for public-only access)
         &state=<CSRF token>   (server-generated, stored in session)
  │
  ◄─── GitHub redirects to /admin/github/callback?code=<CODE>&state=<STATE>
  │
  ├── Verify state (CSRF protection)
  ├── POST https://github.com/login/oauth/access_token  (code exchange)
  ├── GET  https://api.github.com/user  (fetch GitHub identity)
  ├── Encrypt + store token against ProtoLab user (see §3)
  └── Redirect to /docs (or the previous page)
```

A "Disconnect GitHub" control on the profile/settings page deletes the stored
token row. Admins also need a "Reconnect" path for token rotation.

---

## 3. Encrypted per-user token storage

Never return the raw token to the browser. Store it server-side only.

**Schema** (add to `src/db.js` in `initDb`, after `users`):

```sql
CREATE TABLE IF NOT EXISTS user_github_tokens (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_enc  TEXT NOT NULL,     -- AES-256-GCM encrypted, base64url
  github_id  TEXT NOT NULL,     -- numeric GitHub user id (string)
  login      TEXT NOT NULL,     -- GitHub username (for display)
  scope      TEXT,              -- granted scope string
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id)
);
```

**Encryption:** use Node `crypto.createCipheriv('aes-256-gcm', key, iv)` with
a 256-bit key from `process.env.GITHUB_TOKEN_ENC_KEY` (32 hex-encoded bytes).
Store `<iv_hex>:<auth_tag_hex>:<ciphertext_base64>` as `token_enc`. Fail-fast
at startup if the key is missing (mirror the Supabase pattern in
`src/services/storage.js`). Never log the decrypted value.

**Supabase alternative:** if the project migrates further into Supabase, the
token can live in a Supabase `user_github_tokens` table with RLS = `user_id =
auth.uid()` and column-level encryption via `pgcrypto`. The interface is the
same; only the storage layer differs.

---

## 4. Mapping GitHub identity ↔ ProtoLab user

- `user_github_tokens.github_id` is the authoritative link (numeric id, stable
  across username changes).
- `login` is stored for display only (show "Connected as @octocat" on the
  settings page).
- On callback: look up `user_id` from `req.session.userId`; upsert the token
  row. No separate "github_users" table needed — the ProtoLab user is already
  authenticated before they initiate the OAuth flow.
- Comment authorship: the GitHub API returns `gc.user.login` which is now the
  acting user's login rather than the service account — `toComment` in
  `src/services/ghComments.js` already surfaces this as `author`.

---

## 5. Migration from the single configured token

The entire seam is in `buildRealDeps` in `src/routes/docs.js`. Today:

```js
// src/routes/docs.js  buildRealDeps()
let cachedToken;
const token = () => (cachedToken !== undefined ? cachedToken
  : (cachedToken = (() => { try { return resolveToken(); } catch { return null; } })()));
```

This returns a single process-lifetime token resolved at cold-start.

**Target:** convert `token` into an async function that accepts the current
request and resolves the acting user's token from `user_github_tokens`, with a
fallback to the configured token for users who have not yet connected, or for
the `addRepo` admin flow:

```js
// future buildRealDeps()
const token = async (req) => {
  const userId = req && req.session && req.session.userId;
  if (userId) {
    const row = await getUserGithubToken(userId); // decrypt + return
    if (row) return row.token;
  }
  return resolveToken(); // fall back to env / gh auth token
};
```

`makeDocSource` and `makeGhComments` already accept a `token` parameter — they
are unaffected. The route handlers call `d.makeDocSource(row)` and
`d.makeGhComments(row)`, which today receive `token()` (sync). After migration
they receive `await token(req)`. The `addRepo` wrapper similarly calls
`await token(req)`.

`tokenAvailable` becomes: `true` if the acting user has a stored token **or**
the server has a configured fallback.

---

## 6. Reads and the registry under the acting user's token

- `GET /docs/view`, `GET /docs/comments`, `GET /docs/repos` — use the acting
  user's token. If the user has not connected GitHub, fall back to the
  configured token (same access as today). If neither is available, return 401
  with a "Connect your GitHub account" prompt.
- `POST /docs/repos` (add repo by URL) — uses the acting admin's token to
  verify access. This means the admin must have connected GitHub before adding
  private repos. For public repos the configured fallback works.
- Private-repo access: a user can only read repos their GitHub token can see.
  A repo added by one admin is not automatically readable by another user who
  has not connected (or whose token lacks `repo` scope) — surface a clear
  "no access" error rather than a 500.

---

## 7. Rate-limit implications

| Scenario | Limit |
|----------|-------|
| Single configured token (today) | 5 000 req/hr shared across all users |
| Per-user OAuth (target) | 5 000 req/hr **per connected user** |
| Unauthenticated fallback | 60 req/hr (avoid; keep the configured token as fallback) |

The 15 ms TTL cache in `createDocSource` already reduces per-page-load calls
significantly. With per-user tokens a busy team is unlikely to hit 5 000 req/hr
per user. If it becomes an issue, extend the TTL cache or add a shared read
cache keyed on `(owner, repo, path, ref)` with a short TTL (independent of the
token used to populate it).

---

## 8. Security review checklist

Before shipping this phase, verify:

- [ ] **Token encryption at rest** — `GITHUB_TOKEN_ENC_KEY` is a 256-bit
  random key, stored in Railway secrets (not in `.env.example`, not committed).
  Rotating the key requires re-encrypting all rows.
- [ ] **Scope minimization** — request `public_repo` unless private-repo
  support is explicitly needed; document what each scope enables. Consider a
  re-authorization flow to upgrade scope.
- [ ] **CSRF on the callback** — the `state` param is a securely random value
  stored in `req.session` before redirect and verified on callback. Mismatched
  or missing state → reject, clear session, redirect to error.
- [ ] **Redirect URI pinning** — register the exact `redirect_uri` in the
  OAuth App settings on GitHub; reject any callback that does not match.
- [ ] **Token revocation** — provide a user-initiated "Disconnect GitHub" that
  deletes the row. Also handle the GitHub `revoke` webhook (or poll
  `/user` periodically) to detect externally revoked tokens; remove or flag the
  row.
- [ ] **No token leakage to the browser** — `user_github_tokens` is never
  returned by any API response; `req.session` never carries the raw token.
- [ ] **Admin visibility** — admins should be able to see which users have
  connected (login, connected_at) but never the token value.
- [ ] **Fallback token security** — the configured `DOCS_GITHUB_TOKEN` remains
  a server-only value; `/docs/enabled` returns a boolean only, never the token
  or the GitHub identity behind it.

---

## Open questions for when this is picked up

- Which GitHub OAuth App to create — per-environment (dev/staging/prod) or
  shared? (Recommend per-environment; callback URIs differ.)
- Should unconnected users be blocked from `/docs`, or silently fall back to
  the configured token? (Fall-back is more gradual; blocking is cleaner once
  the team has all connected.)
- Scope: `public_repo` or `repo`? Decide based on whether the team needs
  private-repo doc wikis (likely yes for enterprise use).
- Key rotation strategy for `GITHUB_TOKEN_ENC_KEY` — accept a `KEY_V2` env
  var and lazy-rotate on first use, or schedule a one-off migration script?
