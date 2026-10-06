// src/services/markdown.js
// Render Markdown → safe HTML fragment. Two layers of defense:
//   1. markdown-it with html:false — raw HTML in the source is escaped, not parsed.
//   2. sanitize-html on the output — strips anything unexpected (scripts, event
//      handlers) even if it slipped through; allowedSchemes enforces that no
//      javascript: href survives in link or image attributes.
// Pure function, no DB, no I/O — trivially testable.
const MarkdownIt = require('markdown-it');
const sanitizeHtml = require('sanitize-html');

const BASE_OPTS = { html: false, linkify: true, breaks: false, typographer: true };
const md = new MarkdownIt(BASE_OPTS);

// Separate instance so the default renderer stays untouched.
const mdLines = new MarkdownIt(BASE_OPTS);
mdLines.core.ruler.push('source_line', (state) => {
  for (const token of state.tokens) {
    if (token.nesting === 1 && token.map) {
      token.attrSet('data-source-line', String(token.map[0] + 1));
    }
  }
});

const SANITIZE_OPTIONS = {
  allowedTags: [
    'h1','h2','h3','h4','h5','h6','p','a','ul','ol','li','blockquote','hr','br',
    'strong','em','del','code','pre','span','table','thead','tbody','tr','th','td','img','input',
  ],
  allowedAttributes: {
    '*': ['data-source-line'],
    a: ['href','title'], img: ['src','alt','title'],
    input: ['type','checked','disabled'], span: ['class'], code: ['class'],
    pre: ['class'], th: ['align'], td: ['align'],
  },
  allowedSchemes: ['http','https','mailto'],
  transformTags: {
    input: (tagName, attribs) => ({
      tagName,
      attribs: { type: 'checkbox', disabled: 'disabled', ...(attribs.checked ? { checked: 'checked' } : {}) },
    }),
  },
};

function render(rawMd, opts = {}) {
  const engine = opts.sourceLines ? mdLines : md;
  const rendered = engine.render(String(rawMd == null ? '' : rawMd));
  return { html: sanitizeHtml(rendered, SANITIZE_OPTIONS) };
}

module.exports = { render };
