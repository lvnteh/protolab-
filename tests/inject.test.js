// tests/inject.test.js
const { injectSdk, injectBridge } = require('../src/services/inject');

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

test('injectSdk emits version data-attributes when a version context is supplied', () => {
  const ctx = { version: 2, versions: [{ version: 1 }, { version: 2 }], viewBase: '/p/tok/view' };
  const out = injectSdk('<body></body>', 'proto1', 'a@b.com', 'html', ctx);
  expect(out).toContain('data-version="2"');
  expect(out).toContain('data-view-base="/p/tok/view"');
  expect(out).toContain('data-versions=');            // escaped JSON present
  expect(out).toContain('&quot;version&quot;:2');      // JSON was HTML-escaped, not raw
});

test('injectSdk output is unchanged when no version context is supplied', () => {
  const a = injectSdk('<body></body>', 'proto1', 'a@b.com', 'html');
  expect(a).not.toContain('data-version=');
});

test('injectSdk emits data-csrf-token from the version context', () => {
  const ctx = { csrfToken: 'a'.repeat(64), viewBase: '/p/tok/view' };
  const out = injectSdk('<body></body>', 'proto1', 'rev@b.com', 'html', ctx);
  expect(out).toContain('data-csrf-token="' + 'a'.repeat(64) + '"');
});

test('injectSdk omits data-csrf-token when none supplied', () => {
  const out = injectSdk('<body></body>', 'proto1', 'rev@b.com', 'html', { viewBase: '/x' });
  expect(out).not.toContain('data-csrf-token');
});

test('injectBridge stamps the trusted shell origin onto the bridge tag', () => {
  const out = injectBridge(BARE_HTML, 'https://proto.example');
  expect(out).toContain('/sdk/frame-bridge.js');
  expect(out).toContain('data-shell-origin="https://proto.example"');
  expect(out.indexOf('/sdk/frame-bridge.js')).toBeLessThan(out.indexOf('</body>'));
});

test('injectBridge HTML-escapes the shell origin attribute (no attribute break-out)', () => {
  const out = injectBridge(BARE_HTML, 'https://x"/><script>bad()</script>');
  expect(out).not.toContain('"/><script>bad()');
  expect(out).toContain('&quot;');
});

test('injectBridge omits data-shell-origin when none supplied (fail-closed bridge)', () => {
  const out = injectBridge(BARE_HTML);
  expect(out).toContain('/sdk/frame-bridge.js');
  expect(out).not.toContain('data-shell-origin');
});
