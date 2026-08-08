// src/services/filetype.js
// Single source of truth for how uploaded files map to a stored content_type
// ('html' | 'markdown'), the storage MIME type, and the on-disk extension.
// Keeps .html/.md branching out of the routes.

function contentTypeForFilename(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  return null;
}

function isAccepted(name) {
  return contentTypeForFilename(name) !== null;
}

function extForContentType(ct) {
  return ct === 'markdown' ? 'md' : 'html';
}

function mimeForContentType(ct) {
  return ct === 'markdown'
    ? 'text/markdown; charset=utf-8'
    : 'text/html; charset=utf-8';
}

module.exports = { contentTypeForFilename, isAccepted, extForContentType, mimeForContentType };
