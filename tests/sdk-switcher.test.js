// tests/sdk-switcher.test.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'sdk', 'feedback.js'), 'utf8');

test('the SDK reads the version attrs and guards the version query (Review Focus #1)', () => {
  expect(src).toMatch(/data-version/);
  expect(src).toMatch(/data-view-base/);
  // version only appended when present — no bare "?version=null"
  expect(src).toMatch(/VERSION\s*!=\s*null|VERSION\s*\?/);
  // switcher wired without inline handlers (CSP)
  expect(src).toMatch(/addEventListener\(\s*['"]change['"]/);
  expect(src).not.toMatch(/__fb-version-switcher[^>]*onchange=/);
});
