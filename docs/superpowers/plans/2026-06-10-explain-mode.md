# Explain Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Explain" mode to the ProtoLab viewer that lets any user hover prototype elements to read free-form explanations (user stories, Gherkin, notes) attached by admins.

**Architecture:** Four independent tasks in dependency order: DB schema → API routes → SDK viewer → Admin UI. The SDK loads explanations on boot via a new `/api/explanations/:protoId` endpoint and renders amber `ℹ` markers; clicking any element in Explain mode opens an edit card. The admin detail page gets a new Explanations tab for bulk management.

**Tech Stack:** Node.js/Express 4, better-sqlite3 (SQLite), vanilla JS (no bundler), nanoid for IDs.

---

## File Map

| File | What changes |
|------|-------------|
| `src/db.js` | Create `explanations` table + unique index on startup |
| `src/routes/api.js` | Add GET / POST / PATCH / DELETE `/api/explanations` routes |
| `public/sdk/feedback.js` | Add Explain mode button, `loadExplanations()`, `renderExplainLayer()`, hover popover, edit card |
| `src/views/admin-prototype-detail.html` | Add Explanations tab (table + inline edit + delete via existing modal) |

---

## Task 1: DB Schema — `explanations` table

**Files:**
- Modify: `src/db.js`

### Context

`src/db.js` runs `_db.exec(...)` with a single SQL string to create all tables on startup (lines 14–65). After that block there are column-migration guards using `_db.pragma('table_info(...)')`. Follow the same pattern.

The unique constraint must use a functional index (`COALESCE(page_url, '')`) rather than a table-level `UNIQUE` because SQLite treats two `NULL` values as distinct in a `UNIQUE` constraint, which would allow duplicate rows for single-page prototypes.

- [ ] **Step 1: Add table creation to the `_db.exec` block**

In `src/db.js`, inside the template literal passed to `_db.exec(...)`, after the `nav_events` table and its index (around line 63), add:

```sql

    CREATE TABLE IF NOT EXISTS explanations (
      id               TEXT PRIMARY KEY,
      prototype_id     TEXT NOT NULL,
      element_selector TEXT NOT NULL,
      x_pct            REAL,
      y_pct            REAL,
      page_url         TEXT,
      body             TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      FOREIGN KEY (prototype_id) REFERENCES prototypes(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_explanations_unique
      ON explanations(prototype_id, element_selector, COALESCE(page_url, ''));
```

- [ ] **Step 2: Verify the server starts without error**

```bash
cd /Users/i525473/ClaudeCode/proto-share
node src/server.js &
sleep 1
curl -s http://localhost:3000/admin/login | grep -c 'ProtoLab'
kill %1
```

Expected output: `1` (the page loads, meaning the DB initialised without crashing).

- [ ] **Step 3: Commit**

```bash
git add src/db.js
git commit -m "feat: add explanations table to SQLite schema"
```

---

## Task 2: API Routes — `/api/explanations`

**Files:**
- Modify: `src/routes/api.js`

### Context

`src/routes/api.js` already has comment CRUD routes following the same pattern. Add explanation routes at the bottom, before `module.exports`. Use `nanoid(12)` for IDs (already imported). Use `getDb()` (already imported). The `customerAuth` middleware is NOT applied here — the existing comment routes have no auth middleware at the router level either; the session is validated by `delivery.js` before the prototype is served, so the cookie is always present for legitimate viewers.

- [ ] **Step 1: Add GET route**

At the bottom of `src/routes/api.js`, before `module.exports = router;`, add:

```js
router.get('/explanations/:prototypeId', (req, res) => {
  const rows = getDb().prepare(
    `SELECT id, element_selector, x_pct, y_pct, page_url, body, created_at, updated_at
     FROM explanations
     WHERE prototype_id = ?
     ORDER BY created_at ASC`
  ).all(req.params.prototypeId);
  res.json(rows);
});
```

- [ ] **Step 2: Add POST route**

