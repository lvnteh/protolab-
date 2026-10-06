// src/routes/docs.js
// Thin HTTP layer translating between the docs SDK and the git/GitHub services.
// Holds no state. deps are injectable for tests; omitted => built from config.
const fs = require('fs');
const path = require('path');
const express = require('express');
const { createReloadHub } = require('../services/reloadHub');

function defaultReadView(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'views', name), 'utf8');
}

function buildRealDeps() {
  const config = require('../config');
  const markdown = require('../services/markdown');
  const { createDocSource } = require('../services/docSource');
  const { createGhComments, resolveToken } = require('../services/ghComments');
  const docSource = createDocSource(config.docsRepoPath);
  let client = null;
  // Async factory: build the GitHub client once, lazily (needs repoSlug + token).
  const ghComments = async () => {
    if (!client) {
      const { owner, repo } = await docSource.repoSlug();
      client = createGhComments({ owner, repo, token: resolveToken() });
    }
    return client;
  };
  return { docSource, ghComments, markdown, readView: defaultReadView, watchRoot: config.docsRepoPath };
}

function createDocsRouter(deps) {
  const router = express.Router();
  const resolved = deps || buildRealDeps();
  const { docSource, markdown, readView = defaultReadView } = resolved;
  // ghComments is an async factory in real wiring, or a ready object in tests.
  const resolveGh = typeof resolved.ghComments === 'function'
    ? resolved.ghComments
    : async () => resolved.ghComments;

  const hub = createReloadHub();
  if (resolved.watchRoot) {
    try {
      require('fs').watch(resolved.watchRoot, { recursive: true }, (_e, name) => {
        if (!name || name.endsWith('.md')) hub.broadcast();
      });
    } catch { /* recursive watch unsupported on this platform; skip live-reload */ }
  }

  router.get('/__events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    if (res.flushHeaders) res.flushHeaders();
    const unsub = hub.subscribe((msg) => res.write(`data: ${msg}\n\n`));
    req.on('close', unsub);
  });

  router.get('/', async (_req, res, next) => {
    try {
      const docs = await docSource.listDocs();
      const html = readView('docs-shell.html')
        .split('{{banner}}').join('')
        .split('{{content}}').join('')
        .split('{{cfg}}').join(JSON.stringify({ mode: 'list', docs }).replace(/</g, '\\u003c'));
      res.send(html);
    } catch (e) { next(e); }
  });

  router.get('/view', async (req, res, next) => {
    try {
      const { raw, versionSha, dirty } = await docSource.readDoc(req.query.path, req.query.sha || undefined);
      const { html } = markdown.render(raw, { sourceLines: true });
      const banner = dirty
        ? `<div class="docs__banner">Uncommitted local changes are hidden; comments attach to ${versionSha ? versionSha.slice(0, 7) : 'this file once committed'}.</div>`
        : '';
      const versions = await docSource.recentVersions(req.query.path).catch(() => []);
      const docs = await docSource.listDocs().catch(() => []);
      const cfg = { mode: 'view', path: req.query.path, sha: versionSha, commentable: !!versionSha, versions, docs };
      const out = readView('docs-shell.html')
        .split('{{banner}}').join(banner)
        .split('{{content}}').join(html)
        .split('{{cfg}}').join(JSON.stringify(cfg).replace(/</g, '\\u003c'));
      res.send(out);
    } catch (e) { next(e); }
  });

  router.get('/comments', async (req, res, next) => {
    try {
      const { sha, path: p } = req.query;
      if (!sha || !/^[0-9a-f]{7,64}$/.test(sha)) {
        return res.status(400).json({ error: 'invalid sha' });
      }
      const client = await resolveGh();
      res.json(await client.list(sha, p));
    } catch (e) { next(e); }
  });

  router.post('/comments', async (req, res, next) => {
    try {
      const { path: p, sha, line, kind, text, anchor, tag, replyTo } = req.body;
      const doc = await docSource.readDoc(p, sha || undefined);
      if (!doc.versionSha) return res.status(409).json({ error: 'Commit this file before annotating.' });
      const client = await resolveGh();
      const created = await client.post(doc.versionSha, { path: p, line, kind, text, anchor, tag, replyTo });
      res.status(201).json(created);
    } catch (e) { next(e); }
  });

  router.delete('/comments/:id', async (req, res, next) => {
    try {
      const client = await resolveGh();
      await client.del(req.params.id);
      res.status(204).end();
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = { createDocsRouter };
