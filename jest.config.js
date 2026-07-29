// jest.config.js — central test configuration.
// Tests hit a real Postgres (DATABASE_URL). tests/setup.js truncates tables
// after each test FILE, giving per-file isolation. The default `npm test` runs
// SERIALLY (--runInBand) because all workers currently share one database —
// parallel `npm run test:parallel` is only safe once each worker targets its
// own database (e.g. a worker-suffixed DB name); that isolation is not yet
// wired, so serial is the safe default.
module.exports = {
  testEnvironment: 'node',
  testTimeout: 15000,
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  collectCoverageFrom: ['src/**/*.js', 'mcp/lib/**/*.cjs', '!**/node_modules/**'],
};