```js
router.post('/explanations', (req, res) => {
  const { prototypeId, elementSelector, xPct, yPct, pageUrl, body } = req.body;
  if (!prototypeId || !elementSelector || !body || !body.trim()) {
    return res.status(400).json({ error: 'prototypeId, elementSelector, and body are required.' });
  }
  const id = nanoid(12);
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO explanations (id, prototype_id, element_selector, x_pct, y_pct, page_url, body, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, prototypeId, elementSelector,
    typeof xPct === 'number' ? xPct : null,
    typeof yPct === 'number' ? yPct : null,
    pageUrl || null,
    body.trim(),
    now, now
  );
  res.status(201).json({ ok: true, id });
});
```

- [ ] **Step 3: Add PATCH route**

```js
router.patch('/explanations/:id', (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'body is required.' });
  const row = getDb().prepare('SELECT id FROM explanations WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  getDb().prepare('UPDATE explanations SET body = ?, updated_at = ? WHERE id = ?')
    .run(body.trim(), new Date().toISOString(), req.params.id);
  res.json({ ok: true });
});
```

- [ ] **Step 4: Add DELETE route**

```js
router.delete('/explanations/:id', (req, res) => {
  const row = getDb().prepare('SELECT id FROM explanations WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  getDb().prepare('DELETE FROM explanations WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
```

- [ ] **Step 5: Smoke-test the API**

```bash
cd /Users/i525473/ClaudeCode/proto-share
node src/server.js &
sleep 1

# Create a test explanation (replace PROTO_ID with any real id from your DB, or use a fake one)
curl -s -X POST http://localhost:3000/api/explanations \
  -H 'Content-Type: application/json' \
  -d '{"prototypeId":"test123","elementSelector":"#btn","xPct":0.5,"yPct":0.5,"pageUrl":"/","body":"Test explanation"}' | grep '"ok":true'

# List it back
curl -s http://localhost:3000/api/explanations/test123 | grep '"#btn"'

kill %1
```

Expected: first command prints a line containing `"ok":true`, second prints a line containing `"#btn"`.

- [ ] **Step 6: Commit**

```bash
git add src/routes/api.js
git commit -m "feat: add /api/explanations CRUD endpoints"
```

---

## Task 3: SDK — Explain Mode in `feedback.js`

**Files:**
- Modify: `public/sdk/feedback.js`

### Context

`feedback.js` is a large self-executing IIFE. Key landmarks:

- **Line 8–16**: constants (`TAGS`, `TAG_COLOR`, etc.)
- **Line 22–173**: `STYLE` string — all CSS injected via `<style>`
- **Line 186–201**: toolbar HTML with the three mode buttons
- **Line 252–265**: state variables (`mode`, `pins`, etc.)
- **Line 269–278**: `setMode(m)` function
- **Line 293–303**: `loadPins()` function
- **Line 324–370**: `recomputePositions()` RAF loop
- **Line 399–447**: `renderPinLayer()` — hides pins in review mode, renders pins otherwise
- **Line 759–763**: boot section — calls `loadPins()` and starts RAF

The plan uses exact code blocks. Make each change in order and verify the server still starts between steps.

---

### Step group A: CSS additions

- [ ] **Step 1: Add Explain mode CSS to the STYLE string**

Inside the `const STYLE = \`` ... `\`` string, after the `/* toast */` block (after line ~172, just before the closing backtick), add:

