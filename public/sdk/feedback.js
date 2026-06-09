// public/sdk/feedback.js
(function () {
  const script = document.currentScript;
  const PROTO_ID = script.getAttribute('data-proto-id');
  const EMAIL = decodeURIComponent(script.getAttribute('data-email') || '');

  // --- Breadcrumb tracker ---
  const breadcrumb = [];
  document.addEventListener('click', function (e) {
    const el = e.target;
    if (el.closest('#__feedback-panel')) return;
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.tagName)
      .trim().slice(0, 60);
    breadcrumb.push(label);
    if (breadcrumb.length > 10) breadcrumb.shift();
  }, true);

  // --- Persistent bottom panel ---
  const panel = document.createElement('div');
  panel.id = '__feedback-panel';
  panel.style.cssText = [
    'position:fixed', 'bottom:0', 'left:0', 'right:0', 'z-index:99999',
    'background:var(--e-color-background-default,#fff)',
    'border-top:2px solid var(--e-color-primary,#0064d8)',
    'padding:8px 16px', 'display:flex', 'align-items:center', 'gap:12px',
    'font-family:var(--e-font-family,sans-serif)'
  ].join(';');

  panel.innerHTML = `
    <span style="font-size:13px;font-weight:600;white-space:nowrap;color:var(--e-color-primary,#0064d8)">
      Leave feedback
    </span>
    <textarea id="__fb-general-text" class="e-input e-input-textarea"
      rows="1" placeholder="General comment about this screen..."
      style="flex:1;resize:none;"></textarea>
    <button type="button" id="__fb-submit" class="e-btn e-btn-highlight">Submit Feedback</button>
    <e-switch id="__fb-mode-switch" label="Feedback Mode" name="feedback-mode"></e-switch>
    <e-notification id="__fb-success" type="success" autoclose style="position:absolute;bottom:60px;right:16px;">
      <e-notification-content>Feedback submitted.</e-notification-content>
    </e-notification>
  `;
  document.body.appendChild(panel);
  document.body.style.paddingBottom = '56px';

  // --- General comment submit ---
  document.getElementById('__fb-submit').addEventListener('click', async function () {
    const text = document.getElementById('__fb-general-text').value.trim();
    if (!text) return;
    await postComment({ type: 'general', comment: text, pageUrl: location.href });
    document.getElementById('__fb-general-text').value = '';
    showSuccess();
  });

  // --- Feedback mode ---
  let feedbackModeActive = false;

  const overlay = document.createElement('div');
  overlay.id = '__fb-overlay';
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:99990',
    'background:rgba(255,136,68,0.06)', 'pointer-events:none', 'display:none'
  ].join(';');
  document.body.appendChild(overlay);

  const highlightStyle = document.createElement('style');
  highlightStyle.textContent = `
    body.__fb-mode *:not(#__feedback-panel):not(#__feedback-panel *):not(#__fb-overlay):not(#__fb-popup):not(#__fb-popup *) {
      cursor: crosshair !important;
    }
    body.__fb-mode *:not(#__feedback-panel):not(#__feedback-panel *):not(#__fb-overlay):not(#__fb-popup):not(#__fb-popup *):hover {
      outline: 2px solid rgba(255,136,68,0.8) !important;
      outline-offset: 2px !important;
    }
  `;
  document.head.appendChild(highlightStyle);

  document.getElementById('__fb-mode-switch').addEventListener('change', function (e) {
    feedbackModeActive = e.target.checked;
    overlay.style.display = feedbackModeActive ? 'block' : 'none';
    document.body.classList.toggle('__fb-mode', feedbackModeActive);
    if (!feedbackModeActive) closePopup();
  });

  // --- Element annotation popup ---
  let popup = null;

  document.addEventListener('click', function (e) {
    if (!feedbackModeActive) return;
    if (e.target.closest('#__feedback-panel') || e.target.closest('#__fb-popup')) return;
    e.preventDefault();
    e.stopPropagation();

    const el = e.target;
    const selector = getCssSelector(el);
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 60);
    const breadcrumbCopy = [...breadcrumb];

    closePopup();
    popup = document.createElement('div');
    popup.id = '__fb-popup';
    popup.style.cssText = [
      'position:fixed', 'z-index:99995',
      'background:var(--e-color-background-default,#fff)',
      'border:1px solid rgba(255,136,68,0.8)', 'border-radius:8px',
      'padding:14px', 'width:280px',
      'box-shadow:0 4px 16px rgba(0,0,0,0.2)',
      'font-family:var(--e-font-family,sans-serif)', 'font-size:13px'
    ].join(';');

    const rect = el.getBoundingClientRect();
    popup.style.top  = Math.min(rect.bottom + 8, window.innerHeight - 200) + 'px';
    popup.style.left = Math.min(rect.left, window.innerWidth - 300) + 'px';

    popup.innerHTML = `
      <div style="color:rgba(255,136,68,1);font-size:11px;font-weight:600;margin-bottom:6px;text-transform:uppercase;">
        Annotating: "${label}"
      </div>
      <div style="font-size:11px;color:#666;margin-bottom:8px;">
        Journey: ${breadcrumbCopy.length ? breadcrumbCopy.join(' → ') + ' → <strong>here</strong>' : '<em>start of session</em>'}
      </div>
      <textarea id="__fb-popup-text" class="e-input e-input-textarea" rows="3"
        placeholder="What do you think about this element?" style="width:100%;box-sizing:border-box;"></textarea>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button type="button" id="__fb-popup-post" class="e-btn e-btn-highlight">Post</button>
        <button type="button" id="__fb-popup-cancel" class="e-btn">Cancel</button>
      </div>
    `;
    document.body.appendChild(popup);

    document.getElementById('__fb-popup-cancel').onclick = closePopup;
    document.getElementById('__fb-popup-post').onclick = async function () {
      const text = document.getElementById('__fb-popup-text').value.trim();
      if (!text) return;
      await postComment({
        type: 'element',
        element: { selector, label, tagName: el.tagName },
        breadcrumb: breadcrumbCopy,
        comment: text,
        pageUrl: location.href,
      });
      closePopup();
      showSuccess();
    };
  }, true);

  function closePopup() {
    if (popup) { popup.remove(); popup = null; }
  }

  function showSuccess() {
    const notif = document.getElementById('__fb-success');
    if (notif) notif.classList.add('e-notification-visible');
  }

  async function postComment(payload) {
    await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prototypeId: PROTO_ID, email: EMAIL, ...payload }),
      credentials: 'include',
    });
  }

  function getCssSelector(el) {
    if (el.id) return '#' + el.id;
    const parts = [];
    let node = el;
    while (node && node !== document.body) {
      let part = node.tagName.toLowerCase();
      const first = (node.className || '').toString().trim().split(/\s+/)[0];
      if (first) part += '.' + first;
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
})();
