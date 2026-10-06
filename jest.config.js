// jest.config.js — central test configuration.
// Tests hit a real Postgres, but ALWAYS a dedicated test database — never the
// dev/compose database. jest.globalSetup.js creates it once; jest.setup-env.js
// forces DATABASE_URL to it before any suite loads config (see those files and
// tests/test-db.js). tests/setup.js then TRUNCATEs tables after each test FILE
// for per-file isolation. The default `npm test` runs SERIALLY (--runInBand)
// because all workers share the one test database — parallel
// `npm run test:parallel` is only safe once each worker targets its own
// database (e.g. a worker-suffixed DB name); that isolation is not yet wired,
// so serial is the safe default.
module.exports = {
  testEnvironment: 'node',
  testTimeout: 15000,
  globalSetup: '<rootDir>/jest.globalSetup.js',
  setupFiles: ['<rootDir>/jest.setup-env.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  collectCoverageFrom: ['src/**/*.js', 'mcp/lib/**/*.cjs', '!**/node_modules/**'],
};
