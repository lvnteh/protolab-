const SUGAR_CSS = `<link rel="stylesheet" href="https://client-version.cf.emarsys.net/ui/latest/css/app.css">`;
const SUGAR_JS  = `<script src="https://client-version.cf.emarsys.net/ui/latest/js/app.js"></script>`;

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
  const headInjection = `\n${SUGAR_CSS}\n${SUGAR_JS}\n`;
  let result = html.includes('</head>')
    ? html.replace('</head>', `${headInjection}</head>`)
    : html;
  return injectBefore(result, sdkScript(protoId, email));
}

function injectPreview(html, protoId, highlightId, commentsJson) {
  return injectBefore(html, previewScript(protoId, highlightId, commentsJson));
}

module.exports = { injectSdk, injectPreview };
