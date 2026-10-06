// Encodes/decodes a ProtoLab annotation into a GitHub commit-comment body.
// The body is the reviewer's text plus a trailing machine block carrying the
// kind, file path, raw line, and the durable text anchor so ProtoLab can
// re-highlight the exact span. Parsing is tolerant: any body that is not a
// well-formed ProtoLab block (including comments authored on GitHub directly)
// decodes to a plain note and never throws.
const MARKER_RE = /\n\n<!-- protoshare:v1 ([\s\S]*?) -->\s*$/;

function encodeBody({ text, kind, path = null, line = null, anchor = null, tag = null, replyTo = null }) {
  const meta = { kind, path, line, anchor, tag, replyTo };
  return `${String(text == null ? '' : text).trim()}\n\n<!-- protoshare:v1 ${JSON.stringify(meta)} -->`;
}

function plain(body) {
  return { text: String(body == null ? '' : body).trim(), kind: 'note', path: null, line: null, anchor: null, tag: null, replyTo: null, hasMeta: false };
}

function parseBody(body) {
  const src = String(body == null ? '' : body);
  const m = src.match(MARKER_RE);
  if (!m) return plain(src);
  let meta;
  try { meta = JSON.parse(m[1]); } catch { return plain(src); }
  if (!meta || typeof meta !== 'object') return plain(src);
  return {
    text: src.slice(0, m.index).trim(),
    kind: meta.kind || 'note',
    path: meta.path ?? null,
    line: meta.line ?? null,
    anchor: meta.anchor ?? null,
    tag: meta.tag ?? null,
    replyTo: meta.replyTo ?? null,
    hasMeta: true,
  };
}

module.exports = { encodeBody, parseBody };
