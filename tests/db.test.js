// tests/db.test.js
const path = require('path');
const os = require('os');

let db;

beforeEach(() => {
  process.env.DB_PATH = path.join(os.tmpdir(), `test-${Date.now()}.db`);
  jest.resetModules();
  const { initDb } = require('../src/db');
  db = initDb();
});

afterEach(() => {
  db.close();
});

test('initDb creates all four tables', () => {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name);
  expect(tables).toEqual(
    expect.arrayContaining(['access_log', 'allowlist', 'comments', 'prototypes'])
  );
});

test('getDb returns the same instance', () => {
  const { getDb } = require('../src/db');
  const a = getDb();
  const b = getDb();
  expect(a).toBe(b);
});
