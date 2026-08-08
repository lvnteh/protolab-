// tests/markdown.test.js
const { render } = require('../src/services/markdown');

test('renders headings, lists, tables, code', () => {
  const { html } = render('# Title\n\n- one\n- two\n\n`code`');
  expect(html).toContain('<h1>Title</h1>');
  expect(html).toContain('<li>one</li>');
  expect(html).toContain('<code>code</code>');
});

test('renders GFM tables', () => {
  const { html } = render('| a | b |\n|---|---|\n| 1 | 2 |');
  expect(html).toContain('<table>');
  expect(html).toContain('<td>1</td>');
});

test('ignores raw HTML in the markdown (html:false)', () => {
  const { html } = render('hello <div onclick="x()">raw</div> world');
  expect(html).not.toContain('<div onclick');
});

test('strips script tags from output', () => {
  const { html } = render('# Doc\n\n<script>alert(2)</script>');
  expect(html).not.toContain('<script');
});

test('does not emit executable javascript: URLs in link hrefs', () => {
  const { html } = render('[click](javascript:alert(1))');
  expect(html.toLowerCase()).not.toContain('href="javascript:');
  expect(html.toLowerCase()).not.toContain("href='javascript:");
});

test('preserves the literal text "javascript:" when it appears in prose', () => {
  // A docs-sharing app must not corrupt content that merely mentions the scheme.
  const { html } = render('Never put `javascript:` in an href.');
  expect(html).toContain('javascript:');
});

test('empty input yields empty-ish html string', () => {
  const { html } = render('');
  expect(typeof html).toBe('string');
});
