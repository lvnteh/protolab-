// tests/db.test.js
const hasDb = !!process.env.DATABASE_URL;

(hasDb ? describe : describe.skip)('db', () => {
  beforeAll(async () => {
    const { initDb } = require('../src/db');
    await initDb();
  });

  afterAll(async () => {
    const { closeDb } = require('../src/db');
    await closeDb();
  });

  test('prototypes table exists', async () => {
    const { getDb } = require('../src/db');
    const pool = getDb();
    const result = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'prototypes'`
    );
    expect(result.rows).toHaveLength(1);
  });

  test('allowlist table exists', async () => {
    const { getDb } = require('../src/db');
    const pool = getDb();
    const result = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'allowlist'`
    );
    expect(result.rows).toHaveLength(1);
  });
});
