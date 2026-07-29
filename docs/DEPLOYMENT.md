# Deployment

Operator runbook for the proto-share app (Node/Express, CommonJS). Keep this
factual — every env var below is read by `src/config.js` or the code paths noted.

## Required environment

| Variable | Required | Notes |
|----------|----------|-------|
| `DATABASE_URL` | Yes | Postgres connection string. Must be a **direct** session connection (see below), not a transaction pooler. |
| `SESSION_SECRET` | Yes in production | Signs session cookies. In `NODE_ENV=production` the app **throws on boot** if this is unset (`config.js` refuses to start with a default secret). Outside production it falls back to a dev-only value. |
| `SUPABASE_URL` | For hosted storage | Supabase project URL. If absent, uploads fall back to the local filesystem. |
| `SUPABASE_SERVICE_ROLE_KEY` | For hosted storage | Service-role key (server-side secret, never ship to the browser). Storage uses Supabase only when **both** `SUPABASE_URL` and this key are set; otherwise it reads/writes `UPLOADS_PATH` on local disk. |
| `SUPABASE_STORAGE_BUCKET` | No | Private bucket name. Defaults to `prototypes`. |
| `BASE_URL` | Recommended | Public URL of the deployment (used to build share links). Defaults to `http://localhost:3000`. |
| `PORT` | No | Listen port. Defaults to `3000`. |
| `ADMIN_USER` / `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH` | Recommended | Seed admin account. On first boot, if the `users` table is empty and email+hash are set, the admin is inserted and any unowned prototypes are backfilled to it. `ADMIN_PASSWORD_HASH` is a bcrypt hash. |
| `CSRF_ENABLED` | No | Set to `'1'` to enforce CSRF in non-production. CSRF is **auto-enabled** whenever `NODE_ENV=production`, so you rarely set this explicitly outside dev. |
| `NODE_ENV` | Recommended | Set to `production` in prod. Enables secure cookies (HTTPS-only), CSRF enforcement, and requires `SESSION_SECRET`. |
| `PGSSLMODE` | No | Set to `disable` for a local/non-SSL Postgres. For localhost/127.0.0.1 the app already disables SSL automatically; managed Postgres uses SSL with `rejectUnauthorized: false`. |

`config.js` also allows uploads via `UPLOADS_PATH` (default `./uploads`) — only
used as the local-storage fallback when Supabase creds are absent.

Allowed signup email domains are hardcoded in `config.js` (`sap.com`,
`emarsys.com`); change them there, not via env.

## Database connection — use the DIRECT connection

`initDb()` (in `src/db.js`) acquires a Postgres **advisory lock** (`pg_advisory_lock`)
to guard the one-time v1 version backfill so concurrent or multi-instance boots
are race-safe. Advisory locks are **session-scoped** — they require a real,
persistent session connection.

- On Supabase, use the **Direct connection** (port **5432**), not the transaction
  pooler (port **6543**). The transaction pooler multiplexes statements across
  backends and does not preserve a session, which breaks advisory locks.
- On an IPv4-only host, use Supabase's **Session pooler** string (also port 5432,
  session-scoped) — it is fine because it keeps a session; the *transaction*
  pooler is the one to avoid.

## Migrations

There is no separate migration step. `initDb()` runs automatically on boot and is
idempotent:

- Schema is created with `CREATE TABLE IF NOT EXISTS` and guarded `ALTER`s
  (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` + re-add).
- The v1 prototype-version backfill runs **once**, protected by the advisory lock
  above plus an `ON CONFLICT DO NOTHING` insert and a `schema_migrations` marker
  row (`v1-version-backfill`). Once the marker exists and no unversioned
  prototypes remain, the expensive loop is skipped on subsequent boots.
- The server **blocks on `initDb()` before it starts listening**, so a booting
  instance never serves traffic against an unmigrated schema.

This makes rolling / multi-instance deploys safe: whichever instance wins the
advisory lock runs the backfill; the others wait, then find nothing to do.

## Deploy targets

`railway.toml` and `Dockerfile` already exist:

- `Dockerfile` — `node:20-alpine`, `npm ci --only=production`, copies `src/` and
  `public/`, runs `node src/server.js` on port 3000.
- `railway.toml` — dockerfile builder, `startCommand = "node src/server.js"`,
  health check on `/`.

Minimal host setup (Railway or any container host):

1. Set `DATABASE_URL` (direct/session connection, port 5432).
2. Set `SESSION_SECRET` to a long random string.
3. Set `NODE_ENV=production`.
4. Set the Supabase storage vars (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   optionally `SUPABASE_STORAGE_BUCKET`) — or omit them to use local disk
   (`UPLOADS_PATH`), which is **not** recommended for a stateless/multi-instance
   deploy since local disk is not shared.
5. Set `BASE_URL` to the public URL, and `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH`
   to seed the first admin.
6. Deploy. `initDb()` migrates on boot, then the server begins listening.

## Tests / CI

- `npm run test:serial` — runs Jest serially; **requires a Postgres** reachable
  via `DATABASE_URL`. DB-gated suites skip themselves when `DATABASE_URL` is
  unset; the MCP and inject unit suites run without a database.
- `npm test` — parallel Jest. Safe because `tests/setup.js` truncates all data
  tables per test file (`afterAll` → `cleanDb`), giving each file a clean slate.
- `npm run lint` — ESLint (flat config in `eslint.config.js`).
- `npm run check` — `lint` + `test`.

CI (`.github/workflows/ci.yml`) runs on push / PR to `main`: it spins up a
`postgres:16` service container, installs with `npm ci`, runs lint
(non-blocking initially), and runs `npm run test:serial` with
`DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres`,
`PGSSLMODE=disable`, and a dummy `SESSION_SECRET`.
