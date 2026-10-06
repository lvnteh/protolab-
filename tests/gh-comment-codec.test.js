// tests/gh-comment-codec.test.js
const { encodeBody, parseBody } = require('../src/services/ghCommentCodec');

const anchor = { quote: 'foo', prefix: 'a ', suffix: ' b', start: 2, end: 5 };

test('round-trips text + metadata', () => {
  const body = encodeBody({ text: 'please clarify', kind: 'question', path: 'a/b.md', line: 12, anchor, tag: 'copy' });
  const p = parseBody(body);
  expect(p.text).toBe('please clarify');
  expect(p.kind).toBe('question');
  expect(p.path).toBe('a/b.md');
  expect(p.line).toBe(12);
  expect(p.anchor).toEqual(anchor);
  expect(p.tag).toBe('copy');
  expect(p.replyTo).toBeNull();
  expect(p.hasMeta).toBe(true);
});

test('a plain GitHub comment with no block degrades gracefully', () => {
  const p = parseBody('just a normal comment typed on github');
  expect(p.hasMeta).toBe(false);
  expect(p.kind).toBe('note');
  expect(p.text).toBe('just a normal comment typed on github');
  expect(p.anchor).toBeNull();
});

test('malformed json in the block does not throw', () => {
  const p = parseBody('hi\n\n<!-- protoshare:v1 {not json} -->');
  expect(p.hasMeta).toBe(false);
  expect(p.text).toContain('hi');
});
