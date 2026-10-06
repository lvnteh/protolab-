// src/services/docsRepos.js
// Per-org registry of GitHub repos usable in the Docs workflow. Repos are added
// by URL (validated + access-verified against the GitHub API), never cloned.
const { nanoid } = require('nanoid');
const { getDb } = require('../db');

function parseGithubUrl(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { throw new Error('invalid url'); }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'github.com') {
    throw new Error('not a github.com url');
  }
  const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) throw new Error('could not parse owner/repo');
  return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
}

async function verifyAccess(owner, repo, token, fetchImpl) {
  const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'protoshare-docs' },
  });
  if (!res.ok) throw new Error(`no access to ${owner}/${repo} (GitHub ${res.status})`);
  return res.json();
}

async function addRepo({ orgId, url, userId, token, fetchImpl = fetch }) {
  const { owner, repo } = parseGithubUrl(url);
  const meta = await verifyAccess(owner, repo, token, fetchImpl);
  const id = nanoid(12);
  const html = `https://github.com/${owner}/${repo}`;
  const { rows } = await getDb().query(
    `INSERT INTO docs_repos (id, org_id, owner, repo, html_url, default_branch, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [id, orgId, owner, repo, html, meta.default_branch || 'main', userId || null, new Date().toISOString()]);
  return rows[0];
}

async function listRepos(orgId) {
  const { rows } = await getDb().query('SELECT * FROM docs_repos WHERE org_id = $1 ORDER BY created_at ASC', [orgId]);
  return rows;
}
async function getRepo(orgId, id) {
  const { rows } = await getDb().query('SELECT * FROM docs_repos WHERE org_id = $1 AND id = $2', [orgId, id]);
  return rows[0] || null;
}
async function removeRepo(orgId, id) {
  const { rowCount } = await getDb().query('DELETE FROM docs_repos WHERE org_id = $1 AND id = $2', [orgId, id]);
  return rowCount > 0;
}

module.exports = { parseGithubUrl, addRepo, listRepos, getRepo, removeRepo };
