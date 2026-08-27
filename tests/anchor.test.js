// tests/anchor.test.js
const A = require('../public/sdk/anchor');

test('exact offset hit is confirmed by quote', () => {
  const text = 'The quick brown fox jumps.';
  const anchor = { quote: 'quick brown', prefix: 'The ', suffix: ' fox', start: 4, end: 15 };
  expect(A.locateQuote(text, anchor)).toEqual({ start: 4, end: 15 });
});

test('recovers when offsets drift but quote is unique', () => {
  const text = 'INSERTED. The quick brown fox jumps.';
  const anchor = { quote: 'quick brown', prefix: 'The ', suffix: ' fox', start: 4, end: 15 };
  expect(A.locateQuote(text, anchor)).toEqual({ start: 14, end: 25 });
});

test('disambiguates duplicate quotes via prefix/suffix', () => {
  const text = 'cat here and cat there';
  const anchor = { quote: 'cat', prefix: 'and ', suffix: ' there', start: 13, end: 16 };
  expect(A.locateQuote(text, anchor)).toEqual({ start: 13, end: 16 });
});

test('returns null when quote is absent', () => {
  const text = 'nothing to see';
  const anchor = { quote: 'absent phrase', prefix: '', suffix: '', start: 0, end: 5 };
  expect(A.locateQuote(text, anchor)).toBeNull();
});

test('empty quote → null', () => {
  expect(A.locateQuote('abc', { quote: '', start: 0, end: 0 })).toBeNull();
});

// ── DOM round-trip coverage ──────────────────────────────────────────────
// anchor.js's serializeSelection/resolveAnchor need a DOM. The project's jest
// env is 'node' (no jsdom, by design), so we drive them through a minimal stub
// implementing exactly the surface anchor.js touches: text nodes with nodeValue,
// element nodes with childNodes, ownerDocument.createTreeWalker(SHOW_TEXT) and
// createRange(). This exercises the real serialize→resolve logic — including the
// element-container boundary fallback — without adding a dependency.

const TEXT_NODE = 3, ELEMENT_NODE = 1;

function txt(value) {
  return { nodeType: TEXT_NODE, nodeValue: value, childNodes: [] };
}
function el(...children) {
  const node = { nodeType: ELEMENT_NODE, childNodes: children };
  return node;
}

function makeDoc(rootEl) {
  // Depth-first list of text nodes under a subtree (document order).
  function textNodesUnder(node) {
    if (node.nodeType === TEXT_NODE) return [node];
    let out = [];
    for (const c of node.childNodes) out = out.concat(textNodesUnder(c));
    return out;
  }
  const doc = {
    createTreeWalker(root /*, whatToShow, filter */) {
      const list = textNodesUnder(root);
      let i = -1;
      return { nextNode() { i += 1; return i < list.length ? list[i] : null; } };
    },
    createRange() {
      return {
        startContainer: null, startOffset: 0, endContainer: null, endOffset: 0,
        setStart(n, o) { this.startContainer = n; this.startOffset = o; },
        setEnd(n, o) { this.endContainer = n; this.endOffset = o; },
      };
    },
  };
  // Wire ownerDocument onto every node so anchor.js's (root.ownerDocument||document) works.
  (function wire(n) { n.ownerDocument = doc; n.childNodes.forEach(wire); })(rootEl);
  return doc;
}

function rangeOverText(doc, node, start, end) {
  const r = doc.createRange();
  r.setStart(node, start);
  r.setEnd(node, end);
  return r;
}

// Absolute character offset of a (node, offset) point within root's visible text,
// using anchor.js's own textIndex so assertions are robust to which boundary node
// offsetToPoint happens to pick (a position at the end of node A equals the start
// of node B — both are valid representations of the same point).
function absOf(root, node, offset) {
  const { nodes } = A.textIndex(root);
  const entry = nodes.find(e => e.node === node);
  return (entry ? entry.start : 0) + offset;
}
function resolvedText(root, range) {
  const { text } = A.textIndex(root);
  const s = absOf(root, range.startContainer, range.startOffset);
  const e = absOf(root, range.endContainer, range.endOffset);
  return text.slice(s, e);
}

test('serializeSelection → resolveAnchor round-trips within a single text node', () => {
  const t = txt('The quick brown fox jumps over the lazy dog.');
  const root = el(el(t));
  const doc = makeDoc(root);
  const range = rangeOverText(doc, t, 4, 15); // "quick brown"

  const anchor = A.serializeSelection(range, root);
  expect(anchor).toBeTruthy();
  expect(anchor.quote).toBe('quick brown');

  const resolved = A.resolveAnchor(anchor, root);
  expect(resolved).toBeTruthy();
  // Assert on reconstructed text (robust to which boundary node is chosen).
  expect(resolvedText(root, resolved)).toBe('quick brown');
});

test('serializeSelection captures prefix/suffix context across sibling nodes', () => {
  // Two paragraphs; select the whole middle word's text node.
  const a = txt('Alpha beta ');
  const b = txt('gamma');
  const c = txt(' delta epsilon');
  const root = el(el(a), el(b), el(c));
  const doc = makeDoc(root);
  const range = rangeOverText(doc, b, 0, 5); // "gamma"

  const anchor = A.serializeSelection(range, root);
  expect(anchor.quote).toBe('gamma');
  expect(anchor.prefix.endsWith('Alpha beta ')).toBe(true);
  expect(anchor.suffix.startsWith(' delta')).toBe(true);

  // Round-trips to the correct text.
  const resolved = A.resolveAnchor(anchor, root);
  expect(resolvedText(root, resolved)).toBe('gamma');
});

