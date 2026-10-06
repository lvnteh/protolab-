// tests/markdown-sourcelines.test.js
const markdown = require('../src/services/markdown');

test('default render is unchanged (no data-source-line)', () => {
  const { html } = markdown.render('# Title\n\npara\n');
  expect(html).not.toContain('data-source-line');
  expect(html).toContain('<h1>Title</h1>');
});

test('sourceLines injects 1-based line numbers on block tags', () => {
  const { html } = markdown.render('# Title\n\nsecond para on line 3\n', { sourceLines: true });
  expect(html).toContain('<h1 data-source-line="1">Title</h1>');
  expect(html).toMatch(/<p data-source-line="3">second para/);
});

test('data-source-line survives sanitization', () => {
  const { html } = markdown.render('- a\n- b\n', { sourceLines: true });
  expect(html).toMatch(/<li data-source-line="\d+">/);
});
