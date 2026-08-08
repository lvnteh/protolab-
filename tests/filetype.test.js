// tests/filetype.test.js
const ft = require('../src/services/filetype');

test('contentTypeForFilename maps extensions', () => {
  expect(ft.contentTypeForFilename('a.md')).toBe('markdown');
  expect(ft.contentTypeForFilename('a.markdown')).toBe('markdown');
  expect(ft.contentTypeForFilename('a.HTML')).toBe('html');
  expect(ft.contentTypeForFilename('a.html')).toBe('html');
});

test('contentTypeForFilename returns null for unsupported', () => {
  expect(ft.contentTypeForFilename('a.txt')).toBeNull();
  expect(ft.contentTypeForFilename('a.png')).toBeNull();
  expect(ft.contentTypeForFilename('noext')).toBeNull();
});

test('isAccepted mirrors contentTypeForFilename', () => {
  expect(ft.isAccepted('x.md')).toBe(true);
  expect(ft.isAccepted('x.html')).toBe(true);
  expect(ft.isAccepted('x.gif')).toBe(false);
});

test('extForContentType / mimeForContentType', () => {
  expect(ft.extForContentType('markdown')).toBe('md');
  expect(ft.extForContentType('html')).toBe('html');
  expect(ft.mimeForContentType('markdown')).toBe('text/markdown; charset=utf-8');
  expect(ft.mimeForContentType('html')).toBe('text/html; charset=utf-8');
});
