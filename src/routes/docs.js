// src/routes/docs.js
const fs = require('fs');
const path = require('path');
const express = require('express');

function defaultReadView(name) { return fs.readFileSync(path.join(__dirname, '..', 'views', name), 'utf8'); }
const SHA_RE = /^[0-9a-f]{7,64}$/;

function buildRealDeps() {
  const orgs = require('../services/orgs');
  const bareRepos = require('../services/docsRepos');
  const markdown = require('../services/markdown');
  const { createDocSource } = require('../services/docSource');
  const { createGhComments, resolveToken } = require('../services/ghComments');
  let cachedToken;
  const token = () => (cachedToken !== undefined ? cachedToken : (cachedToken = (() => { try { return resolveToken(); } catch { return null; } })()));
  // Wrap addRepo to inject the token so the route call site stays token-free.
  const docsRepos = { ...bareRepos, addRepo: (args) => bareRepos.addRepo({ ...args, token: token() }) };
  return {
    docsRepos, markdown, readView: defaultReadView,
    requireOrg: orgs.requireOrg, requireAdmin: orgs.requireAdmin,
    tokenAvailable: () => !!token(),
    makeDocSource: (row) => createDocSource({ owner: row.owner, repo: row.repo, token: token(), defaultBranch: row.default_branch }),
    makeGhComments: (row) => createGhComments({ owner: row.owner, repo: row.repo, token: token() }),
  };
}

function createDocsRouter(deps) {
  const d = deps || buildRealDeps();
  const router = express.Router();
  const esc = (s) => JSON.stringify(s).replace(/</g, '\\u003c');

  // Map raw DB rows to a safe display shape for the browser: id + label (owner/repo) + url.
  // Drops org_id, created_by, created_at from the page payload.
  function mapRepos(rows) {
    return rows.map((r) => ({ id: r.id, label: `${r.owner}/${r.repo}`, url: r.html_url }));
  }

  // public: landing feature-check
  router.get('/enabled', (_req, res) => res.json({ enabled: !!d.tokenAvailable() }));

  // resolve + scope a repo row to the caller's org, or 404
  async function repoOr404(req, res) {
    const row = await d.docsRepos.getRepo(req.orgId, req.query.repo);
    if (!row) { res.status(404).send('Repo not found.'); return null; }
    return row;
  }

  router.get('/', d.requireOrg, async (req, res, next) => {
    try {
      const repos = await d.docsRepos.listRepos(req.orgId);
      const mappedRepos = mapRepos(repos);
      let docs = [];
      let selectedRepo = null;
      if (req.query.repo) {
        const row = await d.docsRepos.getRepo(req.orgId, req.query.repo);
        if (!row) { res.status(404).send('Repo not found.'); return; }
        selectedRepo = row.id;
        const ds = d.makeDocSource(row);
        try { docs = await ds.listDocs(); } catch { docs = []; }
      }
      const cfg = { mode: 'home', repo: selectedRepo, repos: mappedRepos, role: req.orgRole, docs };
      res.send(d.readView('docs-shell.html').split('{{banner}}').join('').split('{{content}}').join('').split('{{cfg}}').join(esc(cfg)));
    } catch (e) { next(e); }
  });

  router.get('/view', d.requireOrg, async (req, res, next) => {
    try {
      if (!req.query.path) return res.status(400).send('?path= is required');
      const row = await repoOr404(req, res); if (!row) return;
      const ds = d.makeDocSource(row);
      const { raw, versionSha, dirty } = await ds.readDoc(req.query.path, req.query.sha || undefined);
      const { html } = d.markdown.render(raw, { sourceLines: true });
      const banner = '';
      const repos = await d.docsRepos.listRepos(req.orgId);
      const mappedRepos = mapRepos(repos);
      const versions = await ds.recentVersions(req.query.path).catch(() => []);
      let docs = [];
      try { docs = await ds.listDocs(); } catch { docs = []; }
      const cfg = { mode: 'view', repo: row.id, repos: mappedRepos, role: req.orgRole, path: req.query.path, sha: versionSha, commentable: !!versionSha, versions, docs };
      res.send(d.readView('docs-shell.html').split('{{banner}}').join(banner).split('{{content}}').join(html).split('{{cfg}}').join(esc(cfg)));
    } catch (e) { next(e); }
  });

  router.get('/comments', d.requireOrg, async (req, res, next) => {
    try {
      const row = await repoOr404(req, res); if (!row) return;
      if (req.query.sha && !SHA_RE.test(req.query.sha)) return res.status(400).json({ error: 'invalid sha' });
      res.json(await d.makeGhComments(row).list(req.query.sha, req.query.path));
    } catch (e) { next(e); }
  });

  router.post('/comments', d.requireOrg, async (req, res, next) => {
    try {
      const row = await d.docsRepos.getRepo(req.orgId, req.body.repo);
      if (!row) return res.status(404).json({ error: 'repo not found' });
      const ds = d.makeDocSource(row);
      const doc = await ds.readDoc(req.body.path, req.body.sha || undefined);
      if (!doc.versionSha) return res.status(409).json({ error: 'no committed version' });
      const created = await d.makeGhComments(row).post(doc.versionSha, req.body);
      res.status(201).json(created);
    } catch (e) { next(e); }
  });

  router.delete('/comments/:id', d.requireOrg, async (req, res, next) => {
    try {
      const row = await repoOr404(req, res); if (!row) return;
      await d.makeGhComments(row).del(req.params.id);
      res.status(204).end();
    } catch (e) { next(e); }
  });

  router.get('/repos', d.requireOrg, async (req, res, next) => {
    try { res.json(await d.docsRepos.listRepos(req.orgId)); } catch (e) { next(e); }
  });

  router.post('/repos', d.requireAdmin, async (req, res, next) => {
    try {
      const row = await d.docsRepos.addRepo({ orgId: req.orgId, url: req.body.url, userId: req.session && req.session.userId });
      res.status(201).json(row);
    } catch (e) {
      if (e && e.code === '23505') return res.status(409).json({ error: 'already added' });
      if (/^(not a github\.com url|invalid url|could not parse owner\/repo)$/i.test(e.message)) {
        return res.status(400).json({ error: e.message });
      }
      // access-verify non-200 or a network failure to GitHub
      return res.status(502).json({ error: e.message });
    }
  });

  router.delete('/repos/:id', d.requireAdmin, async (req, res, next) => {
    try { res.json({ removed: await d.docsRepos.removeRepo(req.orgId, req.params.id) }); } catch (e) { next(e); }
  });

  return router;
}

module.exports = { createDocsRouter };
