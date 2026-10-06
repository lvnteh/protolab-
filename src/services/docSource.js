// src/services/docSource.js
// Reads a local git clone of a docs repo. All git access is isolated here so a
// future hosted/server-clone or GitHub-API implementation can replace this
// module behind the same surface. Paths are validated against traversal.
const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const pexec = promisify(execFile);

const IGNORED = new Set(['README.md', 'CLAUDE.md']);

function createDocSource(repoPath) {
  async function git(args) {
    const { stdout } = await pexec('git', args, { cwd: repoPath, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  }

  // Reject absolute paths, traversal, and non-.md. Returns a normalized posix path.
  function assertSafePath(p) {
    const norm = path.posix.normalize(String(p || ''));
    if (!norm.endsWith('.md') || norm.startsWith('/') || norm.startsWith('..') || norm.includes('../')) {
      throw new Error(`unsafe doc path: ${p}`);
    }
    return norm;
  }

  function titleFor(raw, fallbackPath) {
    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      const t = fm[1].match(/^title:\s*(.+)\s*$/m);
      if (t) return t[1].trim().replace(/^["']|["']$/g, '');
    }
    const h1 = raw.match(/^#\s+(.+)$/m);
    if (h1) return h1[1].trim();
    return path.posix.basename(fallbackPath).replace(/\.md$/, '');
  }

  // First-add ("creation") date per .md path, in ONE pass over history
  // (oldest commit first, added files only), so date-sorting the tree needs no
  // per-file git calls. Returns a { path: ISO-string } map; missing on failure.
  async function createdDates() {
    let out = '';
    try {
      out = await git(['log', '--reverse', '--diff-filter=A', '--name-only', '--format=@%cI', '--', '*.md']);
    } catch { return {}; }
    const dates = {};
    let cur = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('@')) { cur = line.slice(1).trim(); continue; }
      const f = line.trim();
      if (f && f.endsWith('.md') && cur && !(f in dates)) dates[f] = cur;
    }
    return dates;
  }

  async function listDocs() {
    const out = await git(['ls-files', '-z', '*.md']);
    const paths = out.split('\0').filter(Boolean)
      .filter((p) => !IGNORED.has(path.posix.basename(p)));
    const dates = await createdDates();
    const docs = [];
    for (const p of paths) {
      let raw = '';
      try { raw = await fs.readFile(path.join(repoPath, p), 'utf8'); } catch { /* unreadable */ }
      docs.push({ path: p, title: titleFor(raw, p), created: dates[p] || null });
    }
    docs.sort((a, b) => a.path.localeCompare(b.path));
    return docs;
  }

  async function resolveVersionSha(p) {
    const safe = assertSafePath(p);
    const out = (await git(['log', '-1', '--format=%H', '--', safe])).trim();
    return out || null;
  }

  async function readDoc(p, sha) {
    const safe = assertSafePath(p);
    const versionSha = sha || await resolveVersionSha(safe);
    if (!versionSha) {
      const raw = await fs.readFile(path.join(repoPath, safe), 'utf8');
      return { raw, versionSha: null, dirty: true };
    }
    const raw = await git(['show', `${versionSha}:${safe}`]);
    const status = (await git(['status', '--porcelain', '--', safe])).trim();
    return { raw, versionSha, dirty: status.length > 0 };
  }

  async function recentVersions(p, limit = 20) {
    const safe = assertSafePath(p);
    const out = await git(['log', `-${limit}`, '--format=%H%x09%cs%x09%s', '--', safe]);
    return out.trim().split('\n').filter(Boolean).map((l) => {
      const [sha, date, subject] = l.split('\t');
      return { sha, date, subject };
    });
  }

  async function repoSlug() {
    const url = (await git(['remote', 'get-url', 'origin'])).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
    if (!m) throw new Error(`cannot parse owner/repo from origin remote: ${url}`);
    return { owner: m[1], repo: m[2] };
  }

  return { listDocs, resolveVersionSha, readDoc, recentVersions, repoSlug };
}

module.exports = { createDocSource };
