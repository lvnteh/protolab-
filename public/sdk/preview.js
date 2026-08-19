// public/sdk/preview.js
(function () {
  const script = document.currentScript;
  const highlightId = script.getAttribute('data-highlight-comment') || '';
  let comments = [];
  try { comments = JSON.parse(script.getAttribute('data-comments') || '[]'); } catch (e) {}

  const TAG_COLOR = {
    bug:      'hsl(0,84%,60%)',
    copy:     'hsl(38,92%,50%)',
    question: 'hsl(217,91%,60%)',
    idea:     'hsl(142,71%,45%)',
    other:    'hsl(252,83%,57%)',
  };
  const TAG_LABEL = { bug: 'Bug', copy: 'Copy', question: 'Question', idea: 'Idea', other: 'Other' };

  function pinColor(tag) { return TAG_COLOR[tag] || TAG_COLOR.other; }

  const STYLE = `
    #__fb-pins {
      position: fixed; top: 0; left: 0; width: 0; height: 0; pointer-events: none;
      z-index: 2147483639;
    }
    .__fb-pin {
      position: absolute; width: 24px; height: 24px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      color: #fff; font-size: 11px; font-weight: 700;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 2px 8px rgba(0,0,0,.25), 0 0 0 2px #fff;
      cursor: pointer; pointer-events: auto;
      transform: translate(-50%,-50%);
    }
    .__fb-pin:hover { transform: translate(-50%,-50%); }
    .__fb-pin--highlight {
      animation: __fb-pulse 0.6s ease-in-out 3;
    }
    @keyframes __fb-pulse {
      0%   { transform: translate(-50%,-50%) scale(1); }
      50%  { transform: translate(-50%,-50%) scale(1.4); }
      100% { transform: translate(-50%,-50%) scale(1); }
    }
    #__fb-tooltip {
      position: fixed; z-index: 2147483646;
      background: #fff; border: 1px solid hsl(220,13%,91%); border-radius: 12px;
      padding: 14px 16px; width: 280px; box-shadow: 0 4px 16px rgba(0,0,0,.12);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px; line-height: 1.55; pointer-events: none;
    }
    .__fb-tooltip-tag {
      display: inline-block; padding: 2px 8px; border-radius: 20px;
      font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
      color: #fff; margin-bottom: 7px;
    }
    .__fb-tooltip-email { font-weight: 600; color: hsl(252,83%,50%); margin-bottom: 4px; }
    .__fb-tooltip-comment { font-weight: 400; color: hsl(222,47%,11%); margin-bottom: 4px; white-space: pre-wrap; }
    .__fb-tooltip-date { color: hsl(220,9%,46%); font-size: 12px; }
    .__fb-tooltip-replies {
      margin-top: 8px; padding-top: 8px;
      border-top: 1px solid hsl(220,13%,91%);
      display: flex; flex-direction: column; gap: 4px;
    }
    .__fb-tooltip-reply { font-size: 12px; color: hsl(222,47%,11%); line-height: 1.4; }
    .__fb-tooltip-reply-email { font-weight: 600; color: hsl(252,83%,50%); margin-right: 3px; }
    .__fb-tooltip-reply-date { color: hsl(220,9%,46%); font-size: 11px; margin-left: 3px; }
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
      // Retry selector resolution each frame until the element appears
      if (!p.el) {
        try { p.el = document.querySelector(p.element_selector); } catch (e) {}
      }
      if (!p.el) return;
      try {
        const rect = p.el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) { p.pin.style.display = 'none'; return; }
        p.pin.style.display = '';
        const ox = typeof p.x_pct === 'number' ? p.x_pct : (1 - p.offset * 0.15);
        const oy = typeof p.y_pct === 'number' ? p.y_pct : 0;
        p.pin.style.left = (rect.left + rect.width  * ox) + 'px';
        p.pin.style.top  = (rect.top  + rect.height * oy) + 'px';
      } catch (e) {}
    });
    rafId = requestAnimationFrame(repositionPins);
  }

  function showTooltip(c, pin) {
    if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
    tooltipEl = document.createElement('div');
    tooltipEl.id = '__fb-tooltip';
    const date = new Date(c.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const tagHtml = c.tag
      ? `<div class="__fb-tooltip-tag" style="background:${pinColor(c.tag)}">${TAG_LABEL[c.tag] || c.tag}</div>`
      : '';
    const repliesHtml = (c.replies || []).map(r => {
      const rDate = new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
      return `<div class="__fb-tooltip-reply">
        <span class="__fb-tooltip-reply-email">${escHtml(r.email)}</span>${escHtml(r.comment)}<span class="__fb-tooltip-reply-date">· ${rDate}</span>
      </div>`;
    }).join('');

    const repliesBlock = (c.replies && c.replies.length)
      ? `<div class="__fb-tooltip-replies">${repliesHtml}</div>`
      : '';

    tooltipEl.innerHTML = `
      ${tagHtml}
      <div class="__fb-tooltip-email">${escHtml(c.email)}</div>
      <div class="__fb-tooltip-comment">${escHtml(c.comment)}</div>
      <div class="__fb-tooltip-date">${date}</div>
      ${repliesBlock}
    `;
    pinContainer.appendChild(tooltipEl);
    const rect = pin.getBoundingClientRect();
    const TW = 280, MARGIN = 8;
    const th = tooltipEl.offsetHeight || 120;
    let left = rect.left + rect.width / 2 - TW / 2;
    let top  = rect.top - th - 10;
    if (left + TW + MARGIN > window.innerWidth) left = window.innerWidth - TW - MARGIN;
    if (left < MARGIN) left = MARGIN;
    if (top < MARGIN) top = rect.bottom + 10;
    if (top + th + MARGIN > window.innerHeight) top = rect.top - th - 10;
    tooltipEl.style.left = left + 'px';
    tooltipEl.style.top  = top  + 'px';
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.__fb-pin') && tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
  });

  const selectorOffset = {};
  let highlightPin = null;

  comments.forEach(c => {
    let el = null;
    try { el = document.querySelector(c.element_selector); } catch (e) {}
    // el may be null if React hasn't rendered yet — RAF loop retries each frame

    const offset = selectorOffset[c.element_selector] || 0;
    selectorOffset[c.element_selector] = offset + 1;

    const pin = document.createElement('div');
    pin.className = '__fb-pin';
    pin.textContent = c.order;
    pin.style.background = pinColor(c.tag);
    pin.style.display = 'none';
    pin.dataset.commentId = c.id;
    pinContainer.appendChild(pin);

    pinData.push({ ...c, el, pin, offset });

    pin.addEventListener('click', (e) => { e.stopPropagation(); showTooltip(c, pin); });

    if (String(c.id) === highlightId) highlightPin = { pin, data: c };
  });

  rafId = requestAnimationFrame(repositionPins);

  // Range (text-selection) comments — read-only highlights + click-to-tooltip.
  const rangeComments = comments.filter(c => c.type === 'range' && c.anchor_quote);
  function renderRanges() {
    document.querySelectorAll('mark.__fb-mark').forEach(m => {
      const p = m.parentNode; if (!p) return;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
      p.normalize && p.normalize(); // re-coalesce split text nodes (parity with feedback.js)
    });
    rangeComments.forEach(c => {
      const anchor = { quote: c.anchor_quote, prefix: c.anchor_prefix, suffix: c.anchor_suffix, start: c.anchor_start, end: c.anchor_end };
      const range = window.FBAnchor && window.FBAnchor.resolveAnchor(anchor, document.body);
      if (!range) return;
      try {
        const mark = document.createElement('mark');
        mark.className = '__fb-mark';
        const color = pinColor(c.tag);
        mark.style.cssText = `background:${color.replace('hsl(', 'hsla(').replace(')', ',0.28)')};border-radius:2px;cursor:pointer`;
        range.surroundContents(mark);
        mark.addEventListener('click', e => { e.stopPropagation(); showTooltip(c, mark); });
      } catch (_) { /* partial-node range: skip highlight; pin list still shows it */ }
    });
  }
  requestAnimationFrame(() => requestAnimationFrame(renderRanges));

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }
    else if (!rafId) rafId = requestAnimationFrame(repositionPins);
  });

  if (highlightPin) {
    const hp = highlightPin;
    function tryHighlight() {
      const entry = pinData.find(p => String(p.id) === highlightId);
      if (entry && entry.el) {
        hp.pin.classList.add('__fb-pin--highlight');
        entry.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        requestAnimationFrame(tryHighlight);
      }
    }
    requestAnimationFrame(() => requestAnimationFrame(tryHighlight));
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
})();
