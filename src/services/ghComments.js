// GitHub commit-comments client. GitHub is the single store for docs
// annotations; this module reads/writes them. Line/path/anchor live inside the
// comment body (see ghCommentCodec) because commit-comment positions are
// diff-relative and cannot address arbitrary file lines — ProtoLab re-anchors
// from the body. Uses global fetch (no new dependency).
const { execFileSync } = require('child_process');
const codec = require('./ghCommentCodec');

const API = 'https://api.github.com';

function resolveToken({ env = process.env, exec = execFileSync } = {}) {
  const t = env.DOCS_GITHUB_TOKEN || env.GITHUB_TOKEN;
  if (t) return t;
  try {
    const out = String(exec('gh', ['auth', 'token'], { encoding: 'utf8' })).trim();
    if (out) return out;
  } catch { /* gh not installed or not logged in */ }
  throw new Error('No GitHub token. Set DOCS_GITHUB_TOKEN (or GITHUB_TOKEN), or run `gh auth login`.');
}

function createGhComments({ owner, repo, token, fetchImpl = fetch }) {
  async function gh(method, path, bodyObj) {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'protoshare-docs',
        'Content-Type': 'application/json',
      },
      body: bodyObj ? JSON.stringify(bodyObj) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path} -> ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  function toComment(gc) {
    const parsed = codec.parseBody(gc.body);
    return {
      id: gc.id,
      author: gc.user ? gc.user.login : null,
      createdAt: gc.created_at,
      htmlUrl: gc.html_url,
      path: parsed.path || gc.path || null,
      line: parsed.line,
      text: parsed.text,
      kind: parsed.kind,
      anchor: parsed.anchor,
      tag: parsed.tag,
      replyTo: parsed.replyTo,
      hasMeta: parsed.hasMeta,
    };
  }

  async function list(sha, docPath) {
    const raw = await gh('GET', `/repos/${owner}/${repo}/commits/${sha}/comments?per_page=100`);
    return (raw || []).map(toComment).filter((c) => c.path === docPath);
  }

  async function post(sha, { path, line, text, kind, anchor, tag = null, replyTo = null }) {
    const body = codec.encodeBody({ text, kind, path, line, anchor, tag, replyTo });
    const gc = await gh('POST', `/repos/${owner}/${repo}/commits/${sha}/comments`, { body });
    return toComment(gc);
  }

  async function del(id) {
    await gh('DELETE', `/repos/${owner}/${repo}/comments/${id}`);
  }

  return { list, post, del };
}

module.exports = { resolveToken, createGhComments };
