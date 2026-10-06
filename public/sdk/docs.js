// public/sdk/docs.js
// Docs-mode review client: renders the folder tree + annotation sidebar and
// turns a rendered-text selection into a GitHub commit comment. Reuses
// FBAnchor (anchor.js) for durable text anchoring; the raw line for GitHub
// comes from the nearest [data-source-line] block injected by the renderer.
//
// NOTE — FBAnchor API adaptation (confirmed from anchor.js):
//   - FBAnchor.serializeSelection(range, root): first arg is a DOM Range, NOT a
//     Selection. We extract range via sel.getRangeAt(0) before calling.
//   - FBAnchor.wrapRange(range, root, makeMark): takes a resolved DOM Range (not
//     an anchor JSON object), a root element, and a mark-element factory.
//     We use FBAnchor.resolveAnchor(anchor, root) to turn the stored anchor into
//     a Range before calling wrapRange.
//   Brief described wrapRange(root, anchor) and serializeSelection(root, sel) —
//   both argument orders differ from the real implementation.

function nearestSourceLine(node) {
  let el = node;
  while (el) {
    const v = el.getAttribute && el.getAttribute('data-source-line');
    if (v != null) return parseInt(v, 10);
    el = el.parentElement;
  }
  return null;
}

function buildTree(docs) {
  const root = { name: '', children: [] };
  for (const doc of docs) {
    const parts = doc.path.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = isFile ? { name: part, path: doc.path, title: doc.title } : { name: part, children: [] };
        node.children.push(child);
      }
      if (!isFile) node = child;
    });
  }
  return root;
}

function commentPayload({ path, sha, line, kind, text, anchor, tag = null, replyTo = null }) {
  return { path, sha, line, kind, text, anchor, tag, replyTo };
}

// ---- DOM/runtime wiring (browser only) ----
if (typeof document !== 'undefined') {
  const cfgEl = document.getElementById('docs-cfg');
  const cfg = cfgEl ? JSON.parse(cfgEl.textContent) : { mode: 'list', docs: [] };

  // HTML-escape helper — applied to every value interpolated into innerHTML or attributes.
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  async function renderList() {
    const tree = buildTree(cfg.docs);
    const host = document.getElementById('docs-tree');
    const render = (node, depth) => node.children.map((c) => c.path
      ? `<div style="padding-left:${depth * 12}px"><a href="/docs/view?path=${encodeURIComponent(c.path)}">${esc(c.title || c.name)}</a></div>`
      : `<div style="padding-left:${depth * 12}px"><b>${esc(c.name)}/</b></div>${render(c, depth + 1)}`).join('');
    if (host) host.innerHTML = render(tree, 0);
  }

  async function loadComments() {
    let comments;
    try {
      const res = await fetch(`/docs/comments?path=${encodeURIComponent(cfg.path)}&sha=${encodeURIComponent(cfg.sha)}`);
      comments = await res.json();
    } catch { return; }
    const side = document.getElementById('docs-side');
    if (side) side.innerHTML = comments.map((c) =>
      `<div class="docs__comment" data-id="${esc(c.id)}"><b>${esc(c.kind)}</b> — ${esc(c.author || '')}<br>${esc(c.text)}</div>`).join('');
    // Re-highlight each anchored comment with FBAnchor if available.
    // Real API: resolveAnchor(anchor, root) → Range, then wrapRange(range, root, makeMark).
    if (window.FBAnchor && window.FBAnchor.resolveAnchor && window.FBAnchor.wrapRange) {
      const docRoot = document.querySelector('.docs__doc');
      const doc = document;
      for (const c of comments) {
        if (c.anchor) {
          try {
            const range = window.FBAnchor.resolveAnchor(c.anchor, docRoot);
            if (range) window.FBAnchor.wrapRange(range, docRoot, () => doc.createElement('mark'));
          } catch { /* drifted */ }
        }
      }
    }
  }

  async function onSelect() {
    if (!cfg.commentable) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    // Real API: serializeSelection(range, root) — first arg is a DOM Range, not a Selection.
    let anchor = null;
    if (window.FBAnchor && window.FBAnchor.serializeSelection) {
      try {
        const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
        if (range) anchor = window.FBAnchor.serializeSelection(range, document.querySelector('.docs__doc'));
      } catch { /* ignore */ }
    }
    const line = nearestSourceLine(sel.anchorNode && sel.anchorNode.parentElement);
    const kind = window.prompt('Kind: question / change-request / delete / note', 'question') || 'note';
    const text = window.prompt('Your comment:');
    if (!text) return;
    const res = await fetch('/docs/comments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(commentPayload({ path: cfg.path, sha: cfg.sha, line, kind, text, anchor })),
    });
    if (res.ok) loadComments();
    else window.alert('Could not post to GitHub — your draft is kept. ' + res.status);
  }

  if (cfg.mode === 'list') renderList();
  else {
    loadComments();
    const docRoot = document.querySelector('.docs__doc');
    if (docRoot) docRoot.addEventListener('mouseup', onSelect);
  }
}

if (typeof module !== 'undefined') module.exports = { nearestSourceLine, buildTree, commentPayload };
