// eslint.config.js — ESLint 10 flat config.
//
// Deliberately MINIMAL and permissive: the goal is a green `npm run lint` on the
// existing codebase, not a style crusade. We lint for real breakage (undefined
// vars, syntax errors) and downgrade cosmetic rules (unused vars) to warnings so
// pre-existing noise never blocks CI. Tighten later if desired.
//
// NOTE: we intentionally do NOT depend on the `@eslint/js` package (it is not a
// dependency of eslint 10 in this project and package.json is centrally frozen).
// Instead we hand-pick a small set of high-signal core rules below. `no-undef`
// with proper globals + `no-unused-vars` (warn) covers the real breakage classes
// without pulling the full recommended set's noise onto the existing code.

// Shared Node.js runtime globals (CommonJS + timers + fetch, etc.).
const nodeGlobals = {
  process: 'readonly',
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  __dirname: 'readonly',
  __filename: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly',
  fetch: 'readonly',
  FormData: 'readonly',
  Blob: 'readonly',
  globalThis: 'readonly',
};

// Jest test globals.
const jestGlobals = {
  describe: 'readonly',
  test: 'readonly',
  it: 'readonly',
  expect: 'readonly',
  beforeAll: 'readonly',
  afterAll: 'readonly',
  beforeEach: 'readonly',
  afterEach: 'readonly',
  jest: 'readonly',
};

const relaxedRules = {
  // High-signal core rules that catch real breakage without the full recommended
  // set's cosmetic noise. `no-undef` (paired with the globals above) flags typos
  // and missing imports; the rest catch genuine mistakes.
  'no-undef': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-unreachable': 'error',
  'no-cond-assign': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'valid-typeof': 'error',
  'use-isnan': 'error',
  // Unused vars are common in scaffolding / partially-wired handlers — warn only,
  // and never flag args prefixed with _ or trailing unused args.
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', args: 'none', varsIgnorePattern: '^_' }],
  // Empty catch blocks are used intentionally for best-effort cleanup.
  'no-empty': ['warn', { allowEmptyCatch: true }],
};

module.exports = [
  // Ignore build output, deps, static assets, and workflow files.
  {
    ignores: [
      'node_modules/**',
      'mcp/node_modules/**',
      'coverage/**',
      'public/**',
      '.github/**',
      'data/**',
      'uploads/**',
    ],
  },

  // src/ and tests/ are CommonJS running on Node.
  {
    files: ['src/**/*.js', 'tests/**/*.js', 'eslint.config.js', 'jest.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    rules: relaxedRules,
  },

  // tests/ additionally get the Jest globals.
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: { ...nodeGlobals, ...jestGlobals },
    },
  },

  // mcp/*.mjs are ES modules.
  {
    files: ['mcp/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...nodeGlobals },
    },
    rules: relaxedRules,
  },

  // mcp/*.cjs are CommonJS.
  {
    files: ['mcp/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    rules: relaxedRules,
  },
];
