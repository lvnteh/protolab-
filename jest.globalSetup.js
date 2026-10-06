// jest.globalSetup.js — runs ONCE before the whole test run (separate process).
//
// Ensures the dedicated test database exists so suites never touch — and
// tests/setup.js's cleanDb() can never TRUNCATE — the dev/compose database.
// Creation is idempotent: existing database (e.g. a CI-provisioned one) is left
// as-is. See tests/test-db.js for how the target is resolved.
const { Client } = require('pg');
const { adminUrl, testDbName } = require('./tests/test-db');

module.exports = async function globalSetup() {
  const admin = new Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `[jest] cannot reach Postgres to provision the test database (${adminUrl.replace(/:[^:@/]*@/, ':***@')}). ` +
      `Is the compose Postgres up? Set TEST_DATABASE_URL to override. Cause: ${err.message}`
    );
  }
  try {
    const { rowCount } = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1', [testDbName]);
    if (!rowCount) {
      // CREATE DATABASE cannot be parameterized or run inside a transaction;
      // testDbName is an internal constant, never user input.
      await admin.query(`CREATE DATABASE "${testDbName}"`);
      // eslint-disable-next-line no-console
      console.log(`[jest] created test database "${testDbName}"`);
    }
  } finally {
    await admin.end();
  }
};
