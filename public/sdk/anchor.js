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

  function offsetToPoint(nodes, offset) {
    for (const e of nodes) {
      if (offset >= e.start && offset <= e.end) return { node: e.node, offset: offset - e.start };
    }
    const last = nodes[nodes.length - 1];
    return last ? { node: last.node, offset: last.node.nodeValue.length } : null;
  }

  // Selection → anchor. Returns null for a collapsed/empty selection.
  function serializeSelection(range, root) {
    const { text, nodes } = textIndex(root);
    const map = new Map(nodes.map(e => [e.node, e.start]));
    function abs(container, off) {
      if (map.has(container)) return map.get(container) + off;
      const walker = (root.ownerDocument || document).createTreeWalker(container, 4, null);
      const first = walker.nextNode();
      return first && map.has(first) ? map.get(first) : 0;
    }
    let start = abs(range.startContainer, range.startOffset);
    let end = abs(range.endContainer, range.endOffset);
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

  // anchor → DOM Range (or null if unresolvable).
  function resolveAnchor(anchor, root) {
    const { text, nodes } = textIndex(root);
    if (!nodes.length) return null;
    const loc = locateQuote(text, anchor);
    if (!loc) return null;
    const startPt = offsetToPoint(nodes, loc.start);
    const endPt = offsetToPoint(nodes, loc.end);
    if (!startPt || !endPt) return null;
    const range = (root.ownerDocument || document).createRange();
    range.setStart(startPt.node, startPt.offset);
    range.setEnd(endPt.node, endPt.offset);
    return range;
  }

  return { locateQuote, serializeSelection, resolveAnchor, textIndex, CTX };
});