```css
    /* ── explain mode ── */
    #__fb-explain-banner {
      position: fixed; top: 44px; left: 0; right: 0; z-index: 2147483646;
      background: hsl(38,92%,50%); color: #fff; text-align: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px; padding: 6px; pointer-events: none; display: none;
    }
    body.__fb-explain-mode #__fb-explain-banner { display: block; }

    #__fb-explains {
      position: fixed; top: 0; left: 0; width: 0; height: 0;
      pointer-events: none; z-index: 2147483638;
    }
    .fb-explain-marker {
      position: absolute; width: 18px; height: 18px; border-radius: 50%;
      background: hsl(38,92%,50%); color: #fff;
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 700; font-family: serif;
      box-shadow: 0 1px 4px rgba(0,0,0,.25), 0 0 0 2px #fff;
      cursor: pointer; pointer-events: auto;
      transform: translate(-50%, -50%);
    }
    .fb-explain-marker:hover { transform: translate(-50%,-50%) scale(1.15); }

    .fb-explain-popover {
      position: absolute; left: calc(100% + 8px); top: -4px;
      width: 260px; background: #fff;
      border: 1px solid hsl(220,13%,91%); border-radius: 12px;
      overflow: hidden;
      font-size: 12px; line-height: 1.5;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 4px 16px rgba(0,0,0,.12);
      pointer-events: auto; z-index: 10;
    }
    .fb-explain-popover__head {
      display: flex; align-items: center; gap: 6px;
      background: hsl(38,92%,50%); color: #fff;
      padding: 6px 10px; font-size: 11px; font-weight: 700;
    }
    .fb-explain-popover__body {
      padding: 10px; color: hsl(222,47%,11%);
      white-space: pre-wrap; word-break: break-word;
    }

    #__fb-explain-card {
      position: fixed; right: 16px; top: 60px; width: 296px;
      background: #fff; border: 1px solid hsl(220,13%,91%); border-radius: 12px;
      padding: 16px; box-shadow: 0 8px 24px rgba(0,0,0,.12);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px; z-index: 2147483645; display: none;
    }
    #__fb-explain-card.visible { display: block; }
    .fb-explain-card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .fb-explain-card-title { font-weight: 600; font-size: 13px; color: hsl(222,47%,11%); }
    .fb-explain-card-close { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: none; border-radius: 6px; cursor: pointer; background: none; color: hsl(220,9%,46%); }
    .fb-explain-card-close:hover { background: hsl(220,14%,93%); }
    #__fb-explain-selector { font-size: 11px; color: hsl(220,9%,46%); margin-bottom: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #__fb-explain-textarea {
      width: 100%; resize: vertical; border: 1px solid hsl(220,13%,87%); border-radius: 8px;
      padding: 8px 10px; font-size: 13px; font-family: inherit; outline: none;
      background: #fff; color: hsl(222,47%,11%); line-height: 1.5; min-height: 80px;
    }
    #__fb-explain-textarea:focus { border-color: hsl(38,92%,50%); box-shadow: 0 0 0 3px hsl(38,92%,85%); }
    .fb-explain-foot { margin-top: 10px; display: flex; gap: 6px; justify-content: flex-end; }
    #__fb-explain-delete { background: none; border: 1px solid #e0c0bd; color: #c0392b; border-radius: 6px; padding: 5px 10px; font-size: 12px; font-weight: 600; cursor: pointer; margin-right: auto; }
    #__fb-explain-delete:hover { background: #fdf2f2; }
```

- [ ] **Step 2: Add active-explain button style to the existing CSS**

In the same `STYLE` string, find the line:

```css
    .fb-mode-btn.active-review  { background: #fff; color: hsl(222,47%,11%); box-shadow: 0 1px 3px rgba(0,0,0,.08); }
```

Add immediately after it:

```css
    .fb-mode-btn.active-explain { background: hsl(38,92%,50%); color: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
```

---

### Step group B: Toolbar HTML

- [ ] **Step 3: Add the Explain button to the toolbar HTML**

Find the toolbar `innerHTML` assignment (around line 186). It currently ends with:

```html
      <button class="fb-mode-btn" data-mode="review">
        <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
        Review
      </button>
    </div>
  `;
```

Replace that closing section with:

```html
      <button class="fb-mode-btn" data-mode="review">
        <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
        Review
      </button>
      <button class="fb-mode-btn" data-mode="explain">
        <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        Explain
      </button>
    </div>
  `;
```

- [ ] **Step 4: Insert the Explain banner DOM element**

Find this block (around line 204–207):

```js
  const commentBanner = document.createElement('div');
  commentBanner.id = '__fb-comment-banner';
  commentBanner.textContent = 'Click any element to leave a comment · Esc to exit';
  document.body.insertBefore(commentBanner, toolbar.nextSibling);
```

Add immediately after it:

