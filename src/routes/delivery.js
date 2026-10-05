// src/routes/delivery.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db');
const { injectSdk } = require('../services/inject');
const customerAuth = require('../middleware/customerAuth');
const config = require('../config');
const storage = require('../services/storage');
const versions = require('../services/versions');
const markdown = require('../services/markdown');

const router = express.Router();

function readView(name) {
  return fs.readFileSync(path.join(__dirname, '../views', name), 'utf8');
}

router.get('/:shareToken', async (req, res) => {
  const { rows } = await getDb().query(
    'SELECT id FROM prototypes WHERE share_token = $1',
    [req.params.shareToken]
  );
  if (!rows[0]) return res.status(404).send('Prototype not found.');
  const html = readView('email-entry.html')
    .split('{{shareToken}}').join(req.params.shareToken)
    .split('{{error}}').join('');
  res.send(html);
});

router.post('/:shareToken/enter', async (req, res) => {
  const { rows: protoRows } = await getDb().query(
    'SELECT * FROM prototypes WHERE share_token = $1',
    [req.params.shareToken]
  );
  const proto = protoRows[0];
  if (!proto) return res.status(404).send('Prototype not found.');

  const email = (req.body.email || '').trim().toLowerCase();
  const { rows: allowRows } = await getDb().query(
    'SELECT 1 FROM allowlist WHERE prototype_id = $1 AND LOWER(email) = $2',
    [proto.id, email]
  );

  if (!allowRows.length) {
    const html = readView('email-entry.html')
      .split('{{shareToken}}').join(req.params.shareToken)
      .split('{{error}}').join('<div class="alert">That email isn\'t on the access list for this prototype.</div>');
    return res.status(403).send(html);
  }

  req.session.customerEmail = email;
  req.session.prototypeId = proto.id;
  res.redirect(`/p/${req.params.shareToken}/view`);
});

router.get('/:shareToken/view', customerAuth, async (req, res) => {
  const { rows } = await getDb().query(
    'SELECT * FROM prototypes WHERE share_token = $1',
    [req.params.shareToken]
  );
  const proto = rows[0];
  if (!proto) return res.status(404).send('Prototype not found.');
  if (req.session.prototypeId !== proto.id) return res.status(403).send('Access denied.');

  // Serve the published version's file. Markdown versions are rendered to a
  // sanitized HTML document first; HTML versions are served as-is. Either way
  // the SDK is injected into the final HTML.
  // Resolve which version to serve. An explicit ?version=N is honored only when
  // it names a PUBLISHED version of this prototype; a draft/unknown/non-integer
  // ?version 302-redirects to the bare live view (never leaks a draft). Absent
  // ?version keeps the current-published behavior.
  let served;
  if (req.query.version != null) {
    const n = parseInt(req.query.version, 10);
    served = Number.isNaN(n) ? null : await versions.resolvePublishedVersion(proto.id, n);
    if (!served) return res.redirect(302, `/p/${req.params.shareToken}/view`);
  } else {
    const pub = await versions.resolvePublished(proto.id); // {filename, contentType} | null
    served = pub ? { ...pub, version: await versions.publishedVersionNumber(proto.id) } : null;
  }
  const filename = served ? served.filename : proto.filename;
  const contentType = served ? served.contentType : (proto.content_type || 'html');
  const servedVersion = served ? served.version : null;
  const raw = await storage.getPrototype(filename);
  if (raw === null) return res.status(404).send('Prototype file not found.');

  let documentHtml;
  if (contentType === 'markdown') {
    const { html } = markdown.render(raw);
    documentHtml = readView('markdown-shell.html').split('{{content}}').join(html);
    // CSP for the markdown view ONLY. We fully control this output (sanitized
    // render + our own same-origin SDK), so we can lock scripts to same-origin —
    // blocking any script/object/frame injection that slipped past the sanitizer.
    // scripts: 'self' (the injected /sdk/*.js); styles: 'unsafe-inline' (the shell
    // + SDK inject inline <style>/style attrs); connect: 'self' (SDK fetches /api).
    // img-src stays permissive (https/data) so legitimate docs embedding images by
    // absolute URL still render — the residual tracking-pixel vector is accepted for
    // this internal, allowlisted-reviewer tool. NOT applied to HTML prototypes,
    // whose author markup may legitimately use inline scripts/handlers.
    res.setHeader('Content-Security-Policy', [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' https: data:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; '));
  } else {
    documentHtml = raw;
  }

  const publishedVersions = await versions.listPublishedVersions(proto.id);
  const versionCtx = {
    version: servedVersion,
    versions: publishedVersions, // [{version, note, createdAt, contentType, isCurrent}]
    viewBase: `/p/${req.params.shareToken}/view`,
  };
  const injected = injectSdk(documentHtml, proto.id, req.session.customerEmail, contentType, versionCtx);

  await getDb().query(
    'INSERT INTO access_log (prototype_id, email, opened_at, user_agent) VALUES ($1,$2,$3,$4)',
    [proto.id, req.session.customerEmail, new Date().toISOString(), req.headers['user-agent'] || '']
  );

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(injected);
});

module.exports = router;
