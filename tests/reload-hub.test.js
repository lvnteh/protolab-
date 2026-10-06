const { createReloadHub } = require('../src/services/reloadHub');

test('broadcast reaches current subscribers; unsubscribe stops delivery', () => {
  const hub = createReloadHub();
  const a = []; const b = [];
  const unsubA = hub.subscribe((m) => a.push(m));
  hub.subscribe((m) => b.push(m));
  hub.broadcast();
  expect(a).toEqual(['reload']);
  expect(b).toEqual(['reload']);
  unsubA();
  hub.broadcast('again');
  expect(a).toEqual(['reload']);
  expect(b).toEqual(['reload', 'again']);
});
