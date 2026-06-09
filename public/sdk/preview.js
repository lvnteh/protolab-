// public/sdk/preview.js
(function () {
  const script = document.currentScript;
  const highlightId = script.getAttribute('data-highlight-comment') || '';
  let comments = [];
  try { comments = JSON.parse(script.getAttribute('data-comments') || '[]'); } catch (e) {}

  const STYLE = `
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
    .__fb-pin--highlight {
      animation: __fb-pulse 0.6s ease-in-out 3;
    }
    @keyframes __fb-pulse {
      0%   { transform: scale(1); }
      50%  { transform: scale(1.4); }
      100% { transform: scale(1); }
    }
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

  const pinContainer = document.createElement('div');
  pinContainer.id = '__fb-pins';
  document.body.appendChild(pinContainer);

  let pinData = [];
  let rafId = null;
  let tooltipEl = null;

  function repositionPins() {
    pinData.forEach(p => {
      if (!p.el || !p.pin) return;
      try {
        const rect = p.el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        p.pin.style.left = (rect.right + window.scrollX - 11 - p.offset * 26) + 'px';
        p.pin.style.top  = (rect.top  + window.scrollY - 11) + 'px';
      } catch (e) {}
    });
    rafId = requestAnimationFrame(repositionPins);
  }

  function showTooltip(c, pin) {
    if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
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

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.__fb-pin') && tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
  });

  const selectorOffset = {};
  let highlightPin = null;

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

    pin.addEventListener('click', (e) => { e.stopPropagation(); showTooltip(c, pin); });

    if (c.id === highlightId) highlightPin = { pin, el };
  });

  if (pinData.length > 0) rafId = requestAnimationFrame(repositionPins);

  if (highlightPin) {
    // Wait two frames for repositionPins to place the pin before scrolling
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        highlightPin.pin.classList.add('__fb-pin--highlight');
        highlightPin.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
})();
