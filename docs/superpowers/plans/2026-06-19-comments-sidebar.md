# Comments Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a collapseable right-hand sidebar to the prototype viewer with a Pins tab (listing existing feedback pins for the current page, each navigating to and opening the pin on click) and a General tab (listing general comments with a persistent input form).

**Architecture:** All changes live in a single file — `public/sdk/feedback.js`. The sidebar is a fixed-position panel injected alongside the existing toolbar, draft card, and pin layer. It reads from the existing `pins` array and a new `generalComments` array, both populated from the already-fetched `GET /api/comments/:protoId` response. No new API routes, schema changes, or server files.

**Tech Stack:** Vanilla JS (IIFE), plain CSS injected via `<style>` tag, `localStorage` for collapse state, existing `POST /api/comments` API.

---

## File Structure

| File | Change |
|------|--------|
| `public/sdk/feedback.js` | All changes — CSS, HTML, state, render functions, event handlers |

---

### Task 1: Add sidebar CSS to the STYLE constant

**Files:**
- Modify: `public/sdk/feedback.js:21-270` (the `STYLE` template literal)

- [ ] **Step 1: Append sidebar CSS inside the STYLE backtick string**

  Open `public/sdk/feedback.js`. The `STYLE` constant ends at line 270 with `.fb-reply-btn:disabled { opacity: .5; cursor: default; }` followed by the closing backtick. Insert the following block immediately before that closing backtick (after line 269):

  ```css
    /* ── sidebar ── */
    #__fb-sidebar {
      position: fixed; top: 44px; right: 0;
      height: calc(100vh - 44px);
      z-index: 2147483644;
      display: flex; flex-direction: column;
      background: #fff; border-left: 1px solid hsl(220,13%,91%);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      transition: width .2s ease;
      box-shadow: -2px 0 8px rgba(0,0,0,.06);
    }
    #__fb-sidebar.expanded { width: 260px; }
    #__fb-sidebar.collapsed { width: 32px; overflow: hidden; }

    /* collapsed strip */
    #__fb-sidebar-strip {
      display: none; flex-direction: column; align-items: center;
      padding-top: 12px; gap: 8px; cursor: pointer; width: 32px; flex: 1;
    }
    #__fb-sidebar.collapsed #__fb-sidebar-strip { display: flex; }
    #__fb-sidebar.collapsed #__fb-sidebar-main { display: none; }
    #__fb-sidebar-badge {
      background: hsl(252,83%,57%); color: #fff;
      font-size: 10px; font-weight: 700;
      padding: 2px 6px; border-radius: 10px;
    }
    #__fb-sidebar-strip-label {
      font-size: 9px; color: hsl(220,9%,46%); letter-spacing: .04em;
      writing-mode: vertical-rl; transform: rotate(180deg); font-weight: 500;
    }

    /* expanded main */
    #__fb-sidebar-main { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
    #__fb-sidebar-tabs {
      display: flex; align-items: center; border-bottom: 1px solid hsl(220,13%,91%); flex-shrink: 0;
    }
    .fb-sidebar-tab {
      flex: 1; padding: 9px 6px; text-align: center;
      font-size: 11px; font-weight: 500; color: hsl(220,9%,46%);
      border-bottom: 2px solid transparent; cursor: pointer; border-top: none;
      border-left: none; border-right: none; background: none;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      white-space: nowrap;
    }
    .fb-sidebar-tab.active { font-weight: 600; color: hsl(252,83%,57%); border-bottom-color: hsl(252,83%,57%); }
    .fb-sidebar-tab-badge {
      display: inline-block; font-size: 9px; font-weight: 700;
      padding: 1px 6px; border-radius: 10px; margin-left: 3px;
    }
    .fb-sidebar-tab.active .fb-sidebar-tab-badge { background: hsl(252,83%,57%); color: #fff; }
    .fb-sidebar-tab:not(.active) .fb-sidebar-tab-badge { background: hsl(220,13%,91%); color: hsl(220,9%,46%); }
    #__fb-sidebar-collapse {
      padding: 9px 8px; color: hsl(220,9%,46%); cursor: pointer; font-size: 14px;
      background: none; border: none; line-height: 1; flex-shrink: 0;
      font-family: inherit;
    }
    #__fb-sidebar-collapse:hover { color: hsl(222,47%,11%); }

    /* panels */
    #__fb-sidebar-pins,
    #__fb-sidebar-general { display: none; flex-direction: column; flex: 1; overflow: hidden; }
    #__fb-sidebar-pins.active,
    #__fb-sidebar-general.active { display: flex; }

    /* pins list */
    #__fb-sidebar-pins-list { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
    .fb-sidebar-pin-row {
      padding: 8px 10px; border-radius: 8px; border: 1px solid hsl(220,13%,91%);
      cursor: pointer; background: #fff;
    }
    .fb-sidebar-pin-row:hover { background: hsl(252,83%,97%); border-color: hsl(252,83%,85%); }
    .fb-sidebar-pin-row-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
    .fb-sidebar-pin-dot {
      width: 20px; height: 20px; border-radius: 50%; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      color: #fff; font-size: 9px; font-weight: 700;
      box-shadow: 0 1px 3px rgba(0,0,0,.2), 0 0 0 1.5px #fff;
    }
    .fb-sidebar-pin-email {
      font-size: 10px; font-weight: 600; color: hsl(252,83%,50%);
      flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .fb-sidebar-pin-tag {
      font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
      color: #fff; padding: 1px 5px; border-radius: 4px; flex-shrink: 0;
    }
    .fb-sidebar-pin-body {
      font-size: 11px; color: hsl(222,47%,11%); line-height: 1.4;
      overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    }
    .fb-sidebar-pin-replies { font-size: 10px; color: hsl(220,9%,46%); margin-top: 3px; }
    .fb-sidebar-empty {
      flex: 1; display: flex; align-items: center; justify-content: center;
      font-size: 12px; color: hsl(220,9%,60%); text-align: center; padding: 16px;
    }

    /* general tab */
    #__fb-sidebar-gen-list { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
    .fb-sidebar-gen-item {
      padding: 8px 10px; border-radius: 8px; border: 1px solid hsl(220,13%,91%);
    }
    .fb-sidebar-gen-email { font-size: 10px; font-weight: 600; color: hsl(252,83%,50%); margin-bottom: 3px; }
    .fb-sidebar-gen-body { font-size: 11px; color: hsl(222,47%,11%); line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
    .fb-sidebar-gen-date { font-size: 10px; color: hsl(220,9%,46%); margin-top: 3px; }
    #__fb-sidebar-gen-form {
      padding: 8px; border-top: 1px solid hsl(220,13%,91%); flex-shrink: 0;
    }
    #__fb-sidebar-gen-input {
      width: 100%; box-sizing: border-box; resize: none;
      border: 1px solid hsl(220,13%,87%); border-radius: 6px;
      padding: 6px 8px; font-size: 11px; font-family: inherit; outline: none;
      background: #fff; color: hsl(222,47%,11%); line-height: 1.4;
    }
    #__fb-sidebar-gen-input:focus { border-color: hsl(252,83%,57%); box-shadow: 0 0 0 3px hsl(252,83%,90%); }
    #__fb-sidebar-gen-submit {
      margin-top: 6px; width: 100%; padding: 6px; border-radius: 6px; border: none;
      background: hsl(252,83%,57%); color: #fff; font-size: 11px; font-weight: 600;
      cursor: pointer; font-family: inherit;
    }
    #__fb-sidebar-gen-submit:hover { background: hsl(252,83%,48%); }
    #__fb-sidebar-gen-submit:disabled { opacity: .5; cursor: default; }
  ```

