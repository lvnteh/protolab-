// mcp/lib/handlers.cjs
// The six MCP tool handlers. Each is async (ctx, args) => string, where the
// string is the human-readable tool result. ctx bundles the injected client,
// the loaded manifest, its path, and file/manifest I/O (injected so the file
// side is testable). No network or storage rules live here — those are the
// REST layer's job; handlers only resolve file↔id, call the client, format
// output, and keep the manifest's lastPulled/lastPushed in sync.
const manifestLib = require('./manifest.cjs');

async function list(ctx) {
  const items = await ctx.client.list();
  if (!items.length) return 'No prototypes found for this token.';
  return items.map(p => {
    const pub = p.publishedVersion != null ? `published v${p.publishedVersion}` : 'no published version';
    const draft = p.draftVersion != null ? `, draft v${p.draftVersion}` : '';
    return `• ${p.name} [${p.id}] — ${pub}${draft}\n  ${p.shareLink || ''}`;
  }).join('\n');
}

async function pull(ctx, { file_or_id }) {
  const id = manifestLib.resolveId(ctx.manifest, file_or_id);
  const fb = await ctx.client.feedback(id);
  const open = fb.comments.filter(c => !c.resolved);
  const lines = [];
  lines.push(`Feedback for "${fb.prototype.name}" [${fb.prototype.id}] — published v${fb.prototype.publishedVersion ?? '?'}${fb.prototype.draftVersion != null ? `, draft v${fb.prototype.draftVersion}` : ''}`);
  lines.push('');
  lines.push(`Comments (${open.length} open / ${fb.comments.length} total):`);
  if (!fb.comments.length) lines.push('  (none)');
  for (const c of fb.comments) {
    const tag = c.tag ? `[${c.tag}] ` : '';
    const status = c.resolved ? '✓resolved' : 'open';
    const el = c.element ? ` @ ${c.element.selector}` : '';
    lines.push(`  • (${status}, v${c.madeAgainstVersion}) ${tag}${c.comment}${el} — ${c.email}`);
    for (const r of c.replies || []) lines.push(`      ↳ ${r.comment} — ${r.email}`);
  }
  lines.push('');
  lines.push(`Explanations (${fb.explanations.length}):`);
  for (const e of fb.explanations) lines.push(`  • ${e.elementSelector}: ${e.body}`);

  // Record the highest version we've now observed (published OR an existing
  // draft). The server's conflict guard compares baseVersion against
  // latestVersion = MAX(version) incl. drafts, so recording only the published
  // number would make a fresh client send a stale base whenever an unpublished
  // draft exists (e.g. authored elsewhere) → false-positive 409. Recording the
  // max keeps the client's base aligned with the server's basis.
  const seen = Math.max(fb.prototype.publishedVersion || 0, fb.prototype.draftVersion || 0);
  if (seen > 0) {
    manifestLib.recordPull(ctx.manifest, file_or_id, seen);
    if (ctx.saveManifest) ctx.saveManifest(ctx.manifest);
  }
  return lines.join('\n');
}

async function source(ctx, { file_or_id, version, overwrite }) {
  const id = manifestLib.resolveId(ctx.manifest, file_or_id);
  const html = await ctx.client.source(id, version);
  const fileKey = manifestLib.fileKeyFor(ctx.manifest, file_or_id);
  if (fileKey) {
    // Dirty-check: never clobber local edits. Read the current file; if it
    // exists and differs from the fetched HTML, refuse unless overwrite:true.
    // ENOENT = no local file yet → safe to write.
    if (overwrite !== true) {
      let current;
      try {
        current = ctx.readFile(fileKey);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        current = null; // absent — safe to write
      }
      if (current != null && current !== html) {
        return `Local ${fileKey} has changes that differ from ${version ? `v${version}` : 'the published version'}. Re-run with overwrite:true to replace it, or diff/back up first.`;
      }
    }
    try {
      ctx.writeFile(fileKey, html);
    } catch (e) {
      return `Failed to write to ${fileKey}: ${e.message}. Check the path exists and is writable, and that you're running from the prototype repo root.`;
    }
    return `Wrote ${html.length} bytes of ${version ? `v${version}` : 'the published version'} to ${fileKey}.`;
  }
  // No local file mapping — return the HTML inline so the agent still gets it.
  return html;
}

async function push(ctx, { file, note }) {
  const id = manifestLib.resolveId(ctx.manifest, file);
  const base = manifestLib.baseVersion(ctx.manifest, file);
  let buffer;
  try {
    buffer = Buffer.from(ctx.readFile(file));
  } catch (e) {
    if (e.code === 'ENOENT') return `Local file "${file}" not found — nothing to push.`;
    throw e;
  }
  try {
    const res = await ctx.client.pushVersion(id, { buffer, filename: file, note, baseVersion: base });
    manifestLib.recordPush(ctx.manifest, file, res.version);
    if (ctx.saveManifest) ctx.saveManifest(ctx.manifest);
    return `Pushed ${file} as draft v${res.version}. Publish it with protoshare_publish to make it live.`;
  } catch (e) {
    if (e.status === 409) {
      const cur = e.body && e.body.currentVersion;
      return `Conflict: the remote moved on (current version ${cur}); your push was based on v${base ?? '—'} (the highest version this manifest has seen). To recover: pull the latest with protoshare_source, integrate your local changes into it, then push again.`;
    }
    if (e.status === 404) return `Prototype for "${file}" not found (or not owned by this token).`;
    if (e.status === 401) return `Unauthorized — check PROTOSHARE_TOKEN.`;
    throw e;
  }
}

async function publish(ctx, { file_or_id, version }) {
  const id = manifestLib.resolveId(ctx.manifest, file_or_id);
  try {
    const res = await ctx.client.publish(id, version);
    return `Published v${res.version}. The share link now serves it.`;
  } catch (e) {
    if (e.status === 409) return `Cannot publish: ${e.body && e.body.error ? e.body.error : 'version not found or already published'}.`;
    if (e.status === 404) return `Prototype not found (or not owned by this token).`;
    throw e;
  }
}

async function status(ctx, { file_or_id }) {
  const id = manifestLib.resolveId(ctx.manifest, file_or_id);
  const key = manifestLib.fileKeyFor(ctx.manifest, file_or_id);
  const entry = key ? ctx.manifest.prototypes[key] : {};
  const remote = await ctx.client.versions(id);
  const latest = remote.length ? Math.max(...remote.map(v => v.version)) : null;
  const published = remote.find(v => v.status === 'published');
  const lines = [
    `Status for ${key || id}:`,
    `  Local:  lastPulled v${entry.lastPulled ?? '—'}, lastPushed v${entry.lastPushed ?? '—'}`,
    `  Remote: latest v${latest ?? '—'}${published ? `, published v${published.version}` : ''}`,
  ];
  if (typeof entry.lastPushed === 'number' && typeof entry.lastPulled === 'number' && entry.lastPushed > entry.lastPulled) {
    lines.push('  (you have local pushes ahead of your last pull)');
  }
  return lines.join('\n');
}

async function resolve(ctx, { file_or_id, comment_id, version }) {
  const id = manifestLib.resolveId(ctx.manifest, file_or_id);
  try {
    await ctx.client.resolveComment(id, comment_id, version);
    return `Marked comment ${comment_id} resolved${version != null ? ` in v${version}` : ''}.`;
  } catch (e) {
    if (e.status === 404) return `Comment ${comment_id} not found on this prototype (or not owned by this token).`;
    throw e;
  }
}

module.exports = { list, pull, source, push, publish, status, resolve };