```js
  const explainBanner = document.createElement('div');
  explainBanner.id = '__fb-explain-banner';
  explainBanner.textContent = 'Hover any element to see its explanation · Click to add or edit · Esc to exit';
  document.body.insertBefore(explainBanner, commentBanner.nextSibling);
```

- [ ] **Step 5: Insert the explain marker layer and edit card DOM elements**

Find this block (around line 209–211):

```js
  /* ── pin layer ── */
  const pinContainer = document.createElement('div');
  pinContainer.id = '__fb-pins';
  document.body.appendChild(pinContainer);
```

Add immediately after it:

```js
  /* ── explain layer ── */
  const explainContainer = document.createElement('div');
  explainContainer.id = '__fb-explains';
  document.body.appendChild(explainContainer);
```

Then find the draft card block (around line 214) and, after `document.body.appendChild(draftCard);`, add:

```js
  /* ── explain edit card ── */
  const explainCard = document.createElement('div');
  explainCard.id = '__fb-explain-card';
  explainCard.innerHTML = `
    <div class="fb-explain-card-header">
      <span class="fb-explain-card-title" id="__fb-explain-card-title">Add explanation</span>
      <button class="fb-explain-card-close" id="__fb-explain-close">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div id="__fb-explain-selector"></div>
    <textarea id="__fb-explain-textarea" rows="5" placeholder="Describe this element: user story, Gherkin, notes…"></textarea>
    <div class="fb-explain-foot">
      <button id="__fb-explain-delete" style="display:none">Delete</button>
      <button class="fb-btn-sm fb-btn-ghost" id="__fb-explain-cancel">Cancel</button>
      <button class="fb-btn-sm fb-btn-primary" id="__fb-explain-save" disabled>Save</button>
    </div>
  `;
  document.body.appendChild(explainCard);
```

---

### Step group C: State and mode switching

- [ ] **Step 6: Add explanation state variables**

Find the state block (around line 252–265):

```js
  /* ── state ── */
  let mode = 'view';
  let pins = [];
  ...
```

After `let navHistory = [];` add:

```js
  let explanations = [];    // [{id,element_selector,x_pct,y_pct,page_url,body}]
  let explainMarkerEls = {}; // {id: domElement}
  let explainDraft = null;   // {selector, xPct, yPct, existingId|null}
```

- [ ] **Step 7: Update `setMode` to handle explain mode**

Find the `setMode` function:

```js
  function setMode(m) {
    mode = m;
    document.querySelectorAll('.fb-mode-btn').forEach(btn => {
      const bm = btn.dataset.mode;
      btn.className = 'fb-mode-btn' + (bm === m ? ` active-${m}` : '');
    });
    document.body.classList.toggle('__fb-comment-mode', m === 'comment');
    if (m !== 'comment') closeDraft();
    renderPinLayer();
  }
```

Replace it with:

```js
  function setMode(m) {
    mode = m;
    document.querySelectorAll('.fb-mode-btn').forEach(btn => {
      const bm = btn.dataset.mode;
      btn.className = 'fb-mode-btn' + (bm === m ? ` active-${m}` : '');
    });
    document.body.classList.toggle('__fb-comment-mode', m === 'comment');
    document.body.classList.toggle('__fb-explain-mode', m === 'explain');
    if (m !== 'comment') closeDraft();
    if (m !== 'explain') closeExplainCard();
    renderPinLayer();
    renderExplainLayer();
  }
```

---

### Step group D: Load and render explanations

- [ ] **Step 8: Add `loadExplanations()` function**

Find `loadPins()` (around line 293). Add this function immediately after `loadPins()`:

```js
  async function loadExplanations() {
    try {
      const resp = await fetch('/api/explanations/' + PROTO_ID, { credentials: 'include' });
      if (resp.ok) {
        explanations = await resp.json();
        renderExplainLayer();
      }
    } catch (e) {}
  }
```

- [ ] **Step 9: Add `renderExplainLayer()` function**

Add immediately after `loadExplanations()`:

