// tests/test-db.js
// Single source of truth for the TEST database connection, shared by
// jest.globalSetup.js (which creates the database) and jest.setup-env.js (which
// points every suite at it).
//
// Why this file exists: the dev app and the test suite talk to the same
// Postgres server, and tests/setup.js TRUNCATEs every data table between files.
// Running tests against the dev database therefore wipes local data (uploaded
// prototypes, the seeded dev user, etc.). Tests must use a DEDICATED database,
// derived independently of whatever DATABASE_URL points the dev app at.
//
// Resolution order:
//   1. TEST_DATABASE_URL — used verbatim (CI / explicit control).
//   2. DATABASE_URL      — reuse its host+credentials, swap the db name only.
//   3. default local compose Postgres (localhost:5433).
// In cases 2 and 3 the database name is forced to `protoshare_test`, so the test
// run can never land on the dev database (default name `postgres`).
const DEFAULT_BASE = 'postgresql://postgres:postgres@localhost:5433/postgres';
const TEST_DB_NAME = 'protoshare_test';

function withDbName(rawUrl, dbName) {
  const u = new URL(rawUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

const explicit = process.env.TEST_DATABASE_URL;
const base = explicit || process.env.DATABASE_URL || DEFAULT_BASE;

// testUrl: where suites connect. adminUrl: a maintenance connection on the same
// server (the default `postgres` database) used ONLY to CREATE the test db.
const testUrl = explicit || withDbName(base, TEST_DB_NAME);
const adminUrl = withDbName(testUrl, 'postgres');
const testDbName = new URL(testUrl).pathname.replace(/^\//, '');

module.exports = { testUrl, adminUrl, testDbName };
