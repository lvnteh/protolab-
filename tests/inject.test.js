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

// ── content-type signal ──────────────────────────────────────────────────
// The SDK needs to know whether it was injected into a rendered markdown
// document (select-text-to-annotate) or an HTML prototype (click-to-pin), so
// comment mode can pick the right interaction model. We thread that via a
// data-content-type attribute on the feedback.js tag.

test('injectSdk marks markdown documents with data-content-type="markdown"', () => {
  const result = injectSdk(BARE_HTML, 'p1', 'a@b.com', 'markdown');
  expect(result).toContain('data-content-type="markdown"');
});

test('injectSdk omits data-content-type for HTML (default / explicit)', () => {
  const noArg = injectSdk(BARE_HTML, 'p1', 'a@b.com');
  const htmlArg = injectSdk(BARE_HTML, 'p1', 'a@b.com', 'html');
  expect(noArg).not.toContain('data-content-type');
  expect(htmlArg).not.toContain('data-content-type');
});

test('injectSdk content-type does not break script ordering', () => {
  const result = injectSdk(BARE_HTML, 'p1', 'a@b.com', 'markdown');
  expect(result.indexOf('/sdk/anchor.js')).toBeLessThan(result.indexOf('/sdk/feedback.js'));
  expect(result.indexOf('/sdk/feedback.js')).toBeLessThan(result.indexOf('</body>'));
});