```js
  function renderExplainLayer() {
    explainContainer.innerHTML = '';
    explainMarkerEls = {};
    if (mode !== 'explain') return;

    explanations.forEach(ex => {
      if (ex.page_url && pageKeyOf(ex.page_url) !== currentPageKey()) return;
      let el;
      try { el = document.querySelector(ex.element_selector); } catch (_) { return; }
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;

      // Marker at top-right corner
      const mx = r.right;
      const my = r.top;

      const marker = document.createElement('div');
      marker.className = 'fb-explain-marker';
      marker.style.cssText = `left:${mx}px;top:${my}px`;
      marker.textContent = 'ℹ';

      let popoverEl = null;

      const showPopover = () => {
        if (popoverEl) return;
        popoverEl = document.createElement('div');
        popoverEl.className = 'fb-explain-popover';
        popoverEl.innerHTML = `
          <div class="fb-explain-popover__head">
            <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            Explanation
          </div>
          <div class="fb-explain-popover__body">${escHtml(ex.body)}</div>
        `;
        popoverEl.addEventListener('mouseleave', e => {
          if (e.relatedTarget && marker.contains(e.relatedTarget)) return;
          hidePopover();
        });
        marker.appendChild(popoverEl);
      };

      const hidePopover = () => {
        if (popoverEl) { popoverEl.remove(); popoverEl = null; }
      };

      marker.addEventListener('mouseenter', showPopover);
      marker.addEventListener('mouseleave', e => {
        if (e.relatedTarget && (marker.contains(e.relatedTarget) || (popoverEl && popoverEl.contains(e.relatedTarget)))) return;
        hidePopover();
      });

      explainContainer.appendChild(marker);
      explainMarkerEls[ex.id] = marker;
    });
  }
```

- [ ] **Step 10: Hook `renderExplainLayer` into the RAF loop**

In `recomputePositions()`, at the end of the function body (just before `rafId = requestAnimationFrame(recomputePositions);`), add:

```js
    if (mode === 'explain') renderExplainLayer();
```

---

### Step group E: Click-to-edit in Explain mode

- [ ] **Step 11: Add `openExplainCard()` and `closeExplainCard()` functions**

Add these after `renderExplainLayer()`:

```js
  function openExplainCard(selector, xPct, yPct) {
    const existing = explanations.find(e =>
      e.element_selector === selector &&
      (e.page_url ? pageKeyOf(e.page_url) === currentPageKey() : true)
    );
    explainDraft = { selector, xPct, yPct, existingId: existing ? existing.id : null };
    document.getElementById('__fb-explain-card-title').textContent = existing ? 'Edit explanation' : 'Add explanation';
    document.getElementById('__fb-explain-selector').textContent = selector;
    document.getElementById('__fb-explain-textarea').value = existing ? existing.body : '';
    document.getElementById('__fb-explain-save').disabled = !existing;
    document.getElementById('__fb-explain-delete').style.display = existing ? '' : 'none';
    explainCard.classList.add('visible');
    document.getElementById('__fb-explain-textarea').focus();
  }

  function closeExplainCard() {
    explainDraft = null;
    explainCard.classList.remove('visible');
  }
```

- [ ] **Step 12: Wire up the explain card buttons**

Add after `closeExplainCard()`:

