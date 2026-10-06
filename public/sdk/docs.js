// public/sdk/docs.js
// Docs-mode review client. Renders the folder tree, a GitHub-backed comment
// sidebar, and a ProtoLab-styled inline commenting flow (select text -> floating
// button -> composer card -> highlight + sidebar card). Comments live on GitHub
// as commit comments (via the /docs endpoints); this is a docs-specific UX that
// is visually similar to ProtoLab's prototype review, not feature-identical.
//
// Reuses FBAnchor (anchor.js) for durable text anchoring:
//   - FBAnchor.serializeSelection(range, root): first arg is a DOM Range.
//   - FBAnchor.resolveAnchor(anchor, root): -> DOM Range | null.
//   - FBAnchor.wrapRange(range, root, makeMark): wraps the range in <mark>s.
// The raw line sent to GitHub comes from the nearest [data-source-line] block.

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

  const KINDS = [
    { id: 'question', label: 'Question', color: 'hsl(217,91%,60%)' },
    { id: 'change-request', label: 'Change', color: 'hsl(38,92%,50%)' },
    { id: 'delete', label: 'Delete', color: 'hsl(0,84%,60%)' },
    { id: 'note', label: 'Note', color: 'hsl(252,83%,57%)' },
  ];
  const KIND = Object.fromEntries(KINDS.map((k) => [k.id, k]));
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const DOC_ROOT = () => document.getElementById('docs-page');

  function relTime(iso) {
    if (!iso) return '';
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (isNaN(d)) return '';
    if (d < 60) return 'just now';
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  }

  // ---- folder tree / nav ----
  let query = '';
  let sortMode = 'folders'; // folders | name-asc | name-desc | date-desc | date-asc
  const collapsed = new Set();
  const FOLDER = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z"/></svg>';
  const pad = (d) => 10 + d * 16;

  function matchesQuery(doc) {
    if (!query) return true;
    return (`${doc.title || ''} ${doc.path}`).toLowerCase().includes(query.toLowerCase());
  }

  function fileLink(doc, depth, showPath) {
    const active = doc.path === cfg.path ? ' is-active' : '';
    const hint = showPath ? `<span class="docs-tree__hint">${esc(doc.path)}</span>` : '';
    return `<a class="docs-tree__file${active}" style="padding-left:${pad(depth)}px" href="/docs/view?path=${encodeURIComponent(doc.path)}">${esc(doc.title || doc.path)}${hint}</a>`;
  }

  function treeHtml(node, depth, prefix) {
    return node.children.map((c) => {
      if (c.path) return fileLink(c, depth, false);
      const full = prefix ? `${prefix}/${c.name}` : c.name;
      const isCol = collapsed.has(full);
      const kids = isCol ? '' : treeHtml(c, depth + 1, full);
      return `<div class="docs-tree__group"><div class="docs-tree__dir" data-dir="${esc(full)}" style="padding-left:${pad(depth)}px"><span class="docs-tree__chev">${isCol ? '▸' : '▾'}</span>${FOLDER}${esc(c.name)}</div>${kids}</div>`;
    }).join('');
  }

  const SORTERS = {
    'name-asc': (a, b) => (a.title || a.path).localeCompare(b.title || b.path),
    'name-desc': (a, b) => (b.title || b.path).localeCompare(a.title || a.path),
    'date-desc': (a, b) => String(b.created || '').localeCompare(String(a.created || '')),
    'date-asc': (a, b) => String(a.created || '').localeCompare(String(b.created || '')),
  };

  function renderNav() {
    const host = document.getElementById('docs-tree');
    if (!host) return;
    const docs = (cfg.docs || []).filter(matchesQuery);
    if (!docs.length) {
      host.innerHTML = `<div class="docs-tree__empty">${query ? 'No docs match “' + esc(query) + '”.' : 'No documents.'}</div>`;
      return;
    }
    if (sortMode === 'folders') {
      host.innerHTML = treeHtml(buildTree(docs), 0, '');
    } else {
      host.innerHTML = docs.slice().sort(SORTERS[sortMode]).map((d) => fileLink(d, 0, true)).join('');
    }
  }

  function setupNav() {
    const search = document.getElementById('docs-search');
    if (search) search.addEventListener('input', () => { query = search.value.trim(); renderNav(); });
    const sortBar = document.getElementById('docs-sort');
    if (sortBar) sortBar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sort]');
      if (!b) return;
      sortMode = b.dataset.sort;
      sortBar.querySelectorAll('[data-sort]').forEach((x) => x.classList.toggle('is-active', x === b));
      renderNav();
    });
    const host = document.getElementById('docs-tree');
    if (host) host.addEventListener('click', (e) => {
      const dir = e.target.closest('.docs-tree__dir');
      if (!dir) return;
      const key = dir.getAttribute('data-dir');
      if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
      renderNav();
    });
    // drag-to-resize the left pane
    const docsEl = document.querySelector('.docs');
    const resizer = document.getElementById('docs-resizer');
    try { const w = parseInt(localStorage.getItem('docsTreeW') || '', 10); if (w) docsEl.style.setProperty('--tree-w', w + 'px'); } catch { /* ignore */ }
    if (resizer && docsEl) resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = document.querySelector('.docs__tree').getBoundingClientRect().width;
      document.body.style.userSelect = 'none';
      const move = (ev) => { const w = Math.min(620, Math.max(200, startW + ev.clientX - startX)); docsEl.style.setProperty('--tree-w', w + 'px'); };
      const up = () => {
        document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
        document.body.style.userSelect = '';
        try { localStorage.setItem('docsTreeW', String(parseInt(getComputedStyle(docsEl).getPropertyValue('--tree-w'), 10))); } catch { /* ignore */ }
      };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
  }

  // ---- header: path + version switcher ----
  function renderHeader() {
    const pathEl = document.getElementById('docs-top-path');
    if (pathEl && cfg.path) pathEl.textContent = cfg.path;
    const verEl = document.getElementById('docs-top-ver');
    if (verEl && Array.isArray(cfg.versions) && cfg.versions.length) {
      const opts = cfg.versions.map((v) =>
        `<option value="${esc(v.sha)}"${v.sha === cfg.sha ? ' selected' : ''}>${esc((v.date || '') + '  ' + (v.subject || v.sha.slice(0, 7)))}</option>`).join('');
      verEl.innerHTML = `<select id="docs-ver-select" title="View an earlier committed version">${opts}</select>`;
      const sel = document.getElementById('docs-ver-select');
      sel.addEventListener('change', () => {
        location.href = `/docs/view?path=${encodeURIComponent(cfg.path)}&sha=${encodeURIComponent(sel.value)}`;
      });
    }
  }

  // ---- highlights ----
  function unwrapHighlights() {
    const root = DOC_ROOT();
    if (!root) return;
    root.querySelectorAll('mark.docs-hl').forEach((m) => {
      const parent = m.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(m.textContent), m);
      parent.normalize();
    });
  }

  function highlight(c) {
    if (!c.anchor || !(window.FBAnchor && window.FBAnchor.resolveAnchor && window.FBAnchor.wrapRange)) return;
    const root = DOC_ROOT();
    try {
      const range = window.FBAnchor.resolveAnchor(c.anchor, root);
      if (!range) return;
      const color = (KIND[c.kind] || KIND.note).color;
      window.FBAnchor.wrapRange(range, root, () => {
        const m = document.createElement('mark');
        m.className = 'docs-hl';
        m.dataset.cid = c.id;
        m.style.borderBottomColor = color;
        return m;
      });
    } catch { /* anchor drifted against this version — skip */ }
  }

  function flash(el) {
    if (!el) return;
    el.classList.remove('docs-flash');
    void el.offsetWidth;
    el.classList.add('docs-flash');
  }

  function scrollToCard(cid) {
    const card = document.querySelector(`.docs-card[data-cid="${CSS.escape(cid)}"]`);
    if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); flash(card); }
  }
  function scrollToMark(cid) {
    const mark = document.querySelector(`mark.docs-hl[data-cid="${CSS.escape(cid)}"]`);
    if (mark) { mark.scrollIntoView({ behavior: 'smooth', block: 'center' }); flash(mark); }
  }

  // ---- comment sidebar ----
  let loadingComments = false;
  async function loadComments() {
    if (loadingComments) return; // in-flight lock so focus/poll refreshes don't stack
    loadingComments = true;
    try {
    const list = document.getElementById('docs-side');
    const count = document.getElementById('docs-count');
    let comments;
    try {
      const res = await fetch(`/docs/comments?path=${encodeURIComponent(cfg.path)}&sha=${encodeURIComponent(cfg.sha)}`);
      if (!res.ok) throw new Error(res.status);
      comments = await res.json();
    } catch {
      if (list) list.innerHTML = `<div class="docs-side__empty">Couldn't load comments from GitHub for this version.</div>`;
      return;
    }
    if (count) count.textContent = comments.length ? String(comments.length) : '';
    if (list) {
      list.innerHTML = comments.length ? comments.map((c) => {
        const k = KIND[c.kind] || KIND.note;
        const gh = c.htmlUrl ? `<a href="${esc(c.htmlUrl)}" target="_blank" rel="noopener">on GitHub ↗</a>` : '';
        return `<div class="docs-card" data-cid="${esc(c.id)}">
          <div class="docs-card__top">
            <span class="docs-card__kind" style="background:${k.color}">${esc(k.label)}</span>
            <span class="docs-card__who">${esc(c.author || 'unknown')} · ${esc(relTime(c.createdAt))}</span>
          </div>
          <div class="docs-card__text">${esc(c.text)}</div>
          <div class="docs-card__foot">${gh}<button class="docs-card__del" data-del="${esc(c.id)}">Delete</button></div>
        </div>`;
      }).join('') : `<div class="docs-side__empty">${cfg.commentable ? 'No comments yet.<br>Select text in the document to add one.' : 'This file has no committed version yet — commit it to add comments.'}</div>`;
    }
    // redraw highlights for this version
    unwrapHighlights();
    comments.forEach(highlight);
    } finally { loadingComments = false; }
  }

  // ---- inline composer flow ----
  let fab = null; let composer = null; let pending = null;

  function hideFab() { if (fab) fab.remove(); fab = null; }
  function closeComposer() { if (composer) composer.remove(); composer = null; pending = null; }

  function showFab(rect) {
    hideFab();
    fab = document.createElement('button');
    fab.className = 'docs-fab';
    fab.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2z"/></svg> Comment`;
    fab.style.left = `${rect.left + rect.width / 2}px`;
    fab.style.top = `${rect.top - 6}px`;
    fab.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    fab.addEventListener('click', (e) => { e.stopPropagation(); openComposer(rect); });
    document.body.appendChild(fab);
  }

  function openComposer(rect) {
    hideFab();
    closeComposerKeepPending();
    let kind = 'question';
    composer = document.createElement('div');
    composer.className = 'docs-composer';
    composer.innerHTML = `
      <div class="docs-composer__quote">${esc((pending && pending.quote) || '')}</div>
      <textarea placeholder="Leave a comment…"></textarea>
      <div class="docs-pills">${KINDS.map((k) => `<button class="docs-pill${k.id === kind ? ' is-active' : ''}" data-kind="${k.id}" style="${k.id === kind ? `background:${k.color};border-color:${k.color}` : ''}">${k.label}</button>`).join('')}</div>
      <div class="docs-composer__foot">
        <button class="docs-btn docs-btn--ghost" data-cancel>Cancel</button>
        <button class="docs-btn docs-btn--primary" data-post disabled>Post</button>
      </div>`;
    const top = Math.min(rect.bottom + 8, window.innerHeight - 240);
    const left = Math.min(Math.max(rect.left, 12), window.innerWidth - 332);
    composer.style.top = `${Math.max(12, top)}px`;
    composer.style.left = `${left}px`;
    composer.addEventListener('mousedown', (e) => e.stopPropagation());
    document.body.appendChild(composer);

    const textarea = composer.querySelector('textarea');
    const postBtn = composer.querySelector('[data-post]');
    textarea.addEventListener('input', () => { postBtn.disabled = !textarea.value.trim(); });
    textarea.focus();
    composer.querySelectorAll('.docs-pill').forEach((pill) => pill.addEventListener('click', () => {
      kind = pill.dataset.kind;
      composer.querySelectorAll('.docs-pill').forEach((p) => {
        const on = p.dataset.kind === kind;
        p.classList.toggle('is-active', on);
        p.style.cssText = on ? `background:${KIND[kind].color};border-color:${KIND[kind].color}` : '';
      });
    }));
    composer.querySelector('[data-cancel]').addEventListener('click', closeComposer);
    postBtn.addEventListener('click', () => postComment(kind, textarea.value.trim(), postBtn));
  }
  // close any open composer but preserve `pending` (used when FAB->composer)
  function closeComposerKeepPending() { if (composer) composer.remove(); composer = null; }

  async function postComment(kind, text, btn) {
    if (!text || !pending) return;
    btn.disabled = true; btn.textContent = 'Posting…';
    try {
      const res = await fetch('/docs/comments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(commentPayload({ path: cfg.path, sha: cfg.sha, line: pending.line, kind, text, anchor: pending.anchor })),
      });
      if (!res.ok) throw new Error(res.status);
      closeComposer();
      window.getSelection().removeAllRanges();
      await loadComments();
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Post';
      alert('Could not post to GitHub (your text is kept): ' + (e && e.message));
    }
  }

  function onMouseUp() {
    if (!cfg.commentable) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const root = DOC_ROOT();
      if (!sel || sel.isCollapsed || !sel.rangeCount || !root || !root.contains(sel.anchorNode)) { if (!composer) hideFab(); return; }
      const range = sel.getRangeAt(0);
      let anchor = null;
      try { if (window.FBAnchor && window.FBAnchor.serializeSelection) anchor = window.FBAnchor.serializeSelection(range, root); } catch { /* ignore */ }
      pending = {
        anchor,
        line: nearestSourceLine(sel.anchorNode && sel.anchorNode.parentElement),
        quote: sel.toString().slice(0, 180),
      };
      showFab(range.getBoundingClientRect());
    }, 0);
  }

  // ---- wire ----
  setupNav();
  renderNav();
  if (cfg.mode === 'view') {
    renderHeader();
    loadComments();
    const root = DOC_ROOT();
    if (root) root.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mousedown', (e) => {
      if (fab && !fab.contains(e.target)) hideFab();
      if (composer && !composer.contains(e.target)) closeComposer();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideFab(); closeComposer(); } });
    document.getElementById('docs-side').addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) { e.stopPropagation(); deleteComment(del.getAttribute('data-del')); return; }
      const card = e.target.closest('.docs-card');
      if (card) scrollToMark(card.getAttribute('data-cid'));
    });
    (DOC_ROOT() || document).addEventListener('click', (e) => {
      const m = e.target.closest && e.target.closest('mark.docs-hl');
      if (m) scrollToCard(m.dataset.cid);
    });
    try { new EventSource('/docs/__events').onmessage = () => location.reload(); } catch { /* no SSE */ }
    // Pick up teammates' comments without a manual reload: refresh on tab focus
    // and on a gentle interval, but never while the user is mid-comment.
    const autoRefresh = () => {
      if (composer) return;                       // don't clobber an open composer
      const sel = window.getSelection();
      const root = DOC_ROOT();
      if (sel && !sel.isCollapsed && root && root.contains(sel.anchorNode)) return; // active selection
      loadComments();
    };
    window.addEventListener('focus', autoRefresh);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) autoRefresh(); });
    setInterval(() => { if (!document.hidden) autoRefresh(); }, 25000);
  }

  async function deleteComment(id) {
    try {
      const res = await fetch('/docs/comments/' + encodeURIComponent(id), { method: 'DELETE' });
      if (res.ok || res.status === 204) await loadComments();
    } catch { /* ignore */ }
  }
}

if (typeof module !== 'undefined') module.exports = { nearestSourceLine, buildTree, commentPayload };
