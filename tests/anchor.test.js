// tests/anchor.test.js
const A = require('../public/sdk/anchor');

test('exact offset hit is confirmed by quote', () => {
  const text = 'The quick brown fox jumps.';
  const anchor = { quote: 'quick brown', prefix: 'The ', suffix: ' fox', start: 4, end: 15 };
  expect(A.locateQuote(text, anchor)).toEqual({ start: 4, end: 15 });
});

test('recovers when offsets drift but quote is unique', () => {
  const text = 'INSERTED. The quick brown fox jumps.';
  const anchor = { quote: 'quick brown', prefix: 'The ', suffix: ' fox', start: 4, end: 15 };
  expect(A.locateQuote(text, anchor)).toEqual({ start: 14, end: 25 });
});

test('disambiguates duplicate quotes via prefix/suffix', () => {
  const text = 'cat here and cat there';
  const anchor = { quote: 'cat', prefix: 'and ', suffix: ' there', start: 13, end: 16 };
  expect(A.locateQuote(text, anchor)).toEqual({ start: 13, end: 16 });
});

test('returns null when quote is absent', () => {
  const text = 'nothing to see';
  const anchor = { quote: 'absent phrase', prefix: '', suffix: '', start: 0, end: 5 };
  expect(A.locateQuote(text, anchor)).toBeNull();
});

test('empty quote → null', () => {
  expect(A.locateQuote('abc', { quote: '', start: 0, end: 0 })).toBeNull();
});