```js
  document.getElementById('__fb-explain-close').addEventListener('click', closeExplainCard);
  document.getElementById('__fb-explain-cancel').addEventListener('click', closeExplainCard);

  document.getElementById('__fb-explain-textarea').addEventListener('input', e => {
    document.getElementById('__fb-explain-save').disabled = !e.target.value.trim();
  });

  document.getElementById('__fb-explain-save').addEventListener('click', async () => {
    if (!explainDraft) return;
    const body = document.getElementById('__fb-explain-textarea').value.trim();
    if (!body) return;
    const saveBtn = document.getElementById('__fb-explain-save');
    saveBtn.disabled = true;
    try {
      if (explainDraft.existingId) {
        await fetch('/api/explanations/' + explainDraft.existingId, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
          credentials: 'include',
        });
        const idx = explanations.findIndex(e => e.id === explainDraft.existingId);
        if (idx !== -1) explanations[idx].body = body;
      } else {
        const resp = await fetch('/api/explanations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prototypeId: PROTO_ID,
            elementSelector: explainDraft.selector,
            xPct: explainDraft.xPct,
            yPct: explainDraft.yPct,
            pageUrl: location.href,
            body,
          }),
          credentials: 'include',
        });
        const { id } = await resp.json();
        explanations.push({
          id, element_selector: explainDraft.selector,
          x_pct: explainDraft.xPct, y_pct: explainDraft.yPct,
          page_url: location.href, body,
        });
      }
      closeExplainCard();
      showToast('Explanation saved.');
      renderExplainLayer();
    } catch (_) {
      showToast('Failed to save.', true);
      saveBtn.disabled = false;
    }
  });

  document.getElementById('__fb-explain-delete').addEventListener('click', async () => {
    if (!explainDraft?.existingId) return;
    try {
      await fetch('/api/explanations/' + explainDraft.existingId, {
        method: 'DELETE', credentials: 'include',
      });
      explanations = explanations.filter(e => e.id !== explainDraft.existingId);
      closeExplainCard();
      showToast('Explanation deleted.');
      renderExplainLayer();
    } catch (_) {
      showToast('Failed to delete.', true);
    }
  });
```

- [ ] **Step 13: Add click handler for Explain mode element clicks**

In `feedback.js`, find the comment-mode click handler block (around line 563–576):

```js
  /* ── comment mode click ── */
  document.addEventListener('click', e => {
    if (mode !== 'comment') return;
    ...
  }, true);
```

Add a **separate** event listener immediately after it:

```js
  /* ── explain mode click ── */
  document.addEventListener('click', e => {
    if (mode !== 'explain') return;
    if (e.target.closest('#__fb-explain-card') || e.target.closest('.fb-explain-marker') || e.target.closest('#__fb-toolbar')) return;
    e.preventDefault(); e.stopPropagation();

    const el = e.target;
    const selector = getCssSelector(el);
    const rect = el.getBoundingClientRect();
    const xPct = rect.width ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 0.5;
    const yPct = rect.height ? Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) : 0.5;

    openExplainCard(selector, xPct, yPct);
  }, true);
```

- [ ] **Step 14: Update Esc key handler to close the explain card**

Find the existing keydown handler:

```js
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (unpinActive) { unpinActive(); unpinActive = null; return; }
      if (draft) { closeDraft(); return; }
      if (mode !== 'view') setMode('view');
    }
  });
```

Replace with:

```js
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (unpinActive) { unpinActive(); unpinActive = null; return; }
      if (draft) { closeDraft(); return; }
      if (explainDraft) { closeExplainCard(); return; }
      if (mode !== 'view') setMode('view');
    }
  });
```

---

### Step group F: Boot and hide comment pins in explain mode

- [ ] **Step 15: Call `loadExplanations()` on boot**

Find the boot section at the bottom of the file:

```js
  /* ── boot ── */
  const focusId = new URLSearchParams(location.search).get('focus') || '';

  loadPins();
  rafId = requestAnimationFrame(recomputePositions);
```

Add `loadExplanations();` after `loadPins();`:

```js
  /* ── boot ── */
  const focusId = new URLSearchParams(location.search).get('focus') || '';

  loadPins();
  loadExplanations();
  rafId = requestAnimationFrame(recomputePositions);
```

- [ ] **Step 16: Hide comment pins when in Explain mode**

In `renderPinLayer()` (around line 399), find:

```js
  function renderPinLayer() {
    pinContainer.innerHTML = '';
    pinElements = {};
    clusterElements = [];
    if (mode === 'review') return;
```

Change to:

```js
  function renderPinLayer() {
    pinContainer.innerHTML = '';
    pinElements = {};
    clusterElements = [];
    if (mode === 'review' || mode === 'explain') return;
```

- [ ] **Step 17: Commit**

```bash
git add public/sdk/feedback.js
git commit -m "feat: add Explain mode to SDK — markers, hover popover, edit card"
```

