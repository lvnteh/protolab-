// public/sdk/anchor.js
// Durable text anchoring shared by feedback.js (interactive) and preview.js
// (read-only). An anchor = { quote, prefix, suffix, start, end } where start/end
// are character offsets into the document's visible text. Resolution self-heals:
// exact offsets first, then unique-quote search, then prefix/suffix-scored search.
//
// Dual export: browser global window.FBAnchor + CommonJS for Jest. The pure core
// (locateQuote) has no DOM dependency and is unit-tested directly.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node/Jest
  if (root) root.FBAnchor = api;                                             // browser
})(typeof window !== 'undefined' ? window : null, function () {
  const CTX = 32; // chars of prefix/suffix context to capture

  // --- pure core: find the anchor's [start,end) in fullText ---
  function locateQuote(fullText, anchor) {
    const quote = anchor && anchor.quote ? String(anchor.quote) : '';
    if (!quote) return null;

    // 1. Exact offsets, confirmed by quote.
    if (Number.isInteger(anchor.start) && Number.isInteger(anchor.end) &&
        fullText.slice(anchor.start, anchor.end) === quote) {
      return { start: anchor.start, end: anchor.end };
    }

    // 2. Collect every occurrence of the quote.
    const hits = [];
    let i = fullText.indexOf(quote);
    while (i !== -1) { hits.push(i); i = fullText.indexOf(quote, i + 1); }
    if (hits.length === 0) return null;
    if (hits.length === 1) return { start: hits[0], end: hits[0] + quote.length };

    // 3. Multiple hits — score each by how well surrounding text matches
    //    the stored prefix/suffix, then by proximity to the original start.
    const prefix = anchor.prefix ? String(anchor.prefix) : '';
    const suffix = anchor.suffix ? String(anchor.suffix) : '';
    let best = null, bestScore = -Infinity;
    for (const h of hits) {
      const before = fullText.slice(Math.max(0, h - prefix.length), h);
      const after = fullText.slice(h + quote.length, h + quote.length + suffix.length);
      let score = commonSuffixLen(before, prefix) + commonPrefixLen(after, suffix);
      if (Number.isInteger(anchor.start)) score -= Math.abs(h - anchor.start) / 1e6; // tiny tiebreak
      if (score > bestScore) { bestScore = score; best = h; }
    }
    return best == null ? null : { start: best, end: best + quote.length };
  }

  function commonPrefixLen(a, b) {
    let n = 0; const m = Math.min(a.length, b.length);
    while (n < m && a[n] === b[n]) n++;
    return n;
  }
  function commonSuffixLen(a, b) {
    let n = 0; const m = Math.min(a.length, b.length);
    while (n < m && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
  }

  // --- DOM glue (browser only; guarded so Node require() is safe) ---

  // Concatenate visible text nodes under root, tracking each node's start offset.
  function textIndex(root) {
    const doc = root.ownerDocument || document;
    const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */, null);
    let text = '';
    const nodes = []; // { node, start, end }
    let n;
    while ((n = walker.nextNode())) {
      const start = text.length;
      text += n.nodeValue;
      nodes.push({ node: n, start, end: text.length });
    }
    return { text, nodes };
  }

  function offsetToPoint(nodes, offset, isEnd) {
    // A character offset that lands exactly on a text-node boundary is ambiguous:
    // it is simultaneously the END of node A and the START of node B. Which node
    // we pick matters — resolving a quote that lives wholly inside one text node
    // to (endOfPrevNode → startOfNextNode) manufactures a cross-node range that
    // Range.surroundContents() then refuses to wrap. So we disambiguate by role:
    // a START point continues INTO a node (prefer the node whose [start,end) the
    // offset opens), an END point comes FROM a node (prefer the node whose
    // (start,end] the offset closes). Non-boundary offsets match either way.
    if (isEnd) {
      for (const e of nodes) {
        if (offset > e.start && offset <= e.end) return { node: e.node, offset: offset - e.start };
      }
      // offset === 0 (or before all text): collapse to the very start.
      const first = nodes[0];
      return first ? { node: first.node, offset: 0 } : null;
    }
    for (const e of nodes) {
      if (offset >= e.start && offset < e.end) return { node: e.node, offset: offset - e.start };
    }
    const last = nodes[nodes.length - 1];
    return last ? { node: last.node, offset: last.node.nodeValue.length } : null;
  }

  // Selection → anchor. Returns null for a collapsed/empty selection.
  function serializeSelection(range, root) {
    const { text, nodes } = textIndex(root);
    const map = new Map(nodes.map(e => [e.node, e.start]));

    // Map a (container, offset) boundary to an absolute offset in `text`.
    // Text-node containers are a direct lookup. Element containers use a DOM
    // offset that is a CHILD INDEX, not a character offset — so we resolve it to
    // the text position at that child boundary: the start of the child at
    // [offset] if it (or a descendant) is indexed, else the end of the text
    // covered by the children BEFORE it. Falling back to 0 (the old behaviour)
    // silently anchored cross-element selections to the top of the document.
    function firstIndexedIn(node) {
      if (map.has(node)) return map.get(node);
      const w = (root.ownerDocument || document).createTreeWalker(node, 4, null);
      let t;
      while ((t = w.nextNode())) { if (map.has(t)) return map.get(t); }
      return null;
    }
    function lastIndexedEndIn(node) {
      if (map.has(node)) return map.get(node) + node.nodeValue.length;
      const w = (root.ownerDocument || document).createTreeWalker(node, 4, null);
      let t, end = null;
      while ((t = w.nextNode())) { if (map.has(t)) end = map.get(t) + t.nodeValue.length; }
      return end;
    }
    function abs(container, off, isEnd) {
      if (map.has(container)) return map.get(container) + off;
      const kids = container.childNodes || [];
      // Search forward from the boundary child for the next indexed text position.
      for (let i = off; i < kids.length; i++) {
        const p = firstIndexedIn(kids[i]);
        if (p !== null) return p;
      }
      // Nothing after the boundary — use the end of the last indexed text before it.
      for (let i = Math.min(off, kids.length) - 1; i >= 0; i--) {
        const p = lastIndexedEndIn(kids[i]);
        if (p !== null) return p;
      }
      // Container has no indexed text at all: start→0, end→document end.
      return isEnd ? text.length : 0;
    }
    let start = abs(range.startContainer, range.startOffset, false);
    let end = abs(range.endContainer, range.endOffset, true);
    if (start > end) { const t = start; start = end; end = t; }
    const quote = text.slice(start, end);
    if (!quote.trim()) return null;
    return {
      quote,
      prefix: text.slice(Math.max(0, start - CTX), start),
      suffix: text.slice(end, end + CTX),
      start, end,
    };
  }

  // Where a range-comment pin should sit relative to its highlight.
  // `target` is anything exposing getClientRects()/getBoundingClientRect() — the
  // <mark> element (preferred) or the Range itself. We anchor to the END of the
  // highlighted run: the LAST client rect (last wrapped line), not the bounding
  // box — a bounding box's right edge is the widest line, which for a multi-line
  // selection is nowhere near where the text actually ends. The pin is placed
  // just past that line's right edge (by `gap` px) and vertically centered on it.
  // Returns viewport coordinates {left, top}, or null when there's nothing to
  // pin to (no rects / zero-area) so the caller can skip rendering.
  const PIN_GAP = 16;
  function markerPos(target, gap) {
    if (!target || typeof target.getClientRects !== 'function') return null;
    const g = typeof gap === 'number' ? gap : PIN_GAP;
    const rects = target.getClientRects();
    let r = rects && rects.length ? rects[rects.length - 1] : null;
    if (!r || (r.width === 0 && r.height === 0)) {
      r = typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : null;
    }
    if (!r || (r.width === 0 && r.height === 0)) return null;
    return { left: r.right + g, top: r.top + r.height / 2 };
  }

  // anchor → DOM Range (or null if unresolvable).
  function resolveAnchor(anchor, root) {
    const { text, nodes } = textIndex(root);
    if (!nodes.length) return null;
    const loc = locateQuote(text, anchor);
    if (!loc) return null;
    const startPt = offsetToPoint(nodes, loc.start, false);
    const endPt = offsetToPoint(nodes, loc.end, true);
    if (!startPt || !endPt) return null;
    const range = (root.ownerDocument || document).createRange();
    range.setStart(startPt.node, startPt.offset);
    range.setEnd(endPt.node, endPt.offset);
    return range;
  }

  // Plan a highlight as one slice per intersecting text node. Range.surroundContents
  // throws on ANY range that partially selects a non-Text node — which is every
  // multi-text-node range (rendered markdown splits a paragraph across bold/code/
  // link nodes, so even a single selected word can span two). Instead we compute,
  // for each text node the range touches, the [start,end) character slice of that
  // node covered by the range. Each slice is later wrapped in its OWN <mark> via a
  // single-text-node sub-range, which never throws. Pure (uses textIndex only) so
  // it is unit-testable without a live DOM.
  function rangeSegments(range, root) {
    const { nodes } = textIndex(root);
    const startAbs = absOffsetOf(nodes, range.startContainer, range.startOffset);
    const endAbs = absOffsetOf(nodes, range.endContainer, range.endOffset);
    if (startAbs == null || endAbs == null) return [];
    const lo = Math.min(startAbs, endAbs), hi = Math.max(startAbs, endAbs);
    const segs = [];
    for (const e of nodes) {
      const s = Math.max(lo, e.start), en = Math.min(hi, e.end);
      if (s < en) segs.push({ node: e.node, start: s - e.start, end: en - e.start });
    }
    return segs;
  }

  // Absolute offset in the concatenated text for a (container, offset) point.
  // Text-node containers are a direct lookup; element containers use a child-index
  // offset (same resolution rule as serializeSelection's abs()).
  function absOffsetOf(nodes, container, offset) {
    const map = new Map(nodes.map(e => [e.node, e.start]));
    if (map.has(container)) return map.get(container) + offset;
    const kids = container.childNodes || [];
    const firstIn = (node) => {
      if (map.has(node)) return map.get(node);
      const w = (container.ownerDocument || document).createTreeWalker(node, 4, null);
      let t; while ((t = w.nextNode())) { if (map.has(t)) return map.get(t); }
      return null;
    };
    const lastEndIn = (node) => {
      if (map.has(node)) return map.get(node) + node.nodeValue.length;
      const w = (container.ownerDocument || document).createTreeWalker(node, 4, null);
      let t, end = null; while ((t = w.nextNode())) { if (map.has(t)) end = map.get(t) + t.nodeValue.length; }
      return end;
    };
    for (let i = offset; i < kids.length; i++) { const p = firstIn(kids[i]); if (p !== null) return p; }
    for (let i = Math.min(offset, kids.length) - 1; i >= 0; i--) { const p = lastEndIn(kids[i]); if (p !== null) return p; }
    return null;
  }

  // Wrap a resolved range in per-text-node <mark>s. `makeMark()` returns a fresh
  // mark element (caller styles/attributes it); we wrap each segment's slice with
  // its own single-text-node sub-range (surroundContents-safe) and return the mark
  // elements in document order. Browser-only (mutates the DOM); the pure planning
  // lives in rangeSegments, which is what the unit tests exercise.
  function wrapRange(range, root, makeMark) {
    const doc = root.ownerDocument || document;
    const { nodes } = textIndex(root);
    const segs = rangeSegments(range, root);
    // Re-fetch nodes by identity is unnecessary; segs already reference live nodes.
    // Wrap from LAST to FIRST so wrapping (which splits text nodes) never shifts
    // the offsets of segments we haven't processed yet.
    const marks = [];
    for (let i = segs.length - 1; i >= 0; i--) {
      const seg = segs[i];
      const sub = doc.createRange();
      sub.setStart(seg.node, seg.start);
      sub.setEnd(seg.node, seg.end);
      const mark = makeMark();
      try { sub.surroundContents(mark); marks.unshift(mark); } catch (_) { /* skip un-wrappable slice */ }
    }
    return marks;
  }

  return { locateQuote, serializeSelection, resolveAnchor, textIndex, rangeSegments, wrapRange, markerPos, PIN_GAP, CTX };
});
