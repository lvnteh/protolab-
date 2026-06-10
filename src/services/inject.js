
function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sdkScript(protoId, email) {
  return `<script src="/sdk/feedback.js" data-proto-id="${escAttr(protoId)}" data-email="${encodeURIComponent(email)}"></script>`;
}

function previewScript(protoId, highlightId, commentsJson) {
  return `<script src="/sdk/preview.js" data-proto-id="${escAttr(protoId)}" data-highlight-comment="${escAttr(highlightId)}" data-comments="${escAttr(commentsJson)}"></script>`;
}

function matchesAt(html, pos, needle) {
  // Case-insensitive match without creating a lowercased copy (avoids index drift with multi-byte chars)
  if (pos + needle.length > html.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (html[pos + i].toLowerCase() !== needle[i]) return false;
  }
  return true;
}

function scanHtml(html) {
  const len = html.length;
  let i = 0;
  let lastHeadClose = -1;
  let lastBodyClose = -1;

  while (i < len) {
    if (html[i] !== '<') { i++; continue; }

    // Opening <script ...> tag — skip its body to avoid matching tags inside JS strings
    if (matchesAt(html, i + 1, 'script') &&
        (html[i + 7] === '>' || html[i + 7] === ' ' || html[i + 7] === '\n' ||
         html[i + 7] === '\r' || html[i + 7] === '\t' || html[i + 7] === '/')) {
      const tagEnd = html.indexOf('>', i);
      if (tagEnd === -1) break;
      if (html[tagEnd - 1] === '/') { i = tagEnd + 1; continue; } // self-closing
      i = tagEnd + 1;
      while (i < len) {
        if (html[i] === '<' && matchesAt(html, i + 1, '/script>')) {
          i += 9; break;
        }
        if (html[i] === '"' || html[i] === "'" || html[i] === '`') {
          const q = html[i++];
          while (i < len) {
            if (html[i] === '\\') { i += 2; continue; }
            if (html[i] === q) { i++; break; }
            if (q === '`' && html[i] === '$' && html[i + 1] === '{') {
              let depth = 1; i += 2;
              while (i < len && depth > 0) {
                if (html[i] === '{') depth++;
                else if (html[i] === '}') depth--;
                i++;
              }
              continue;
            }
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }

    if (matchesAt(html, i + 1, '/head>')) lastHeadClose = i;
    if (matchesAt(html, i + 1, '/body>')) lastBodyClose = i;

    i++;
  }

  return { lastHeadClose, lastBodyClose };
}

function injectSdk(html, protoId, email) {
  const { lastBodyClose } = scanHtml(html);
  const sdkTag = sdkScript(protoId, email);
  if (lastBodyClose !== -1) {
    return html.slice(0, lastBodyClose) + `\n${sdkTag}\n` + html.slice(lastBodyClose);
  }
  return html + `\n${sdkTag}\n`;
}

function injectPreview(html, protoId, highlightId, commentsJson) {
  const { lastBodyClose } = scanHtml(html);
  const tag = previewScript(protoId, highlightId, commentsJson);
  if (lastBodyClose !== -1) {
    return html.slice(0, lastBodyClose) + `\n${tag}\n` + html.slice(lastBodyClose);
  }
  return html + `\n${tag}\n`;
}

module.exports = { injectSdk, injectPreview };
