// tests/doc-source.test.js
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createDocSource } = require('../src/services/docSource');

function sh(cwd, args) { execFileSync('git', args, { cwd, stdio: 'pipe' }); }

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docsrc-'));
  sh(dir, ['init', '-q']);
  sh(dir, ['config', 'user.email', 't@t.t']);
  sh(dir, ['config', 'user.name', 'T']);
  sh(dir, ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
  fs.mkdirSync(path.join(dir, 'guide'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'guide/intro.md'), '---\ntitle: Intro\n---\n# Intro\nhello\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# ignore me\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'init']);
  return dir;
}

test('listDocs returns tracked .md with titles + creation dates, excludes README', async () => {
  const ds = createDocSource(makeRepo());
  const docs = await ds.listDocs();
  expect(docs).toHaveLength(1);
  expect(docs[0]).toMatchObject({ path: 'guide/intro.md', title: 'Intro' });
  expect(docs[0]).toHaveProperty('created');
  // committed in the fixture, so a first-add date is known
  expect(docs[0].created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

test('resolveVersionSha + readDoc return committed content at a real sha', async () => {
  const ds = createDocSource(makeRepo());
  const sha = await ds.resolveVersionSha('guide/intro.md');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  const doc = await ds.readDoc('guide/intro.md');
  expect(doc.versionSha).toBe(sha);
  expect(doc.raw).toContain('# Intro');
  expect(doc.dirty).toBe(false);
});

test('dirty working tree is reported', async () => {
  const dir = makeRepo();
  const ds = createDocSource(dir);
  fs.appendFileSync(path.join(dir, 'guide/intro.md'), '\nedited\n');
  const doc = await ds.readDoc('guide/intro.md');
  expect(doc.dirty).toBe(true);
  expect(doc.raw).not.toContain('edited'); // committed content, not working tree
});

test('never-committed file reads from the working tree with null sha', async () => {
  const dir = makeRepo();
  const ds = createDocSource(dir);
  fs.writeFileSync(path.join(dir, 'guide/new.md'), '# New\n');
  const doc = await ds.readDoc('guide/new.md');
  expect(doc.versionSha).toBeNull();
  expect(doc.raw).toContain('# New');
  expect(doc.dirty).toBe(true);
});

test('repoSlug parses ssh and https remotes', async () => {
  const ssh = createDocSource(makeRepo());
  expect(await ssh.repoSlug()).toEqual({ owner: 'acme', repo: 'widgets' });

  const dir = makeRepo();
  execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git'], { cwd: dir });
  expect(await createDocSource(dir).repoSlug()).toEqual({ owner: 'acme', repo: 'widgets' });
});

test('rejects path traversal and non-markdown', async () => {
  const ds = createDocSource(makeRepo());
  await expect(ds.readDoc('../../etc/passwd')).rejects.toThrow(/unsafe/i);
  await expect(ds.readDoc('/abs/x.md')).rejects.toThrow(/unsafe/i);
  await expect(ds.readDoc('guide/intro.txt')).rejects.toThrow(/unsafe/i);
});
