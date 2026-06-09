function sdkScript(protoId, email) {
  return `<script src="/sdk/feedback.js" data-proto-id="${protoId}" data-email="${encodeURIComponent(email)}"></script>`;
}

function previewScript(protoId, highlightId, commentsJson) {
  const safeComments = commentsJson.replace(/</g, '\\u003c').replace(/"/g, '&quot;');
  return `<script src="/sdk/preview.js" data-proto-id="${protoId}" data-highlight-comment="${highlightId}" data-comments="${safeComments}"></script>`;
}

function injectBefore(html, scriptTag) {
  const lastBody = html.lastIndexOf('</body>');
  const injection = `\n${scriptTag}\n`;
  if (lastBody !== -1) {
    return html.slice(0, lastBody) + injection + html.slice(lastBody);
  }
  return html + injection;
}

function injectSdk(html, protoId, email) {
  return injectBefore(html, sdkScript(protoId, email));
}

function injectPreview(html, protoId, highlightId, commentsJson) {
  return injectBefore(html, previewScript(protoId, highlightId, commentsJson));
}

module.exports = { injectSdk, injectPreview };
