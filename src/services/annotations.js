// src/services/annotations.js
// Shared, version-scoped persistence for both comments and explanations. One
// resolver (resolveViewedVersion) governs the read filter and the write stamp,
// so a reviewer can neither read nor stamp a draft's annotation set.
const { nanoid } = require('nanoid');
const { getDb } = require('../db');

const VALID_TAGS = ['bug', 'copy', 'question', 'idea', 'other'];

// requestedVersion is an integer version NUMBER (query ?version / body.version),
// honored only when it names a PUBLISHED version of this prototype; otherwise we
// fall back to the live pointer. Returns { versionId } (row id) or { versionId:null }.
async function resolveViewedVersion(prototypeId, requestedVersion) {
  const { rows: protoRows } = await getDb().query(
    'SELECT published_version_id FROM prototypes WHERE id = $1', [prototypeId]);
  const pointer = protoRows[0] ? protoRows[0].published_version_id : null;
  if (requestedVersion != null) {
    const v = parseInt(requestedVersion, 10);
    if (!Number.isNaN(v)) {
      const { rows } = await getDb().query(
        `SELECT id FROM prototype_versions
         WHERE prototype_id = $1 AND version = $2 AND status = 'published'`,
        [prototypeId, v]);
      if (rows[0]) return { versionId: rows[0].id };
    }
  }
  return { versionId: pointer };
}

// Range (markdown text-selection) comments carry an anchor; element/general do not.
function serializeAnchorCols(type, anchor) {
  if (type !== 'range') return { quote: null, prefix: null, suffix: null, start: null, end: null };
  if (!anchor || !anchor.quote || !String(anchor.quote).trim()) {
    const e = new Error('Range comment requires an anchor quote.'); e.code = 'ANCHOR_REQUIRED'; throw e;
  }
  return {
    quote: String(anchor.quote),
    prefix: anchor.prefix != null ? String(anchor.prefix) : null,
    suffix: anchor.suffix != null ? String(anchor.suffix) : null,
    start: Number.isInteger(anchor.start) ? anchor.start : null,
    end: Number.isInteger(anchor.end) ? anchor.end : null,
  };
}

function anchorFromRow(row) {
  return row.anchor_quote ? {
    quote: row.anchor_quote,
    prefix: row.anchor_prefix || '',
    suffix: row.anchor_suffix || '',
    start: row.anchor_start ?? null,
    end: row.anchor_end ?? null,
  } : null;
}

async function listComments(prototypeId, versionId) {
  const { rows } = await getDb().query(
    `SELECT id, email, type, element_selector, element_label, comment, created_at, tag, x_pct, y_pct, page_url, parent_id,
            anchor_quote, anchor_prefix, anchor_suffix, anchor_start, anchor_end
     FROM comments
     WHERE prototype_id = $1 AND version_id IS NOT DISTINCT FROM $2
     ORDER BY created_at ASC`,
    [prototypeId, versionId]);

  const parents = [];
  const replyMap = {};
  rows.forEach(r => {
    if (r.parent_id) {
      (replyMap[r.parent_id] ||= []).push({ id: r.id, email: r.email, comment: r.comment, created_at: r.created_at });
    } else {
      parents.push(r);
    }
  });
  return parents.map((r, i) => ({ ...r, order: i + 1, replies: replyMap[r.id] || [] }));
}

async function listExplanations(prototypeId, versionId) {
  const { rows } = await getDb().query(
    `SELECT id, element_selector, x_pct, y_pct, page_url, body, created_at, updated_at
     FROM explanations
     WHERE prototype_id = $1 AND version_id IS NOT DISTINCT FROM $2
     ORDER BY created_at ASC`,
    [prototypeId, versionId]);
  return rows;
}

async function createComment(prototypeId, versionId, fields) {
  const id = nanoid(12);
  const email = fields.email || 'local@test.com';
  if (fields.parentId) {
    await getDb().query(
      `INSERT INTO comments (id, prototype_id, email, type, comment, created_at, parent_id, version_id)
       VALUES ($1,$2,$3,'reply',$4,$5,$6,$7)`,
      [id, prototypeId, email, fields.comment.trim(), new Date().toISOString(), fields.parentId, versionId]);
    return { id };
  }
  const anchorCols = serializeAnchorCols(fields.type, fields.anchor);
  await getDb().query(
    `INSERT INTO comments
       (id, prototype_id, email, type, element_selector, element_label, element_tag,
        breadcrumb, comment, page_url, created_at, tag, x_pct, y_pct, version_id,
        anchor_quote, anchor_prefix, anchor_suffix, anchor_start, anchor_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [
      id, prototypeId, email, fields.type,
      fields.element?.selector || null,
      fields.element?.label || null,
      fields.element?.tagName || null,
      fields.breadcrumb ? JSON.stringify(fields.breadcrumb) : null,
      fields.comment.trim(),
      fields.pageUrl || null,
      new Date().toISOString(),
      VALID_TAGS.includes(fields.tag) ? fields.tag : null,
      typeof fields.xPct === 'number' ? fields.xPct : null,
      typeof fields.yPct === 'number' ? fields.yPct : null,
      versionId,
      anchorCols.quote, anchorCols.prefix, anchorCols.suffix, anchorCols.start, anchorCols.end,
    ]);
  return { id };
}

async function createExplanation(prototypeId, versionId, fields) {
  const id = nanoid(12);
  const now = new Date().toISOString();
  await getDb().query(
    `INSERT INTO explanations (id, prototype_id, element_selector, x_pct, y_pct, page_url, body, created_at, updated_at, version_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, prototypeId, fields.elementSelector,
     typeof fields.xPct === 'number' ? fields.xPct : null,
     typeof fields.yPct === 'number' ? fields.yPct : null,
     fields.pageUrl || null, fields.body.trim(), now, now, versionId]);
  return { id };
}

module.exports = {
  resolveViewedVersion, serializeAnchorCols, anchorFromRow,
  listComments, listExplanations, createComment, createExplanation,
};