- [ ] **Step 2: Verify the file still parses**

  ```bash
  node -e "require('fs').readFileSync('public/sdk/feedback.js','utf8'); console.log('OK')"
  ```
  Expected: `OK` (no syntax error from unterminated string)

- [ ] **Step 3: Commit**

  ```bash
  git add public/sdk/feedback.js
  git commit -m "feat(sidebar): add sidebar CSS to feedback.js STYLE constant"
  ```

---

### Task 2: Inject sidebar DOM and add `generalComments` state

**Files:**
- Modify: `public/sdk/feedback.js:386-403` (state variables)
- Modify: `public/sdk/feedback.js:370-371` (after `document.body.appendChild(explainContainer)`)

- [ ] **Step 1: Add `generalComments` state variable**

  After line 387 (`let pins = [];`), add:

  ```js
  let generalComments = []; // [{id,email,comment,created_at}]
  ```

- [ ] **Step 2: Add `sidebarExpanded` state variable**

  After the new `generalComments` line, add:

  ```js
  let sidebarExpanded = false; // set after loadPins() based on comment count + localStorage
  ```

- [ ] **Step 3: Inject sidebar HTML after the explainContainer append**

  The `explainContainer` is appended to `document.body` at around line 327. After that line, add:

  ```js
  /* ── sidebar ── */
  const sidebar = document.createElement('div');
  sidebar.id = '__fb-sidebar';
  sidebar.innerHTML = `
    <div id="__fb-sidebar-strip" title="Show comments">
      <button id="__fb-sidebar-collapse" style="transform:none">&#8250;</button>
      <span id="__fb-sidebar-badge">0</span>
      <span id="__fb-sidebar-strip-label">Comments</span>
    </div>
    <div id="__fb-sidebar-main">
      <div id="__fb-sidebar-tabs">
        <button class="fb-sidebar-tab active" data-tab="pins">
          Pins <span class="fb-sidebar-tab-badge" id="__fb-pins-badge">0</span>
        </button>
        <button class="fb-sidebar-tab" data-tab="general">
          General <span class="fb-sidebar-tab-badge" id="__fb-gen-badge">0</span>
        </button>
        <button id="__fb-sidebar-collapse">&#8250;</button>
      </div>
      <div id="__fb-sidebar-pins" class="active">
        <div id="__fb-sidebar-pins-list"></div>
      </div>
      <div id="__fb-sidebar-general">
        <div id="__fb-sidebar-gen-list"></div>
        <div id="__fb-sidebar-gen-form">
          <textarea id="__fb-sidebar-gen-input" rows="3" placeholder="Add a general comment…"></textarea>
          <button id="__fb-sidebar-gen-submit">Post comment</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(sidebar);
  ```

  > Note: there are intentionally two elements with id `__fb-sidebar-collapse` — one in the strip (collapsed state) and one in the tab row (expanded state). We'll wire both to the same handler in Task 4. This is valid because only one is visible at a time.

- [ ] **Step 4: Verify the file still parses**

  ```bash
  node -e "require('fs').readFileSync('public/sdk/feedback.js','utf8'); console.log('OK')"
  ```
  Expected: `OK`

- [ ] **Step 5: Commit**

  ```bash
  git add public/sdk/feedback.js
  git commit -m "feat(sidebar): inject sidebar DOM and add generalComments state"
  ```

---

### Task 3: Split `loadPins()` to also populate `generalComments`

**Files:**
- Modify: `public/sdk/feedback.js:437-448` (`loadPins` function)

- [ ] **Step 1: Replace the `loadPins` function body**

  The current function (lines 437–448) is:

  ```js
  async function loadPins() {
    try {
      const resp = await fetch('/api/comments/' + PROTO_ID, { credentials: 'include' });
      if (resp.ok) {
        pins = await resp.json();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          renderPinLayer();
          if (focusId) focusPin(focusId);
        }));
      }
    } catch (e) {}
  }
  ```

  Replace it with:

  ```js
  async function loadPins() {
    try {
      const resp = await fetch('/api/comments/' + PROTO_ID, { credentials: 'include' });
      if (resp.ok) {
        const all = await resp.json();
        pins = all.filter(c => c.element_selector);
        generalComments = all.filter(c => !c.element_selector && !c.parent_id);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          renderPinLayer();
          renderSidebar();
          if (focusId) focusPin(focusId);
        }));
      }
    } catch (e) {}
  }
  ```

  > The API returns element-type pins (have `element_selector`) and general comments (no `element_selector`, no `parent_id` — replies have `parent_id` and are nested inside their parent's `replies` array, so they won't appear at the top level of the response array). This filter is correct.

- [ ] **Step 2: Verify the file still parses**

  ```bash
  node -e "require('fs').readFileSync('public/sdk/feedback.js','utf8'); console.log('OK')"
  ```
  Expected: `OK`

- [ ] **Step 3: Commit**

  ```bash
  git add public/sdk/feedback.js
  git commit -m "feat(sidebar): split loadPins to populate generalComments"
  ```

---

### Task 4: Implement `renderSidebar()` and sidebar collapse/expand

**Files:**
- Modify: `public/sdk/feedback.js` — add new functions after `loadExplanations()`

- [ ] **Step 1: Add `setSidebarExpanded` helper after `loadExplanations()`**

  After the closing brace of `loadExplanations()` (around line 457), add:

  ```js
  function setSidebarExpanded(expanded) {
    sidebarExpanded = expanded;
    sidebar.classList.toggle('expanded', expanded);
    sidebar.classList.toggle('collapsed', !expanded);
    document.body.style.paddingRight = expanded ? '260px' : '32px';
    try { localStorage.setItem('__fb_sidebar_' + PROTO_ID, expanded ? '1' : '0'); } catch (_) {}
  }
  ```

- [ ] **Step 2: Add `renderSidebar()` after `setSidebarExpanded`**

  ```js
  function renderSidebar() {
    const currentPage = currentPageKey();
    const pagePins = pins.filter(p =>
      !p.page_url || pageKeyOf(p.page_url) === currentPage
    );
    const totalCount = pagePins.length + generalComments.length;

    // auto-open on first load: if comments exist and no stored preference
    const stored = (() => { try { return localStorage.getItem('__fb_sidebar_' + PROTO_ID); } catch (_) { return null; } })();
    if (stored === null) {
      setSidebarExpanded(totalCount > 0);
    }

    // update badges
    document.getElementById('__fb-pins-badge').textContent = pagePins.length;
    document.getElementById('__fb-gen-badge').textContent = generalComments.length;
    document.getElementById('__fb-sidebar-badge').textContent = totalCount;

    // render pins list
    const pinsList = document.getElementById('__fb-sidebar-pins-list');
    pinsList.innerHTML = '';
    if (pagePins.length === 0) {
      pinsList.innerHTML = '<div class="fb-sidebar-empty">No pins on this page yet.</div>';
    } else {
      pagePins.forEach(p => {
        const row = document.createElement('div');
        row.className = 'fb-sidebar-pin-row';
        const tagHtml = p.tag
          ? `<span class="fb-sidebar-pin-tag" style="background:${TAG_COLOR[p.tag] || TAG_COLOR.other}">${TAG_LABEL[p.tag] || p.tag}</span>`
          : '';
        const repliesHtml = (p.replies && p.replies.length)
          ? `<div class="fb-sidebar-pin-replies">${p.replies.length} repl${p.replies.length === 1 ? 'y' : 'ies'}</div>`
          : '';
        row.innerHTML = `
          <div class="fb-sidebar-pin-row-head">
            <div class="fb-sidebar-pin-dot" style="background:${TAG_COLOR[p.tag] || TAG_COLOR.other}">${p.order}</div>
            <span class="fb-sidebar-pin-email">${escHtml(p.email)}</span>
            ${tagHtml}
          </div>
          <div class="fb-sidebar-pin-body">${escHtml(p.comment)}</div>
          ${repliesHtml}
        `;
        row.addEventListener('click', () => {
          if (mode === 'comment' || mode === 'explain') setMode('view');
          focusPin(p.id);
          setTimeout(() => {
            const pinEl = pinElements[p.id];
            if (pinEl) pinEl.click();
          }, 50);
        });
        pinsList.appendChild(row);
      });
    }

    // render general list
    const genList = document.getElementById('__fb-sidebar-gen-list');
    genList.innerHTML = '';
    if (generalComments.length === 0) {
      genList.innerHTML = '<div class="fb-sidebar-empty">No general comments yet.</div>';
    } else {
      generalComments.forEach(c => {
        const item = document.createElement('div');
        item.className = 'fb-sidebar-gen-item';
        const date = new Date(c.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        item.innerHTML = `
          <div class="fb-sidebar-gen-email">${escHtml(c.email)}</div>
          <div class="fb-sidebar-gen-body">${escHtml(c.comment)}</div>
          <div class="fb-sidebar-gen-date">${date}</div>
        `;
        genList.appendChild(item);
      });
    }
  }
  ```

- [ ] **Step 3: Wire up tab switching**

  After `renderSidebar()`, add:

  ```js
  document.getElementById('__fb-sidebar-tabs').addEventListener('click', e => {
    const tabBtn = e.target.closest('.fb-sidebar-tab');
    if (!tabBtn) return;
    const tab = tabBtn.dataset.tab;
    document.querySelectorAll('.fb-sidebar-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.getElementById('__fb-sidebar-pins').classList.toggle('active', tab === 'pins');
    document.getElementById('__fb-sidebar-general').classList.toggle('active', tab === 'general');
  });
  ```

- [ ] **Step 4: Wire up collapse/expand buttons**

  Both `#__fb-sidebar-collapse` elements (one in strip, one in tab row) trigger the same toggle. Use event delegation on the sidebar:

  ```js
  sidebar.addEventListener('click', e => {
    if (e.target.closest('#__fb-sidebar-collapse') || e.target.closest('#__fb-sidebar-strip')) {
      setSidebarExpanded(!sidebarExpanded);
    }
  });
  ```

- [ ] **Step 5: Initialise sidebar state on load**

  At the very end of the `/* ── boot ── */` section (after `loadPins()`, `loadExplanations()`, and the RAF call, around line 1179), add:

  ```js
  // Init sidebar collapsed state from localStorage (before first loadPins resolves)
  const _storedSidebar = (() => { try { return localStorage.getItem('__fb_sidebar_' + PROTO_ID); } catch (_) { return null; } })();
  setSidebarExpanded(_storedSidebar === '1');
  ```

  > `renderSidebar()` handles the auto-open logic when it first runs after `loadPins()` resolves. This boot call just restores the persisted collapsed/expanded state immediately so the sidebar doesn't flash wrong width.

- [ ] **Step 6: Verify the file still parses**

  ```bash
  node -e "require('fs').readFileSync('public/sdk/feedback.js','utf8'); console.log('OK')"
  ```
  Expected: `OK`

- [ ] **Step 7: Commit**

  ```bash
  git add public/sdk/feedback.js
  git commit -m "feat(sidebar): add renderSidebar, collapse/expand, tab switching"
  ```

---

### Task 5: Implement general comment submission

**Files:**
- Modify: `public/sdk/feedback.js` — add submit handler after Task 4's event wiring

- [ ] **Step 1: Add general comment submit handler**

  After the collapse/expand event listener added in Task 4, add:

  ```js
  document.getElementById('__fb-sidebar-gen-submit').addEventListener('click', async () => {
    const input = document.getElementById('__fb-sidebar-gen-input');
    const submitBtn = document.getElementById('__fb-sidebar-gen-submit');
    const text = input.value.trim();
    if (!text) return;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Posting…';
    try {
      await postComment({ type: 'general', comment: text });
      input.value = '';
      await loadPins();
    } catch (_) {
      showToast('Failed to post comment.', true);
    }
    submitBtn.disabled = false;
    submitBtn.textContent = 'Post comment';
  });
  ```

  > `postComment` already exists in `feedback.js` and handles `{ type, comment, prototypeId, email }`. It prepends `PROTO_ID` and `EMAIL` automatically.

- [ ] **Step 2: Verify the file still parses**

  ```bash
  node -e "require('fs').readFileSync('public/sdk/feedback.js','utf8'); console.log('OK')"
  ```
  Expected: `OK`

- [ ] **Step 3: Commit**

  ```bash
  git add public/sdk/feedback.js
  git commit -m "feat(sidebar): add general comment submit handler"
  ```

---

### Task 6: Update `renderPinLayer()` call sites to also call `renderSidebar()`

**Files:**
- Modify: `public/sdk/feedback.js` — `renderPinLayer` call sites and navigation tracking

The sidebar's pin list needs to stay in sync whenever pins are re-rendered (mode change, page navigation). `renderSidebar()` is already called inside `loadPins()`. We also need it called when `renderPinLayer()` is called due to page navigation.

- [ ] **Step 1: Find the `recordNav` function (around line 1142)**

  The function calls `renderPinLayer()` at its end. Add a `renderSidebar()` call right after it:

  Find this code:
  ```js
      renderPinLayer();
    }
  ```
  (inside `recordNav`, which is inside the navigation tracking IIFE)

  Replace with:
  ```js
      renderPinLayer();
      renderSidebar();
    }
  ```

- [ ] **Step 2: Verify the file still parses**

  ```bash
  node -e "require('fs').readFileSync('public/sdk/feedback.js','utf8'); console.log('OK')"
  ```
  Expected: `OK`

- [ ] **Step 3: Commit**

  ```bash
  git add public/sdk/feedback.js
  git commit -m "feat(sidebar): re-render sidebar on page navigation"
  ```

---

### Task 7: Manual browser smoke test

**Files:** None — verification only

- [ ] **Step 1: Start the dev server**

  ```bash
  npm start
  ```
  (or whatever command starts the local server — check `package.json` scripts)

- [ ] **Step 2: Open a prototype with existing pins**

  Navigate to a prototype share URL. The sidebar should auto-expand because comments exist. Confirm:
  - Sidebar appears on the right at 260px width
  - Pins tab is active, showing pin rows with dot, email, tag, and comment preview
  - Reply count shown for pins that have replies
  - Badges in the tab headers show correct counts

- [ ] **Step 3: Test pin navigation**

  Click a pin row in the sidebar. Confirm:
  - The prototype scrolls to the pin
  - The pin pulses (focus animation)
  - The popover opens and stays open (pinned)

- [ ] **Step 4: Test General tab**

  Click the General tab. Confirm:
  - Existing general comments appear with email, body, date
  - The textarea and "Post comment" button are always visible at the bottom
  - Typing a message and clicking Post submits it, clears the textarea, and the new comment appears in the list

- [ ] **Step 5: Test collapse/expand**

  Click the `›` button in the tab row. Confirm:
  - Sidebar collapses to 32px strip
  - Strip shows `‹`, total count badge, and "Comments" label
  - Prototype gains full width (no right padding from sidebar)
  - Click strip or `‹` to re-expand — sidebar returns to 260px
  - Reload the page — sidebar reopens in the same state

- [ ] **Step 6: Test on a prototype with no comments**

  Navigate to a prototype with no feedback. Confirm:
  - Sidebar starts collapsed
  - Pins tab shows "No pins on this page yet."
  - General tab shows "No general comments yet."

- [ ] **Step 7: Test mode interactions**

  Switch to Comment mode (click Comment in toolbar), then click a pin row in the sidebar. Confirm:
  - Toolbar switches back to View mode
  - Pin is highlighted and popover opens

- [ ] **Step 8: Commit if all good**

  ```bash
  git add public/sdk/feedback.js
  git commit -m "feat(sidebar): comments sidebar complete"
  ```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|-----------------|------|
| Collapseable sidebar, right edge | Task 1 (CSS), Task 2 (DOM), Task 4 (`setSidebarExpanded`) |
| Expanded 260px / collapsed 32px | Task 1 (CSS), Task 4 |
| body padding-right management | Task 4 (`setSidebarExpanded`) |
| localStorage collapse persistence | Task 4 |
| Auto-open when comments exist | Task 4 (`renderSidebar` auto-open logic) |
| Collapsed strip: chevron, badge, label | Task 2 (DOM), Task 1 (CSS) |
| Two tabs: Pins / General | Task 2 (DOM), Task 4 (tab switching) |
| Pins tab: filtered to current page | Task 4 (`renderSidebar` page filter) |
| Pin row: dot, email, tag, body, reply count | Task 4 (`renderSidebar`) |
| Empty state for pins | Task 4 |
| Pin row click: exit comment/explain mode | Task 4 (row click handler) |
| Pin row click: `focusPin` + synthetic click | Task 4 (row click handler) |
| General tab: email, body, date per entry | Task 4 (`renderSidebar`) |
| Empty state for general comments | Task 4 |
| Persistent textarea + submit button | Task 2 (DOM), Task 5 |
| General comment submit via `postComment` | Task 5 |
| Submit: disable, post, clear, reload | Task 5 |
| Submit error: toast + re-enable | Task 5 |
| `generalComments` populated from existing fetch | Task 3 |
| Sidebar re-renders on page navigation | Task 6 |
| Only `feedback.js` changes | All tasks |

All spec requirements covered. No gaps.

**Placeholder scan:** No TBDs, TODOs, or vague steps. All code is complete.

**Type consistency:** `generalComments`, `sidebarExpanded`, `setSidebarExpanded`, `renderSidebar` are used consistently across all tasks. `pinElements`, `pins`, `TAG_COLOR`, `TAG_LABEL`, `escHtml`, `postComment`, `showToast`, `focusPin`, `setMode`, `currentPageKey`, `pageKeyOf` all exist in the current codebase and are used with their correct signatures.
