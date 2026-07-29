// tests/setup.js — Jest setupFilesAfterEnv hook (runs once per test FILE).
//
// PURPOSE: give each test file a clean database slate so suites don't leak rows
// into one another. This is what makes parallel Jest workers safe (each worker
// gets its own DB) and keeps serial runs deterministic.
//
// WHY afterAll, NOT afterEach:
//   cleanDb() TRUNCATEs ALL data tables — including `users`. Several suites create
//   a user (or admin session, token, prototype) once in beforeAll and reuse it
//   across many tests in the same file. Truncating in afterEach (between tests
//   within a file) would rip those fixtures out mid-suite and break them. Running
//   the cleanup in afterAll gives PER-FILE isolation (wipe on the way out of each
//   file) while leaving within-file fixtures intact.
//
// NO-OP WITHOUT A DATABASE:
//   DB-free suites (mcp-*.test.js, inject.test.js) run with NO DATABASE_URL. In
//   that mode this hook must not touch pg or open a connection at all — so we
//   gate the whole thing on process.env.DATABASE_URL and return early otherwise.
//
// ORDERING SAFETY:
//   Many DB suites call closeDb() in their OWN afterAll, which ends the pool. If
//   our afterAll runs after theirs, cleanDb() -> getDb() would throw
//   "Database not initialized". cleanDb() itself already no-ops on a null pool,
//   but a suite that closed the pool leaves getDb() throwing. We therefore wrap
//   the call in try/catch and swallow the "already cleaned up / pool ended"
//   errors: if the suite tore the pool down, there is nothing left to clean and
//   failing here would only mask the real test result. The hook stays fully
//   side-effect-free on any failure.
const { cleanDb } = require('../src/db');

afterAll(async () => {
  // Unit-only suites (no DATABASE_URL): complete no-op, never require/connect pg.
  if (!process.env.DATABASE_URL) return;

  try {
    await cleanDb();
  } catch (err) {
    // Expected when the suite already closed its pool in its own afterAll
    // (LIFO of afterAll hooks is not guaranteed to put us first). Nothing left
    // to clean in that case — swallow only the "pool gone" family of errors and
    // re-throw anything genuinely unexpected so real failures stay visible.
    const msg = String(err && err.message);
    const poolGone =
      /not initialized/i.test(msg) ||          // getDb() after closeDb()
      /Cannot use a pool after calling end/i.test(msg) || // pg pool ended
      /Called end on pool more than once/i.test(msg) ||
      /Connection terminated/i.test(msg);
    if (!poolGone) throw err;
  }
});
