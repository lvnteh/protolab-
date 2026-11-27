// src/routes/delivery.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db');
const { injectSdk, injectBridge, shellSdkTag } = require('../services/inject');
const customerAuth = require('../middleware/customerAuth');
const config = require('../config');
const storage = require('../services/storage');
const versions = require('../services/versions');
const markdown = require('../services/markdown');
const orgs = require('../services/orgs');

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
  // Effective reviewer access (Task 6): an email qualifies via an explicit
  // allowlist row OR as the canonical email of a current admin/viewer member of
  // the prototype's owning org. So a logged-out same-org admin/viewer can open
  // their own org's share link by entering their account email, with NO explicit
  // allowlist entry. Membership in another org grants nothing (the resolver pins
  // to prototype.org_id).
  const { allowed } = await orgs.effectiveReviewerAccess(proto.id, email);

  if (!allowed) {
    const html = readView('email-entry.html')
      .split('{{shareToken}}').join(req.params.shareToken)
      .split('{{error}}').join('<div class="alert">That email isn\'t on the access list for this prototype.</div>');
    return res.status(403).send(html);
  }

  req.session.customerEmail = email;
  req.session.prototypeId = proto.id;
  res.redirect(`/p/${req.params.shareToken}/view`);
});

// Resolve which prototype + version to serve for an authenticated view request.
// Returns { proto, documentHtml, contentType, servedVersion } or sends an error
// response and returns null. Shared by the /view and /raw handlers so both agree
// on exactly which bytes are served.
async function resolveServed(req, res) {
  const { rows } = await getDb().query(
    'SELECT * FROM prototypes WHERE share_token = $1',
    [req.params.shareToken]
  );
  const proto = rows[0];
  if (!proto) { res.status(404).send('Prototype not found.'); return null; }
  if (req.session.prototypeId !== proto.id) { res.status(403).send('Access denied.'); return null; }
  // Re-check effective access on EVERY protected read (Task 6): a reviewer whose
  // membership-derived grant was revoked (removed from the org, or the allowlist
  // entry deleted with no remaining membership) loses access on their next
  // request even though their session still names this prototype. An independent
  // explicit allowlist entry keeps a removed member in.
  const { allowed } = await orgs.effectiveReviewerAccess(proto.id, req.session.customerEmail);
  if (!allowed) { res.status(403).send('Access denied.'); return null; }

  // Resolve which version to serve. An explicit ?version=N is honored only when
  // it names a PUBLISHED version of this prototype; a draft/unknown/non-integer
  // ?version 302-redirects to the bare live view (never leaks a draft). Absent
  // ?version keeps the current-published behavior.
  let served;
  if (req.query.version != null) {
    const n = parseInt(req.query.version, 10);
    served = Number.isNaN(n) ? null : await versions.resolvePublishedVersion(proto.id, n);
    if (!served) { res.redirect(302, `/p/${req.params.shareToken}/view`); return null; }
  } else {
    const pub = await versions.resolvePublished(proto.id);
    served = pub ? { ...pub, version: await versions.publishedVersionNumber(proto.id) } : null;
  }
  const filename = served ? served.filename : proto.filename;
  const contentType = served ? served.contentType : (proto.content_type || 'html');
  const servedVersion = served ? served.version : null;
  const raw = await storage.getPrototype(filename);
  if (raw === null) { res.status(404).send('Prototype file not found.'); return null; }

  let documentHtml;
  if (contentType === 'markdown') {
    const { html } = markdown.render(raw);
    documentHtml = readView('markdown-shell.html').split('{{content}}').join(html);
  } else {
    documentHtml = raw;
  }
  return { proto, documentHtml, contentType, servedVersion };
}

// Lock scripts to same-origin for the markdown view ONLY. We fully control that
// output (sanitized render + our own same-origin SDK). NOT applied to HTML
// prototypes, whose author markup may legitimately use inline scripts/handlers.
function setMarkdownCsp(res) {
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
}

router.get('/:shareToken/view', customerAuth, async (req, res) => {
  const resolved = await resolveServed(req, res);
  if (!resolved) return;
  const { proto, documentHtml, contentType, servedVersion } = resolved;

  const publishedVersions = await versions.listPublishedVersions(proto.id);
  const versionCtx = {
    version: servedVersion,
    versions: publishedVersions, // [{version, note, createdAt, contentType, isCurrent}]
    viewBase: `/p/${req.params.shareToken}/view`,
  };

  let output;
  if (contentType === 'markdown') {
    // Markdown is served in-document: the SDK anchors range comments into the
    // rendered body, so there is no iframe and the shell CSP applies.
    setMarkdownCsp(res);
    output = injectSdk(documentHtml, proto.id, req.session.customerEmail, contentType, versionCtx);
  } else {
    // HTML prototypes are served inside a shell iframe so the ProtoLab sidebar is
    // a hard viewport boundary the prototype can never overlap. The shell hosts
    // the full SDK; the prototype itself (served at /raw) carries only the bridge.
    const qs = req.query.version != null ? `?version=${encodeURIComponent(req.query.version)}` : '';
    const rawSrc = `/p/${req.params.shareToken}/raw${qs}`;
    output = readView('proto-shell.html')
      .split('{{rawSrc}}').join(rawSrc)
      .split('{{sdkTag}}').join(shellSdkTag(proto.id, req.session.customerEmail, versionCtx));
  }

  await getDb().query(
    'INSERT INTO access_log (prototype_id, email, opened_at, user_agent) VALUES ($1,$2,$3,$4)',
    [proto.id, req.session.customerEmail, new Date().toISOString(), req.headers['user-agent'] || '']
  );

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(output);
});

// Raw HTML-prototype content for the shell iframe. Carries only the lightweight
// frame-bridge (not the full SDK). Markdown is never served here — it has no
// iframe — so a markdown token 302s to its in-document /view.
router.get('/:shareToken/raw', customerAuth, async (req, res) => {
  const resolved = await resolveServed(req, res);
  if (!resolved) return;
  const { documentHtml, contentType } = resolved;
  if (contentType === 'markdown') {
    return res.redirect(302, `/p/${req.params.shareToken}/view`);
  }
  const output = injectBridge(documentHtml);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(output);
});

module.exports = router;
