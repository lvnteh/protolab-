// src/services/inject.js
const SUGAR_CSS = `<link rel="stylesheet" href="https://client-version.cf.emarsys.net/ui/latest/css/app.css">`;
const SUGAR_JS  = `<script src="https://client-version.cf.emarsys.net/ui/latest/js/app.js"></script>`;

function sdkScript(protoId, email) {
  return `<script src="/sdk/feedback.js" data-proto-id="${protoId}" data-email="${encodeURIComponent(email)}"></script>`;
}

function injectSdk(html, protoId, email) {
  const headInjection = `\n${SUGAR_CSS}\n${SUGAR_JS}\n`;
  const bodyInjection = `\n${sdkScript(protoId, email)}\n`;

  let result = html;
  if (result.includes('</head>')) {
    result = result.replace('</head>', `${headInjection}</head>`);
  }
  if (result.includes('</body>')) {
    result = result.replace('</body>', `${bodyInjection}</body>`);
  } else {
    result += bodyInjection;
  }
  return result;
}

module.exports = { injectSdk };
