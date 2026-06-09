// public/sdk/feedback.js
(function () {
  const script = document.currentScript;
  const PROTO_ID = script.getAttribute('data-proto-id');
  const EMAIL = decodeURIComponent(script.getAttribute('data-email') || '');

  const STYLE = `
    #__fb-panel {
      position: fixed; bottom: 0; left: 0; right: 0; z-index: 2147483647;
      background: #fff; border-top: 2px solid #0052cc;
      padding: 8px 16px; display: flex; align-items: center; gap: 10px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px; box-shadow: 0 -2px 8px rgba(0,0,0,0.1);
      box-sizing: border-box;
    }
    #__fb-panel * { box-sizing: border-box; font-family: inherit; font-size: 13px; }
    #__fb-text {
      flex: 1; resize: none; border: 1px solid #c8d0d8; border-radius: 4px;
      padding: 5px 8px; line-height: 1.4; outline: none; min-width: 0;
      background: #fff; color: #333;
    }
    #__fb-text:focus { border-color: #0052cc; box-shadow: 0 0 0 2px rgba(0,82,204,0.15); }
    #__fb-submit {
      background: #0052cc; color: #fff; border: none; border-radius: 4px;
      padding: 6px 14px; cursor: pointer; white-space: nowrap; flex-shrink: 0;
      font-weight: 600;
    }
    #__fb-submit:hover { background: #003fa3; }
    #__fb-mode-label {
      display: flex; align-items: center; gap: 6px; white-space: nowrap;
      flex-shrink: 0; cursor: pointer; user-select: none;
    }
    #__fb-mode-label span { color: #555; }
    #__fb-mode-toggle {
      width: 36px; height: 20px; background: #c8d0d8; border-radius: 10px;
      position: relative; cursor: pointer; transition: background 0.2s;
      flex-shrink: 0; border: none; display: inline-block;
    }
    #__fb-mode-toggle::after {
      content: ''; position: absolute; width: 14px; height: 14px; background: #fff;
      border-radius: 50%; top: 3px; left: 3px; transition: left 0.2s;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }
    #__fb-mode-toggle.active { background: #0052cc; }
    #__fb-mode-toggle.active::after { left: 19px; }
    #__fb-toast {
      position: fixed; bottom: 60px; right: 16px; z-index: 2147483647;
      background: #1a7f4b; color: #fff; border-radius: 6px; padding: 8px 14px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px; opacity: 0; transition: opacity 0.2s; pointer-events: none;
    }
    #__fb-toast.visible { opacity: 1; }
    body.__fb-mode * { cursor: crosshair !important; }
    #__fb-popup {
      position: fixed; z-index: 2147483646;
      background: #fff; border: 1px solid #0052cc; border-radius: 8px;
      padding: 14px; width: 260px; box-shadow: 0 4px 16px rgba(0,0,0,0.15);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
    }
    #__fb-popup * { box-sizing: border-box; font-family: inherit; font-size: 13px; }
    .__fb-popup-textarea {
      width: 100%; resize: none; border: 1px solid #c8d0d8; border-radius: 4px;
      padding: 5px 8px; line-height: 1.4; outline: none; background: #fff; color: #333;
    }
    .__fb-popup-textarea:focus { border-color: #0052cc; box-shadow: 0 0 0 2px rgba(0,82,204,0.15); }
    .__fb-popup-actions { display: flex; gap: 8px; margin-top: 8px; }
    .__fb-btn {
      border: 1px solid #c8d0d8; background: #fff; color: #333;
      border-radius: 4px; padding: 5px 12px; cursor: pointer; font-weight: 500;
    }
    .__fb-btn:hover { background: #f5f5f5; }
    .__fb-btn-primary { background: #0052cc; color: #fff; border-color: #0052cc; font-weight: 600; }
    .__fb-btn-primary:hover { background: #003fa3; }
    #__fb-pins {
      position: absolute; top: 0; left: 0; pointer-events: none;
      z-index: 2147483639;
    }
    .__fb-pin {
      position: absolute; width: 22px; height: 22px;
      background: #0052cc; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      color: #fff; font-size: 11px; font-weight: 700;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 2px 6px rgba(0,82,204,0.4);
      cursor: pointer; pointer-events: auto;
      transition: transform 0.15s;
    }
    .__fb-pin:hover { transform: scale(1.15); }
    #__fb-tooltip {
      position: absolute; z-index: 2147483646;
      background: #fff; border: 1px solid #e0e4ea; border-radius: 8px;
      padding: 10px 12px; width: 220px; box-shadow: 0 4px 14px rgba(0,0,0,0.12);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px; line-height: 1.5; pointer-events: none;
    }
    .__fb-tooltip-email { font-weight: 700; color: #0052cc; margin-bottom: 3px; }
    .__fb-tooltip-comment { color: #333; margin-bottom: 3px; }
    .__fb-tooltip-date { color: #aaa; font-size: 11px; }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);

  // --- Pin layer ---
  const pinContainer = document.createElement('div');
  pinContainer.id = '__fb-pins';
  document.body.appendChild(pinContainer);
  document.body.style.paddingBottom = '56px';

  let pinData = []; // [{ id, email, element_selector, comment, created_at, order, el, pin, offset }]
  let rafId = null;

  function repositionPins() {
    pinData.forEach(p => {
      if (!p.el || !p.pin) return;
      try {
        const rect = p.el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        p.pin.style.left = (rect.right + window.scrollX - 11 - p.offset * 26) + 'px';
        p.pin.style.top  = (rect.top  + window.scrollY - 11) + 'px';
      } catch (e) { /* element removed */ }
    });
    rafId = requestAnimationFrame(repositionPins);
  }

  function renderPins(comments) {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    pinContainer.innerHTML = '';
    pinData = [];

    const selectorOffset = {};

    comments.forEach(c => {
      let el = null;
      try { el = document.querySelector(c.element_selector); } catch (e) {}
      if (!el) return;

      const offset = selectorOffset[c.element_selector] || 0;
      selectorOffset[c.element_selector] = offset + 1;

      const pin = document.createElement('div');
      pin.className = '__fb-pin';
      pin.textContent = c.order;
      pin.dataset.commentId = c.id;
      pinContainer.appendChild(pin);

      pinData.push({ ...c, el, pin, offset });

      pin.addEventListener('click', (e) => {
        e.stopPropagation();
        showTooltip(c, pin);
      });
    });

    if (pinData.length > 0) rafId = requestAnimationFrame(repositionPins);
  }

  // --- Tooltip ---
  let tooltipEl = null;

  function showTooltip(c, pin) {
    hideTooltip();
    tooltipEl = document.createElement('div');
    tooltipEl.id = '__fb-tooltip';
    const date = new Date(c.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    tooltipEl.innerHTML = `
      <div class="__fb-tooltip-email">${escHtml(c.email)}</div>
      <div class="__fb-tooltip-comment">${escHtml(c.comment)}</div>
      <div class="__fb-tooltip-date">${date}</div>
    `;
    pinContainer.appendChild(tooltipEl);
    const rect = pin.getBoundingClientRect();
    tooltipEl.style.left = (rect.left + window.scrollX - 99) + 'px';
    tooltipEl.style.top  = (rect.top  + window.scrollY - 90) + 'px';
  }

  function hideTooltip() {
    if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.__fb-pin')) hideTooltip();
  });

  async function loadPins() {
    try {
      const resp = await fetch('/api/comments/' + PROTO_ID, { credentials: 'include' });
      if (resp.ok) renderPins(await resp.json());
    } catch (e) {}
  }

  // --- Bottom panel ---
  const panel = document.createElement('div');
  panel.id = '__fb-panel';
  panel.innerHTML = `
    <textarea id="__fb-text" rows="1" placeholder="General comment about this screen..."></textarea>
    <button type="button" id="__fb-submit">Submit</button>
    <label id="__fb-mode-label">
      <div id="__fb-mode-toggle"></div>
      <span>Pin Mode</span>
    </label>
  `;
  document.body.appendChild(panel);

  const toast = document.createElement('div');
  toast.id = '__fb-toast';
  toast.textContent = 'Feedback submitted.';
  document.body.appendChild(toast);

  document.getElementById('__fb-submit').addEventListener('click', async () => {
    const text = document.getElementById('__fb-text').value.trim();
    if (!text) return;
    await postComment({ type: 'general', comment: text, pageUrl: location.href });
    document.getElementById('__fb-text').value = '';
    showToast();
  });

  // --- Pin mode toggle ---
  let pinModeActive = false;
  const toggleBtn = document.getElementById('__fb-mode-toggle');
  let popup = null;

  document.getElementById('__fb-mode-label').addEventListener('click', () => {
    pinModeActive = !pinModeActive;
    toggleBtn.classList.toggle('active', pinModeActive);
    document.body.classList.toggle('__fb-mode', pinModeActive);
    if (!pinModeActive) closePopup();
  });

  document.addEventListener('click', (e) => {
    if (!pinModeActive) return;
    if (e.target.closest('#__fb-panel') || e.target.closest('#__fb-popup') || e.target.closest('.__fb-pin')) return;
    e.preventDefault();
    e.stopPropagation();

    const el = e.target;
    const selector = getCssSelector(el);
    closePopup();

    popup = document.createElement('div');
    popup.id = '__fb-popup';
    popup.innerHTML = `
      <textarea class="__fb-popup-textarea" rows="3" placeholder="What do you think about this element?"></textarea>
      <div class="__fb-popup-actions">
        <button type="button" class="__fb-btn __fb-btn-primary" id="__fb-popup-post">Post</button>
        <button type="button" class="__fb-btn" id="__fb-popup-cancel">Cancel</button>
      </div>
    `;

    const rect = el.getBoundingClientRect();
    popup.style.top  = Math.min(rect.bottom + 8, window.innerHeight - 160) + 'px';
    popup.style.left = Math.min(rect.left, window.innerWidth - 280) + 'px';
    document.body.appendChild(popup);

    document.getElementById('__fb-popup-cancel').onclick = closePopup;
    document.getElementById('__fb-popup-post').onclick = async () => {
      const text = popup.querySelector('textarea').value.trim();
      if (!text) return;
      const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.tagName)
        .trim().replace(/\s+/g, ' ').slice(0, 60);
      await postComment({
        type: 'element',
        element: { selector, label, tagName: el.tagName },
        comment: text,
        pageUrl: location.href,
      });
      closePopup();
      showToast();
      await loadPins();
    };
  }, true);

  function closePopup() {
    if (popup) { popup.remove(); popup = null; }
  }

  function showToast() {
    const t = document.getElementById('__fb-toast');
    t.classList.add('visible');
    setTimeout(() => t.classList.remove('visible'), 2500);
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

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  loadPins();
})();
