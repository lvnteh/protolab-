# Persistent Feedback Pins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ephemeral orange feedback mode with persistent numbered blue pin markers anchored to annotated elements, and add a read-only admin preview mode that highlights a specific pin on load.

**Architecture:** The feedback SDK fetches all element-type comments on init and after each submission, rendering absolute-positioned pins via a `requestAnimationFrame` loop. A separate `preview.js` (comment data embedded as JSON in the script tag) handles the admin preview. No schema changes needed.

**Tech Stack:** Vanilla JS IIFE, Express 4, better-sqlite3, Node.js `fs`/`path`.

---

## File Map

| File | Role |
|------|------|
| `public/sdk/feedback.js` | Rewrite: remove orange UI, add pin layer + RAF repositioning + tooltip, simplify bottom bar and popup |
| `public/sdk/preview.js` | New: read-only pin viewer, reads comments from `data-comments` attr, highlights target pin |
| `src/routes/api.js` | Add `GET /api/comments/:prototypeId` endpoint |
| `src/routes/admin.js` | Add `GET /admin/prototypes/:id/preview` route |
| `src/services/inject.js` | Add `injectPreview(html, protoId, highlightId, commentsJson)` |
| `src/views/admin-prototype-detail.html` | Add "View in prototype" link-button to element-type comment rows |

---

## Task 1: Add `GET /api/comments/:prototypeId` endpoint

**Files:**
- Modify: `src/routes/api.js`

This endpoint returns all `element`-type comments for a prototype in ascending `created_at` order, with a 1-based `order` field. It requires a valid customer session (`customerAuth` middleware already imported).

- [ ] **Step 1: Open `src/routes/api.js` and add the new route after the existing `POST /comments` handler**

The current file ends at line 36. Add before `module.exports = router;`:

```js
router.get('/comments/:prototypeId', customerAuth, (req, res) => {
  if (req.session.prototypeId !== req.params.prototypeId) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  const rows = getDb().prepare(
    `SELECT id, email, element_selector, element_label, comment, created_at
     FROM comments
     WHERE prototype_id = ? AND type = 'element'
     ORDER BY created_at ASC`
  ).all(req.params.prototypeId);
  res.json(rows.map((r, i) => ({ ...r, order: i + 1 })));
});
```

- [ ] **Step 2: Verify the server starts without errors**

```bash
node src/server.js &
sleep 1
curl -s http://localhost:1337/api/comments/nonexistent -b "connect.sid=fake" | cat
# Expected: 401 or redirect to login (customerAuth rejects unauthenticated)
kill %1
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/api.js
git commit -m "feat: add GET /api/comments/:prototypeId endpoint"
```

---

## Task 2: Add `injectPreview` to `src/services/inject.js`

**Files:**
- Modify: `src/services/inject.js`

`injectPreview` embeds all element-type comments as JSON in a `data-comments` attribute so `preview.js` needs no API call. The `commentsJson` argument is the JSON string, `highlightId` is the comment ID to highlight (or empty string).

- [ ] **Step 1: Open `src/services/inject.js` — current full content is:**

```js
function sdkScript(protoId, email) {
  return `<script src="/sdk/feedback.js" data-proto-id="${protoId}" data-email="${encodeURIComponent(email)}"></script>`;
}
function injectSdk(html, protoId, email) {
  const bodyInjection = `\n${sdkScript(protoId, email)}\n`;
  let result = html;
  const lastBody = result.lastIndexOf('</body>');
  if (lastBody !== -1) {
    result = result.slice(0, lastBody) + bodyInjection + result.slice(lastBody);
  } else {
    result += bodyInjection;
  }
  return result;
}
module.exports = { injectSdk };
```

- [ ] **Step 2: Add `injectPreview` and update the exports**

Replace the entire file with:

```js
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
```

- [ ] **Step 3: Verify the server still starts and the existing prototype view works**

```bash
node src/server.js &
sleep 1
curl -s -o /dev/null -w "%{http_code}" http://localhost:1337/admin/login
# Expected: 200
kill %1
```

- [ ] **Step 4: Commit**

```bash
git add src/services/inject.js
git commit -m "feat: add injectPreview to inject service"
```