test('element-container boundary maps to a child text position, not offset 0', () => {
  // A selection whose endContainer is an ELEMENT with a child-index offset.
  // Old behaviour defaulted such boundaries to 0; the fallback must instead
  // resolve to the text position at that child boundary.
  const first = txt('hello ');
  const second = txt('world');
  const container = el(first, second);      // <p>hello world</p>
  const root = el(container);
  const doc = makeDoc(root);

  // Range: start inside `first` at 0, end at the element boundary after child 0
  // (i.e. endContainer = container, endOffset = 1) → should cover "hello ".
  const r = doc.createRange();
  r.setStart(first, 0);
  r.setEnd(container, 1); // element container, child-index offset

  const anchor = A.serializeSelection(r, root);
  expect(anchor).toBeTruthy();
  expect(anchor.quote).toBe('hello '); // NOT '' and NOT the whole doc
  expect(anchor.start).toBe(0);
  expect(anchor.end).toBe(6);
});

test('resolveAnchor self-heals to the correct duplicate occurrence after DOM text shifts', () => {
  const t = txt('link here and link there');
  const root = el(el(t));
  makeDoc(root);
  const root2Text = txt('PREPENDED. link here and link there');
  const root2 = el(el(root2Text));
  makeDoc(root2);

  // Anchor the SECOND "link" in the original (offsets 14-18).
  const doc = root.ownerDocument;
  const r = doc.createRange(); r.setStart(t, 14); r.setEnd(t, 18);
  const anchor = A.serializeSelection(r, root);
  expect(anchor.quote).toBe('link');

  // Resolve against a shifted document (text prepended) — should still land on
  // the SECOND "link" via prefix/suffix scoring, not the first.
  const resolved = A.resolveAnchor(anchor, root2);
  expect(resolved).toBeTruthy();
  const startAbs = resolved.startOffset; // single text node → offset is absolute
  expect(root2Text.nodeValue.slice(startAbs, startAbs + 4)).toBe('link');
  // second occurrence sits after "and " in the shifted text
  expect(root2Text.nodeValue.slice(startAbs - 4, startAbs)).toBe('and ');
});

test('resolveAnchor returns null when the quote no longer exists', () => {
  const t = txt('completely different content now');
  const root = el(el(t));
  makeDoc(root);
  const anchor = { quote: 'text that was deleted', prefix: '', suffix: '', start: 5, end: 26 };
  expect(A.resolveAnchor(anchor, root)).toBeNull();
});

// ── markerPos: where a range-comment pin sits relative to its highlight ──────
// The interactive SDK (feedback.js) used to hardcode the pin to left:8px — the
// far-left viewport edge — which on a centered document lands nowhere near the
// text. markerPos computes the pin's viewport point from the highlight element,
// anchored to the END of the highlighted run (its last line fragment), so the
// pin butts up against the text like a margin note. Pure + DOM-light so it's
// unit-testable here; feedback.js calls it with the real <mark> element.

// A fake target exposing getClientRects()/getBoundingClientRect() the way a DOM
// element (or Range) does — enough surface for markerPos.
function rectTarget(rects) {
  const list = rects.slice();
  // bounding rect = union of fragments (min-left/top, max-right/bottom).
  const bounding = list.length ? {
    left: Math.min(...list.map(r => r.left)),
    top: Math.min(...list.map(r => r.top)),
    right: Math.max(...list.map(r => r.right)),
    bottom: Math.max(...list.map(r => r.bottom)),
    get width() { return this.right - this.left; },
    get height() { return this.bottom - this.top; },
  } : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  return {
    getClientRects() { return list; },
    getBoundingClientRect() { return bounding; },
  };
}
// helper to build a rect with derived width/height
function R(left, top, right, bottom) {
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

test('markerPos: single-line highlight → pin at end of the run, vertically centered', () => {
  // one line fragment from x=100..260, y=40..60 → pin just right of x=260,
  // centered at y=50, nudged out by the default gap.
  const target = rectTarget([R(100, 40, 260, 60)]);
  const pos = A.markerPos(target);
  expect(pos).toEqual({ left: 260 + A.PIN_GAP, top: 50 });
});

test('markerPos: multi-line highlight uses the LAST line fragment, not the bounding box', () => {
  // A wrapped selection: line 1 runs long (x→700), line 2 is short (x→180).
  // The pin must follow the END of the run — the last fragment — so left is
  // driven by the short second line (180), NOT the wide bounding box (700).
  const target = rectTarget([
    R(300, 40, 700, 60), // first line, wraps far right
    R(100, 60, 180, 80), // last line, ends early
  ]);
  const pos = A.markerPos(target);
  expect(pos).toEqual({ left: 180 + A.PIN_GAP, top: 70 }); // centered on last line
});

test('markerPos: falls back to bounding rect when getClientRects is empty', () => {
  const target = {
    getClientRects() { return []; },
    getBoundingClientRect() { return R(20, 200, 120, 224); },
  };
  const pos = A.markerPos(target);
  expect(pos).toEqual({ left: 120 + A.PIN_GAP, top: 212 });
});

test('markerPos: custom gap overrides the default', () => {
  const target = rectTarget([R(0, 0, 50, 20)]);
  expect(A.markerPos(target, 4)).toEqual({ left: 54, top: 10 });
});

test('markerPos: null / rectless target → null (caller skips the pin)', () => {
  expect(A.markerPos(null)).toBeNull();
  expect(A.markerPos({})).toBeNull();
  const zero = { getClientRects() { return []; }, getBoundingClientRect() { return R(0, 0, 0, 0); } };
  expect(A.markerPos(zero)).toBeNull(); // collapsed/invisible → no pin
});