---

## Task 4: Admin Detail Page — Explanations Tab

**Files:**
- Modify: `src/views/admin-prototype-detail.html`

### Context

The admin detail page has four tabs: Comments, Access Log, Settings, Funnels. Each tab is a `<button class="tab" data-tab="...">` and a `<div class="tab-panel" id="tab-...">`. The Explanations tab follows the same pattern. The existing `showModal` / `closeModal` JS is already on the page and can be reused for delete confirmation.

Data is loaded lazily on tab activation, following the funnels tab pattern (`if (explanationsLoaded) return;`).

- [ ] **Step 1: Add the Explanations tab button**

In `admin-prototype-detail.html`, find the tabs bar (around line 99–104):

```html
  <div class="tabs">
    <button class="tab active" data-tab="comments">Comments</button>
    <button class="tab" data-tab="log">Access Log</button>
    <button class="tab" data-tab="settings">Settings</button>
    <button class="tab" data-tab="funnels">Funnels</button>
  </div>
```

Replace with:

```html
  <div class="tabs">
    <button class="tab active" data-tab="comments">Comments</button>
    <button class="tab" data-tab="log">Access Log</button>
    <button class="tab" data-tab="settings">Settings</button>
    <button class="tab" data-tab="funnels">Funnels</button>
    <button class="tab" data-tab="explanations">Explanations</button>
  </div>
```

- [ ] **Step 2: Add the Explanations tab panel HTML**

Find the closing `</div><!-- tab-body -->` (around line 238). Insert the new panel immediately before it:

```html
    <!-- Explanations tab -->
    <div class="tab-panel" id="tab-explanations">
      <div class="tbl-wrap">
        <table class="tbl" id="explanations-table">
          <thead>
            <tr>
              <th>Selector</th>
              <th>Explanation</th>
              <th>Page</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="explanations-body">
            <tr><td colspan="4" style="text-align:center;padding:40px;color:hsl(220,9%,46%)">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    </div>
```

- [ ] **Step 3: Wire up tab activation for Explanations in JS**

Find the tab-switching JS block (around line 262–270):

```js
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'funnels') loadFunnels();
  });
});
```

Replace with:

```js
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'funnels') loadFunnels();
    if (btn.dataset.tab === 'explanations') loadExplanations();
  });
});
```

- [ ] **Step 4: Add `loadExplanations()` and `renderExplanations()` JS functions**

Add these functions at the end of the `<script>` block, before the closing `</script>` tag:

```js
// Explanations tab
let explanationsLoaded = false;
let adminExplanations = [];

async function loadExplanations() {
  if (explanationsLoaded) return;
  try {
    const resp = await fetch('/api/explanations/' + PROTO_ID);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    adminExplanations = await resp.json();
    renderExplanations();
    explanationsLoaded = true;
  } catch (e) {
    document.getElementById('explanations-body').innerHTML =
      `<tr><td colspan="4" style="text-align:center;padding:40px;color:hsl(220,9%,46%)">Failed to load explanations.</td></tr>`;
  }
}

function renderExplanations() {
  const tbody = document.getElementById('explanations-body');
  if (!adminExplanations.length) {
    tbody.innerHTML = `<tr><td colspan="4">
      <div class="empty-state">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><circle cx="12" cy="12" r="10" stroke-width="1.5"/><line x1="12" y1="8" x2="12" y2="12" stroke-width="1.5"/><line x1="12" y1="16" x2="12.01" y2="16" stroke-width="1.5"/></svg>
        <p>No explanations yet. Open the prototype in Explain mode to add some.</p>
      </div>
    </td></tr>`;
    return;
  }
  tbody.innerHTML = adminExplanations.map(ex => `
    <tr id="exp-row-${ex.id}">
      <td><span class="selector" title="${esc(ex.element_selector)}">${esc(ex.element_selector)}</span></td>
      <td style="max-width:320px">${esc(ex.body.length > 80 ? ex.body.slice(0, 80) + '…' : ex.body)}</td>
      <td class="ts">${esc(ex.page_url || '—')}</td>
      <td style="white-space:nowrap;display:flex;gap:6px;align-items:center">
        <button class="btn btn-secondary" style="font-size:11px;padding:4px 8px" onclick="editExplanation('${ex.id}')">Edit</button>
        <button class="btn btn-danger" style="font-size:11px;padding:4px 8px" onclick="deleteExplanation('${ex.id}','${esc(ex.element_selector)}')">Delete</button>
      </td>
    </tr>
    <tr id="exp-edit-row-${ex.id}" style="display:none">
      <td colspan="4" style="padding:12px 16px;background:hsl(220,14%,98%)">
        <textarea class="input" id="exp-edit-ta-${ex.id}" rows="4" style="margin-bottom:8px">${esc(ex.body)}</textarea>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary" style="font-size:12px;padding:5px 12px" onclick="saveExplanationEdit('${ex.id}')">Save</button>
          <button class="btn btn-secondary" style="font-size:12px;padding:5px 12px" onclick="cancelExplanationEdit('${ex.id}')">Cancel</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function editExplanation(id) {
  document.getElementById('exp-edit-row-' + id).style.display = '';
  document.getElementById('exp-row-' + id).style.display = 'none';
}

