function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sdkScript(protoId, email) {
  return `<script src="/sdk/feedback.js" data-proto-id="${escAttr(protoId)}" data-email="${encodeURIComponent(email)}"></script>`;
}

function previewScript(protoId, highlightId, commentsJson) {
  return `<script src="/sdk/preview.js" data-proto-id="${escAttr(protoId)}" data-highlight-comment="${escAttr(highlightId)}" data-comments="${escAttr(commentsJson)}"></script>`;
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
