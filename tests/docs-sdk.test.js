// tests/docs-sdk.test.js
const { nearestSourceLine, buildTree, commentPayload } = require('../public/sdk/docs.js');

test('nearestSourceLine walks up to the annotated block', () => {
  const block = { getAttribute: (a) => (a === 'data-source-line' ? '5' : null), parentElement: null };
  const leaf = { getAttribute: () => null, parentElement: block };
  expect(nearestSourceLine(leaf)).toBe(5);
  expect(nearestSourceLine({ getAttribute: () => null, parentElement: null })).toBeNull();
});

test('buildTree nests by directory', () => {
  const tree = buildTree([{ path: 'guide/intro.md', title: 'Intro' }, { path: 'readme-ish/a.md', title: 'A' }]);
  const guide = tree.children.find((n) => n.name === 'guide');
  expect(guide.children[0]).toMatchObject({ name: 'intro.md', path: 'guide/intro.md', title: 'Intro' });
});

test('commentPayload shapes the POST body', () => {
  const p = commentPayload({ path: 'a.md', sha: 's', line: 3, kind: 'question', text: 'q', anchor: { quote: 'x' } });
  expect(p).toEqual({ path: 'a.md', sha: 's', line: 3, kind: 'question', text: 'q', anchor: { quote: 'x' }, tag: null, replyTo: null });
});
