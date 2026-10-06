// jest.setup-env.js — jest `setupFiles` hook: runs in each worker BEFORE any
// test module (and so before src/config.js's dotenv) is required.
//
// Forcing DATABASE_URL here — rather than relying on .env — is what makes test
// isolation UN-BYPASSABLE: dotenv.config() never overrides an already-set var,
// so every suite reads the dedicated test database regardless of what .env says.
// This is the guard that stops `npm test` from truncating the dev database.
const { testUrl } = require('./tests/test-db');

process.env.DATABASE_URL = testUrl;
process.env.NODE_ENV = 'test';