---

## Task 3: Add admin preview route to `src/routes/admin.js`

**Files:**
- Modify: `src/routes/admin.js`

The route reads the prototype file, queries all element-type comments, and serves the file with `injectPreview`. It is admin-auth protected and bypasses the customer allowlist.

- [ ] **Step 1: Add `injectPreview` to the imports at the top of `src/routes/admin.js`**

Find line 6:
```js
const config = require('../config');
```
Change to:
```js
const config = require('../config');
const { injectPreview } = require('../services/inject');
```

- [ ] **Step 2: Add the preview route before `module.exports = router;` at the bottom of `src/routes/admin.js`**

```js
router.get('/prototypes/:id/preview', adminAuth, (req, res) => {
  const db = getDb();
  const proto = db.prepare('SELECT * FROM prototypes WHERE id = ?').get(req.params.id);
  if (!proto) return res.status(404).send('Prototype not found.');

  const filePath = path.join(config.uploadsPath, proto.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Prototype file not found.');

  const highlightId = req.query.comment || '';
  const comments = db.prepare(
    `SELECT id, email, element_selector, element_label, comment, created_at
     FROM comments WHERE prototype_id = ? AND type = 'element'
     ORDER BY created_at ASC`
  ).all(proto.id).map((r, i) => ({ ...r, order: i + 1 }));

  const raw = fs.readFileSync(filePath, 'utf8');
  const html = injectPreview(raw, proto.id, highlightId, JSON.stringify(comments));
  res.send(html);
});
```

- [ ] **Step 3: Restart server and verify the route exists**

```bash
node src/server.js &
sleep 1
# Log in as admin first (session required), then:
curl -s -o /dev/null -w "%{http_code}" http://localhost:1337/admin/prototypes/nonexistent/preview -b "connect.sid=fake"
# Expected: 302 (redirect to login — adminAuth rejects unauthenticated)
kill %1
```

- [ ] **Step 4: Commit**

```bash
git add src/routes/admin.js
git commit -m "feat: add admin prototype preview route"
```

---

## Task 4: Rewrite `public/sdk/feedback.js`

**Files:**
- Modify: `public/sdk/feedback.js`

This is the largest task. Replace the entire file. Key changes vs current:
- Remove orange overlay, orange hover outlines, breadcrumb display, popup title header, "Leave feedback" label
- Add pin layer: `__fb-pins` container div, `repositionPins()` called via RAF loop
- After every successful comment submission, re-fetch pins and re-render
- Pin tooltip on click (read-only)
- Simplify bottom bar: textarea + Submit + toggle only
- Simplify popup: textarea + Post/Cancel only, blue border

- [ ] **Step 1: Replace the entire contents of `public/sdk/feedback.js` with:**

```js
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

  let pinData = []; // [{ id, email, element_selector, comment, created_at, order, el }]
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

    // Group by selector to compute horizontal offsets
    const selectorCount = {};
    comments.forEach(c => {
      selectorCount[c.element_selector] = (selectorCount[c.element_selector] || 0);
    });
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
```

- [ ] **Step 2: Restart the server and open a shared prototype link in the browser**

```bash
node src/server.js
```

Navigate to a prototype view URL (`/p/:token/view`). Verify:
- Bottom bar shows textarea + Submit + "Pin Mode" toggle (no "Leave feedback" label)
- No orange overlay or outlines in any mode
- Toggle activates Pin Mode: cursor becomes crosshair
- Clicking an element in Pin Mode shows a small blue-bordered popup with just a textarea + Post/Cancel

- [ ] **Step 3: Submit an element comment and verify a pin appears**