function cancelExplanationEdit(id) {
  document.getElementById('exp-edit-row-' + id).style.display = 'none';
  document.getElementById('exp-row-' + id).style.display = '';
}

async function saveExplanationEdit(id) {
  const body = document.getElementById('exp-edit-ta-' + id).value.trim();
  if (!body) return;
  await fetch('/api/explanations/' + id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  const idx = adminExplanations.findIndex(e => e.id === id);
  if (idx !== -1) adminExplanations[idx].body = body;
  renderExplanations();
}

function deleteExplanation(id, selector) {
  showModal(
    'Delete explanation?',
    `The explanation for "${selector}" will be permanently removed.`,
    async () => {
      await fetch('/api/explanations/' + id, { method: 'DELETE' });
      adminExplanations = adminExplanations.filter(e => e.id !== id);
      renderExplanations();
    }
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add src/views/admin-prototype-detail.html
git commit -m "feat: add Explanations tab to admin prototype detail page"
```

---

## Task 5: End-to-End Smoke Test

**Files:** None — verification only.

- [ ] **Step 1: Start the server**

```bash
cd /Users/i525473/ClaudeCode/proto-share
node src/server.js
```

- [ ] **Step 2: Log in as admin and open a prototype**

Navigate to `http://localhost:3000/admin/login`, sign in, open a prototype detail page, verify the **Explanations** tab appears and shows the empty state message.

- [ ] **Step 3: Open the share link and verify Explain mode**

Open the prototype's share link (log in with an allowlisted email if prompted). Verify:
- The toolbar shows four buttons: View, Comment, Review, Explain
- Clicking **Explain** activates the amber button style and shows the amber banner
- Clicking any element opens the "Add explanation" card with an empty textarea and no Delete button
- Typing text enables the Save button

- [ ] **Step 4: Create an explanation and verify marker**

Type an explanation in the card and click Save. Verify:
- A toast "Explanation saved." appears
- An amber `ℹ` marker appears at the top-right corner of the element
- Hovering the marker shows the popover with the explanation text

- [ ] **Step 5: Edit an explanation**

Click the same element again. Verify:
- The card title is "Edit explanation"
- The textarea is pre-filled with the saved text
- The Delete button is visible
- Changing text and clicking Save shows "Explanation saved." and updates the marker popover

- [ ] **Step 6: Verify admin detail page reflects the explanation**

Reload the admin detail page, click the **Explanations** tab. Verify:
- The explanation appears in the table with selector, truncated body, and page URL
- Clicking **Edit** shows the inline textarea pre-filled with the body
- Clicking **Delete** shows the confirm modal; confirming removes the row

- [ ] **Step 7: Verify mode isolation**

Switch to View mode — confirm the `ℹ` markers disappear. Switch back to Explain — they reappear. Switch to Comment mode — confirm comment pins appear and explain markers do not.
