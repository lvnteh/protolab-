// src/services/markdown.js
// Render Markdown → safe HTML fragment. Two layers of defense:
//   1. markdown-it with html:false — raw HTML in the source is escaped, not parsed.
//   2. sanitize-html on the output — strips anything unexpected (scripts, event
//      handlers, javascript: URLs) even if it slipped through.
// Pure function, no DB, no I/O — trivially testable.
const MarkdownIt = require('markdown-it');
const sanitizeHtml = require('sanitize-html');

const md = new MarkdownIt({
  html: false,      // do not parse raw HTML tags in the markdown
  linkify: true,    // autolink bare URLs
  breaks: false,
  typographer: true,
});

const SANITIZE_OPTIONS = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'a', 'ul', 'ol', 'li', 'blockquote', 'hr', 'br',
    'strong', 'em', 'del', 'code', 'pre', 'span',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'img', 'input', // input: task-list checkboxes
  ],
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'title'],
    input: ['type', 'checked', 'disabled'],
    span: ['class'],
    code: ['class'],
    pre: ['class'],
    th: ['align'],
    td: ['align'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  // Strip javascript: pseudo-protocol from text nodes. markdown-it 14 already
  // refuses to render javascript: as an <a> href, but when it does so it emits
  // the raw markdown source as plain text, leaving the literal string in the
  // output. textFilter ensures it never appears anywhere in the final HTML.
  textFilter: (text) => text.replace(/javascript:/gi, ''),
  transformTags: {
    input: (tagName, attribs) => ({
      tagName,
      attribs: { type: 'checkbox', disabled: 'disabled', ...(attribs.checked ? { checked: 'checked' } : {}) },
    }),
  },
};

function render(rawMd) {
  const rendered = md.render(String(rawMd == null ? '' : rawMd));
  const html = sanitizeHtml(rendered, SANITIZE_OPTIONS);
  return { html };
}

module.exports = { render };