In Pin Mode, click an element, type a comment, click Post. Verify:
- Toast "Feedback submitted." appears
- A blue numbered pin (#1) appears anchored to the top-right of the clicked element
- The pin persists on page reload

- [ ] **Step 4: Click the pin and verify the tooltip**

Click the blue pin. Verify the tooltip shows: email (bold blue), comment text, date. Click elsewhere — tooltip dismisses.

- [ ] **Step 5: Submit a second comment on the same element**

In Pin Mode, click the same element again, post a second comment. Verify:
- Two pins appear side-by-side (pin #1 at rightmost position, pin #2 offset 26px to the left)

- [ ] **Step 6: Commit**

```bash
git add public/sdk/feedback.js
git commit -m "feat: persistent feedback pins with simplified UI"
```

---

## Task 5: Create `public/sdk/preview.js`

**Files:**
- Create: `public/sdk/preview.js`

This file is loaded by the admin preview route. It reads comment data from the script tag's `data-comments` attribute (no API call), renders pins, and highlights one pin if `data-highlight-comment` is set.

- [ ] **Step 1: Create `public/sdk/preview.js` with the following content:**

```js
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
    // Wait one frame for repositionPins to place the pin, then scroll and animate
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
```

- [ ] **Step 2: Commit**

```bash
git add public/sdk/preview.js
git commit -m "feat: add read-only preview.js with pin highlight"
```

---

## Task 6: Add "View in prototype" button to admin comments table

**Files:**
- Modify: `src/views/admin-prototype-detail.html`

In the `loadComments` function's row rendering, add a "View" button for element-type rows that opens the preview route in a new tab.

- [ ] **Step 1: Find the comments table row template in `src/views/admin-prototype-detail.html`**

Locate the `tbody.innerHTML = data.map(r => ...` block inside `loadComments` (around line 240). The current last column is the timestamp:

```js
      <td class="ts">${fmtDate(r.created_at)}</td>
    </tr>
```

- [ ] **Step 2: Add a 7th column after the timestamp cell**

Change the row template's closing section from:
```js
      <td class="ts">${fmtDate(r.created_at)}</td>
    </tr>
```
to:
```js
      <td class="ts">${fmtDate(r.created_at)}</td>
      <td>${r.type === 'element' ? `<a href="/admin/prototypes/${PROTO_ID}/preview?comment=${r.id}" target="_blank" class="btn btn-secondary" style="font-size:11px;padding:4px 8px;white-space:nowrap">View in prototype</a>` : ''}</td>
    </tr>
```

- [ ] **Step 3: Add the matching `<th>` header for the new column**

Find the comments table `<thead>` (around line 106):
```html
              <th>Submitted</th>
            </tr>
```
Change to:
```html
              <th>Submitted</th>
              <th></th>
            </tr>
```

- [ ] **Step 4: Restart the server and verify in browser**

Navigate to the admin detail page for a prototype that has element-type comments. Verify:
- Element rows show a "View in prototype" link-button in the last column
- General rows show nothing in that column
- Clicking "View in prototype" opens a new tab at `/admin/prototypes/:id/preview?comment=<id>`

- [ ] **Step 5: Verify the preview page in the new tab**

The prototype should load with all pins rendered. The target pin should pulse 3 times and the page should scroll to it.

- [ ] **Step 6: Commit**

```bash
git add src/views/admin-prototype-detail.html
git commit -m "feat: add view-in-prototype button to admin comments table"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] Persistent pins rendered from server data on every load — Task 4
- [x] Pins anchored via `getBoundingClientRect()` + RAF loop — Task 4
- [x] Multiple pins on same element spread horizontally — Task 4
- [x] Pin tooltip on click (email, comment, date) — Task 4, Task 5
- [x] Simplified feedback UI: no orange, no breadcrumb, no popup title — Task 4
- [x] `GET /api/comments/:prototypeId` endpoint — Task 1
- [x] `injectPreview` with embedded comments JSON — Task 2
- [x] Admin preview route with `adminAuth` — Task 3
- [x] `preview.js` reads from `data-comments`, no API call — Task 5
- [x] Highlight pin: pulse animation + scroll into view — Task 5
- [x] "View in prototype" button in admin comments table — Task 6

**No placeholders found.**

**Type/name consistency:**
- `loadPins()` in `feedback.js` matches the function defined in Task 4 ✓
- `renderPins(comments)` used consistently ✓
- `pinData` array shape `{ id, email, element_selector, comment, created_at, order, el, pin, offset }` used consistently across Tasks 4 and 5 ✓
- `injectPreview(html, protoId, highlightId, commentsJson)` signature matches usage in Task 3 ✓
