// tests/setup.js — Jest setupFilesAfterEnv hook.
// Placeholder: WS-D fleshes this out with per-suite DB cleanup (calls cleanDb()
// from src/db.js). Kept minimal here so the jest config is valid immediately.
// It must be a no-op when there is no DATABASE_URL (unit-only suites like the
// MCP libs and inject tests must run without a database).
