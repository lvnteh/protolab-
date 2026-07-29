const fs = require('fs');
const os = require('os');
const path = require('path');
const manifest = require('../mcp/lib/manifest.cjs');

function tmpManifest(contents) {
  const p = path.join(os.tmpdir(), `mani-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  if (contents !== undefined) fs.writeFileSync(p, contents);
  return p;
}

test('load returns parsed manifest with defaults for missing prototypes map', () => {
  const p = tmpManifest(JSON.stringify({ remote: 'https://x.example.com' }));
  const m = manifest.load(p);
  expect(m.remote).toBe('https://x.example.com');
  expect(m.prototypes).toEqual({});
});

test('load throws a clear error when the file is missing', () => {
  const p = tmpManifest(undefined);
  expect(() => manifest.load(p)).toThrow(/manifest not found/i);
});

test('load throws a clear error when remote is absent', () => {
  const p = tmpManifest(JSON.stringify({ prototypes: {} }));
  expect(() => manifest.load(p)).toThrow(/remote/i);
});

test('resolveId returns the id for a known file key', () => {
  const m = { remote: 'r', prototypes: { 'a.html': { id: 'ID_A' } } };
  expect(manifest.resolveId(m, 'a.html')).toBe('ID_A');
});

test('resolveId returns the input unchanged when it is not a known file (treated as an id)', () => {
  const m = { remote: 'r', prototypes: { 'a.html': { id: 'ID_A' } } };
  expect(manifest.resolveId(m, 'ID_A')).toBe('ID_A');
  expect(manifest.resolveId(m, 'unknown-id')).toBe('unknown-id');
});

test('baseVersion returns max(lastPulled,lastPushed) for a file, or undefined when unknown', () => {
  const m = { remote: 'r', prototypes: {
    'a.html': { id: 'ID_A', lastPulled: 2, lastPushed: 3 },
    'b.html': { id: 'ID_B', lastPulled: 5 },
    'c.html': { id: 'ID_C' },
  } };
  expect(manifest.baseVersion(m, 'a.html')).toBe(3);
  expect(manifest.baseVersion(m, 'b.html')).toBe(5);
  expect(manifest.baseVersion(m, 'c.html')).toBeUndefined();
  expect(manifest.baseVersion(m, 'ID_A')).toBe(3); // resolves via id too
});

test('recordPull/recordPush persist version numbers to disk keyed by file', () => {
  const p = tmpManifest(JSON.stringify({ remote: 'r', prototypes: { 'a.html': { id: 'ID_A' } } }));
  let m = manifest.load(p);
  manifest.recordPull(m, 'a.html', 2, p);
  manifest.recordPush(m, 'a.html', 3, p);
  const reloaded = manifest.load(p);
  expect(reloaded.prototypes['a.html'].lastPulled).toBe(2);
  expect(reloaded.prototypes['a.html'].lastPushed).toBe(3);
});

test('recordPull is a no-op-safe when the target is an id not present as a file key', () => {
  const p = tmpManifest(JSON.stringify({ remote: 'r', prototypes: { 'a.html': { id: 'ID_A' } } }));
  const m = manifest.load(p);
  // Passing the id (not the file) should still update the a.html entry via reverse lookup.
  manifest.recordPull(m, 'ID_A', 7, p);
  expect(manifest.load(p).prototypes['a.html'].lastPulled).toBe(7);
});
