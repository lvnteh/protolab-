// src/services/docSource.js
// Reads a GitHub repo's Markdown over the REST API (no clone). Behind the same
// surface the /docs routes expect. Paths/refs are validated before use; a small
// TTL cache keeps browsing responsive and under rate limits.
const path = require('path');
const IGNORED = new Set(['README.md', 'CLAUDE.md']);
const API = 'https://api.github.com';

function assertSafePath(p) {
  const norm = path.posix.normalize(String(p || ''));
  if (!norm.endsWith('.md') || norm.startsWith('/') || norm.startsWith('..') || norm.includes('../')) {
    throw new Error(`unsafe doc path: ${p}`);
  }
  return norm;
}
function assertRef(ref) {
  if (ref == null) return;
  if (!/^[0-9a-f]{7,64}$/.test(ref) && !/^[\w.\-/]{1,120}$/.test(ref)) throw new Error(`invalid ref: ${ref}`);
}
function titleFromPath(p) { return path.posix.basename(p).replace(/\.md$/, ''); }

function createDocSource({ owner, repo, token, defaultBranch = 'main', fetchImpl = fetch, ttlMs = 15000 }) {
  const cache = new Map(); // key -> { at, val }
  async function gh(pathAndQuery) {
    const now = Date.now();
    const hit = cache.get(pathAndQuery);
    if (hit && now - hit.at < ttlMs) return hit.val;
    const res = await fetchImpl(`${API}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'protoshare-docs' },
    });
    if (!res.ok) throw new Error(`GitHub GET ${pathAndQuery} -> ${res.status}`);
    const val = await res.json();
    cache.set(pathAndQuery, { at: now, val });
    return val;
  }

  async function listDocs() {
    const tree = await gh(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`);
    const paths = (tree.tree || [])
      .filter((n) => n.type === 'blob' && n.path.endsWith('.md') && !IGNORED.has(path.posix.basename(n.path)))
      .map((n) => n.path);
    // one bounded recent-commits scan for best-effort creation dates
    const dates = {};
    try {
      const commits = await gh(`/repos/${owner}/${repo}/commits?per_page=100`);
      for (const c of (commits || [])) {
        const d = c.commit && c.commit.committer && c.commit.committer.date;
        if (d && Array.isArray(c.files)) for (const f of c.files) if (f.filename && !(f.filename in dates)) dates[f.filename] = d;
      }
    } catch { /* best-effort */ }
    return paths.sort().map((p) => ({ path: p, title: titleFromPath(p), created: dates[p] || null }));
  }

  async function resolveVersionSha(p) {
    const safe = assertSafePath(p);
    const rows = await gh(`/repos/${owner}/${repo}/commits?path=${encodeURIComponent(safe)}&per_page=1`);
    return (rows && rows[0] && rows[0].sha) || null;
  }

  async function readDoc(p, ref) {
    const safe = assertSafePath(p);
    assertRef(ref);
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const data = await gh(`/repos/${owner}/${repo}/contents/${safe.split('/').map(encodeURIComponent).join('/')}${q}`);
    const raw = data.encoding === 'base64' ? Buffer.from(data.content, 'base64').toString('utf8') : (data.content || '');
    const versionSha = ref && /^[0-9a-f]{7,64}$/.test(ref) ? ref : await resolveVersionSha(safe);
    return { raw, versionSha, dirty: false };
  }

  async function recentVersions(p, limit = 20) {
    const safe = assertSafePath(p);
    const rows = await gh(`/repos/${owner}/${repo}/commits?path=${encodeURIComponent(safe)}&per_page=${limit}`);
    return (rows || []).map((c) => ({ sha: c.sha, date: (c.commit && c.commit.committer && c.commit.committer.date) || '', subject: (c.commit && c.commit.message || '').split('\n')[0] }));
  }

  return { listDocs, resolveVersionSha, readDoc, recentVersions, owner, repo };
}

module.exports = { createDocSource, assertSafePath };
