// tests/db.test.js
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@sap.com';
process.env.ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH ||
  require('bcryptjs').hashSync('secret', 10);

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

  test('users table exists', async () => {
    const { getDb } = require('../src/db');
    const result = await getDb().query(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'users'`
    );
    expect(result.rows).toHaveLength(1);
  });

  test('prototypes has owner_id column', async () => {
    const { getDb } = require('../src/db');
    const result = await getDb().query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'prototypes' AND column_name = 'owner_id'`
    );
    expect(result.rows).toHaveLength(1);
  });

  test('env admin is seeded into users', async () => {
    const { getDb } = require('../src/db');
    const result = await getDb().query(
      'SELECT id FROM users WHERE email = $1',
      [process.env.ADMIN_EMAIL.toLowerCase()]
    );
    expect(result.rows).toHaveLength(1);
  });

  test('no prototypes are left without an owner after backfill', async () => {
    const { getDb } = require('../src/db');
    const result = await getDb().query(
      'SELECT COUNT(*) AS n FROM prototypes WHERE owner_id IS NULL'
    );
    expect(parseInt(result.rows[0].n, 10)).toBe(0);
  });
});
