// tests/inject.test.js
const { injectSdk } = require('../src/services/inject');

const BARE_HTML = `<!DOCTYPE html><html><head><title>Test</title></head><body><h1>Hello</h1></body></html>`;

test('injectSdk loads anchor.js before feedback.js', () => {
  const result = injectSdk(BARE_HTML, 'p1', 'a@b.com');
  expect(result).toContain('/sdk/anchor.js');
  expect(result.indexOf('/sdk/anchor.js')).toBeLessThan(result.indexOf('/sdk/feedback.js'));
});

test('injectSdk inserts feedback.js script before </body>', () => {
  const result = injectSdk(BARE_HTML, 'proto123', 'user@example.com');
  expect(result).toContain('/sdk/feedback.js');
  expect(result).toContain('data-proto-id="proto123"');
  expect(result).toContain('data-email="user%40example.com"');
  expect(result.indexOf('/sdk/feedback.js')).toBeLessThan(result.indexOf('</body>'));
});

test('injectSdk works on HTML without </head> tag', () => {
  const html = `<html><body><p>No head tag</p></body></html>`;
  const result = injectSdk(html, 'p1', 'a@b.com');
  expect(result).toContain('/sdk/feedback.js');
});
