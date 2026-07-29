// jest.config.js — central test configuration.
// Tests hit a real Postgres (DATABASE_URL). Per-suite isolation is provided by
// tests/setup.js (truncates tables between suites), which makes parallel workers
// safe once each worker targets its own database. Default run is serial-safe too.
module.exports = {
  testEnvironment: 'node',
  testTimeout: 15000,
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  collectCoverageFrom: ['src/**/*.js', 'mcp/lib/**/*.cjs', '!**/node_modules/**'],
};
