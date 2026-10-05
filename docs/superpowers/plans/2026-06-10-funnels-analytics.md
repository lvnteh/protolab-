# Funnels Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Funnels tab to the prototype admin detail page showing page visit sequences, conversion drop-off, session journeys, and time-on-page — giving admins visibility into what path users took through a prototype.

**Architecture:** `feedback.js` intercepts navigation events (pushState/popstate/hashchange) and POSTs each to `/api/nav`, stored in a new `nav_events` SQLite table. The admin route stitches events into sessions (30-min gap per email) and serves computed funnel data to a new Funnels tab on the prototype detail page.

**Tech Stack:** Node.js/Express 4, better-sqlite3, vanilla JS (no build step), server-side HTML templates.

---

## File Map

| File | What changes |
|------|-------------|
| `src/db.js` | Add `nav_events` table + index; migration guard |
| `src/routes/api.js` | Add `POST /api/nav` endpoint |
| `public/sdk/feedback.js` | Add nav interceptor + `navHistory`; wire breadcrumb into comment POST |
| `src/routes/admin.js` | Add `GET /admin/prototypes/:id/funnels` with session stitching |
| `src/views/admin-prototype-detail.html` | Add Funnels tab button, panel HTML, fetch + render JS |

---

## Task 1: Add `nav_events` table to the database

**Files:**
- Modify: `src/db.js`

**Context:** `initDb()` runs `_db.exec(...)` with all table DDL, then applies migrations via `PRAGMA table_info`. Follow the same pattern.

- [ ] **Step 1: Open `src/db.js` and add the `nav_events` DDL inside the existing `_db.exec(...)` block**

  Add this immediately after the `comments` table DDL (before the closing backtick of the `_db.exec` call):

  ```sql
  CREATE TABLE IF NOT EXISTS nav_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    prototype_id TEXT NOT NULL,
    email        TEXT NOT NULL,
    page_url     TEXT NOT NULL,
    occurred_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_nav_events_proto
    ON nav_events(prototype_id, occurred_at);
  ```

- [ ] **Step 2: Verify the server starts without errors**

  ```bash
  node src/server.js &
  sleep 1 && curl -s http://localhost:1337/ -o /dev/null -w "%{http_code}"
  kill %1
  ```
  Expected: `302` (redirect to `/admin/prototypes`)

- [ ] **Step 3: Verify the table was created**

  ```bash
  node -e "
  const {getDb}=require('./src/db');
  const db=getDb();
  console.log(db.prepare(\"PRAGMA table_info(nav_events)\").all().map(c=>c.name));
  "
  ```
  Expected: `[ 'id', 'prototype_id', 'email', 'page_url', 'occurred_at' ]`

- [ ] **Step 4: Commit**

  ```bash
  git add src/db.js
  git commit -m "feat: add nav_events table for funnel tracking"
  ```

---

## Task 2: Add `POST /api/nav` endpoint

**Files:**
- Modify: `src/routes/api.js`

**Context:** `src/routes/api.js` exports an Express router mounted at `/api`. It uses `getDb()` from `../db` and `nanoid` is already imported. Add the new route after the existing `router.delete` at the bottom, before `module.exports`.

- [ ] **Step 1: Add the route to `src/routes/api.js`**

  Add before `module.exports = router;`:

  ```js
  router.post('/nav', (req, res) => {
    const { prototypeId, pageUrl } = req.body;
    if (!prototypeId || !pageUrl) return res.status(400).json({ error: 'prototypeId and pageUrl are required.' });
    const email = req.body.email || 'local@test.com';
    getDb().prepare(
      'INSERT INTO nav_events (prototype_id, email, page_url, occurred_at) VALUES (?,?,?,?)'
    ).run(prototypeId, email, String(pageUrl).slice(0, 500), new Date().toISOString());
    res.status(201).json({ ok: true });
  });
  ```

- [ ] **Step 2: Start the server and test the endpoint**

  ```bash
  node src/server.js &
  sleep 1
  curl -s -X POST http://localhost:1337/api/nav \
    -H 'Content-Type: application/json' \
    -d '{"prototypeId":"test123","pageUrl":"/home","email":"a@b.com"}' 
  ```
  Expected: `{"ok":true}`

- [ ] **Step 3: Test validation — missing fields return 400**

  ```bash
  curl -s -X POST http://localhost:1337/api/nav \
    -H 'Content-Type: application/json' \
    -d '{"prototypeId":"test123"}'
  ```
  Expected: `{"error":"prototypeId and pageUrl are required."}`

- [ ] **Step 4: Verify the row was inserted**

  ```bash
  node -e "
  const {getDb}=require('./src/db');
  console.log(getDb().prepare('SELECT * FROM nav_events').all());
  "
  kill %1
  ```
  Expected: one row with `prototype_id: 'test123'`, `page_url: '/home'`, `email: 'a@b.com'`.

- [ ] **Step 5: Commit**

  ```bash
  git add src/routes/api.js
  git commit -m "feat: add POST /api/nav endpoint"
  ```

---

## Task 3: Add navigation interceptor to `feedback.js`

**Files:**
- Modify: `public/sdk/feedback.js`

**Context:** `feedback.js` is a self-executing IIFE injected into every served prototype. The boot section is at the very bottom — `loadPins()` and `rafId = requestAnimationFrame(recomputePositions)` are the last two lines before the closing `})();`. `PROTO_ID` and `EMAIL` are already defined at the top of the IIFE. The comment submit handler is the `document.getElementById('__fb-draft-submit').addEventListener('click', ...)` block — it calls `postComment({...})` with `type`, `element`, `comment`, `pageUrl`, `tag`, `xPct`, `yPct`.

- [ ] **Step 1: Add `navHistory` state variable in the `/* ── state ── */` block**

  The state block starts with `let mode = 'view';`. Add `navHistory` after the existing state declarations:

  ```js
  let navHistory = [];   // page URLs visited this session, for breadcrumb
  ```

- [ ] **Step 2: Add the nav interceptor block just before the `/* ── boot ── */` comment**

  ```js
  /* ── navigation tracking ── */
  (function () {
    let lastUrl = '';

    function normalizeUrl() {
      if (location.hash && location.hash.length > 1) return location.hash.slice(1);
      return (location.pathname + location.search).slice(0, 500);
    }

    function recordNav() {
      const url = normalizeUrl();
      if (url === lastUrl) return;
      lastUrl = url;
      navHistory.push(url);
      fetch('/api/nav', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prototypeId: PROTO_ID, email: EMAIL || 'local@test.com', pageUrl: url }),
      }).catch(() => {});
    }

    // Patch history methods to fire a custom event
    ['pushState', 'replaceState'].forEach(method => {
      const orig = history[method];
      history[method] = function (...args) {
        orig.apply(this, args);
        window.dispatchEvent(new Event('fb-nav'));
      };
    });

    window.addEventListener('popstate', recordNav);
    window.addEventListener('hashchange', recordNav);
    window.addEventListener('fb-nav', recordNav);

    // Record initial page
    recordNav();
  })();
  ```

- [ ] **Step 3: Wire `navHistory` into the comment submit payload**

  In the `document.getElementById('__fb-draft-submit').addEventListener('click', ...)` handler, the `postComment({...})` call currently passes `type`, `element`, `comment`, `pageUrl`, `tag`, `xPct`, `yPct`. Add `breadcrumb: navHistory` to that object:

  ```js
  await postComment({
    type: 'element',
    element: { selector: draft.selector, label: '', tagName: '' },
    comment: text,
    pageUrl: location.href,
    tag: draft.tag,
    xPct: draft.xPct,
    yPct: draft.yPct,
    breadcrumb: navHistory,
  });
  ```

- [ ] **Step 4: Verify nav events are recorded**

  Open the served prototype at `http://localhost:1337/p/<share_token>` in a browser. Navigate around (or if it's a SPA, click links). Then run:

  ```bash
  node -e "
  const {getDb}=require('./src/db');
  console.log(getDb().prepare('SELECT * FROM nav_events ORDER BY occurred_at DESC LIMIT 10').all());
  "
  ```
  Expected: rows with `page_url` values matching pages you visited.

- [ ] **Step 5: Commit**

  ```bash
  git add public/sdk/feedback.js
  git commit -m "feat: track navigation events in feedback.js"
  ```

---

## Task 4: Add `GET /admin/prototypes/:id/funnels` route

**Files:**
- Modify: `src/routes/admin.js`

**Context:** `src/routes/admin.js` exports an Express router with `adminAuth` middleware. All routes follow the pattern `router.get/post(path, adminAuth, handler)`. Add this route before `module.exports = router;`. The session stitching and funnel computation all happen in JS (not SQL) because SQLite window functions are limited.

- [ ] **Step 1: Add the funnels route to `src/routes/admin.js`**

  Add before `module.exports = router;`:

  ```js
  router.get('/prototypes/:id/funnels', adminAuth, (req, res) => {
    const db = getDb();
    const protoId = req.params.id;

    // 1. Load all nav events for this prototype, ordered for stitching
    const events = db.prepare(
      'SELECT email, page_url, occurred_at FROM nav_events WHERE prototype_id = ? ORDER BY email, occurred_at ASC'
    ).all(protoId);

    // 2. Stitch into sessions (30-min gap per email = new session)
    const GAP_MS = 30 * 60 * 1000;
    const sessions = [];
    let cur = null;
    for (const ev of events) {
      const t = new Date(ev.occurred_at).getTime();
      if (!cur || ev.email !== cur.email || (t - cur.lastT) > GAP_MS) {
        cur = { email: ev.email, startedAt: ev.occurred_at, lastT: t, pages: [] };
        sessions.push(cur);
      }
      // Deduplicate consecutive identical pages
      if (cur.pages[cur.pages.length - 1] !== ev.page_url) cur.pages.push(ev.page_url);
      cur.lastT = t;
      cur.lastAt = ev.occurred_at;
    }

    // 3. Cross-reference comments to mark sessions that had a comment
    const commentRows = db.prepare(
      "SELECT email, created_at FROM comments WHERE prototype_id = ? AND type = 'element'"
    ).all(protoId);

    const journeys = sessions.slice(-50).reverse().map(s => {
      const sStart = new Date(s.startedAt).getTime();
      const sEnd = new Date(s.lastAt || s.startedAt).getTime() + 60000; // +1 min buffer
      const hadComment = commentRows.some(c => {
        const ct = new Date(c.created_at).getTime();
        return c.email === s.email && ct >= sStart && ct <= sEnd;
      });
      return { email: s.email, startedAt: s.startedAt, pages: s.pages, hadComment };
    });

    // 4. Build page funnel (ordered by median position across sessions)
    const pagePositions = {};
    for (const s of sessions) {
      s.pages.forEach((page, i) => {
        if (!pagePositions[page]) pagePositions[page] = [];
        pagePositions[page].push(i);
      });
    }
    const pageSessionCount = {};
    for (const s of sessions) {
      const seen = new Set();
      for (const p of s.pages) {
        if (!seen.has(p)) { pageSessionCount[p] = (pageSessionCount[p] || 0) + 1; seen.add(p); }
      }
    }
    function median(arr) {
      const s = [...arr].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }
    const funnelPages = Object.keys(pagePositions)
      .sort((a, b) => median(pagePositions[a]) - median(pagePositions[b]));
    const totalSessions = sessions.length;
    const funnel = funnelPages.map((page, i) => {
      const count = pageSessionCount[page] || 0;
      const pct = totalSessions ? Math.round(count / totalSessions * 100) : 0;
      const prevCount = i === 0 ? count : (pageSessionCount[funnelPages[i - 1]] || 0);
      const dropPct = i === 0 ? 0 : (prevCount ? Math.round((prevCount - count) / prevCount * 100) : 0);
      return { page, sessions: count, pct, dropPct };
    });

    // 5. Time on page (median inter-page interval per session, capped at 4h)
    const MAX_INTERVAL_MS = 4 * 60 * 60 * 1000;
    const pageIntervals = {};
    for (const s of sessions) {
      const evs = events.filter(e => e.email === s.email &&
        new Date(e.occurred_at).getTime() >= new Date(s.startedAt).getTime() &&
        new Date(e.occurred_at).getTime() <= new Date(s.lastAt || s.startedAt).getTime() + 1000
      );
      for (let i = 0; i < evs.length - 1; i++) {
        const dt = Math.min(
          new Date(evs[i + 1].occurred_at).getTime() - new Date(evs[i].occurred_at).getTime(),
          MAX_INTERVAL_MS
        );
        if (dt < 0) continue;
        if (!pageIntervals[evs[i].page_url]) pageIntervals[evs[i].page_url] = [];
        pageIntervals[evs[i].page_url].push(dt);
      }
    }
    const timeOnPage = Object.entries(pageIntervals)
      .filter(([, arr]) => arr.length >= 2)
      .map(([page, arr]) => ({ page, medianMs: Math.round(median(arr)), visits: arr.length }))
      .sort((a, b) => b.visits - a.visits);

    res.json({ funnel, journeys, timeOnPage });
  });
  ```

- [ ] **Step 2: Restart the server and test the route with no data**

  ```bash
  kill %1 2>/dev/null; node src/server.js &
  sleep 1
  PROTO_ID=$(node -e "const {getDb}=require('./src/db');console.log(getDb().prepare('SELECT id FROM prototypes LIMIT 1').get()?.id||'')")
  curl -s "http://localhost:1337/admin/prototypes/$PROTO_ID/funnels"
  ```
  Expected: `{"funnel":[],"journeys":[],"timeOnPage":[]}` (or populated if nav_events already has data from Task 3 testing)

- [ ] **Step 3: Insert test data and verify funnel computation**

  ```bash
  node -e "
  const {getDb}=require('./src/db');
  const db=getDb();
  const id=db.prepare('SELECT id FROM prototypes LIMIT 1').get().id;
  const now=Date.now();
  const rows=[
    [id,'a@test.com','/home',new Date(now-5*60000).toISOString()],
    [id,'a@test.com','/pricing',new Date(now-3*60000).toISOString()],
    [id,'a@test.com','/features',new Date(now-1*60000).toISOString()],
    [id,'b@test.com','/home',new Date(now-8*60000).toISOString()],
    [id,'b@test.com','/pricing',new Date(now-6*60000).toISOString()],
  ];
  const ins=db.prepare('INSERT INTO nav_events(prototype_id,email,page_url,occurred_at) VALUES(?,?,?,?)');
  rows.forEach(r=>ins.run(...r));
  console.log('inserted',rows.length,'rows');
  "
  curl -s "http://localhost:1337/admin/prototypes/$PROTO_ID/funnels" | node -e "const d=require('fs').readFileSync(0,'utf8');console.log(JSON.stringify(JSON.parse(d),null,2))"
  ```
  Expected: funnel with `/home` first (2 sessions, 100%), `/pricing` second (2, 100%, 0% drop), `/features` third (1, 50%, 50% drop). Two journeys. Time on page for `/home` and `/pricing`.

- [ ] **Step 4: Commit**

  ```bash
  git add src/routes/admin.js
  git commit -m "feat: add funnels route with session stitching"
  ```

---

## Task 5: Add Funnels tab to admin prototype detail page

**Files:**
- Modify: `src/views/admin-prototype-detail.html`

**Context:** The admin detail page is a server-rendered HTML template. The tabs bar is a `<div class="tabs">` containing `<button class="tab" data-tab="...">` elements. Tab panels are `<div class="tab-panel" id="tab-...">` inside `<div class="tab-body">`. The JS at the bottom handles tab switching and data fetching. `PROTO_ID` and `SHARE_TOKEN` are already defined as JS constants.

- [ ] **Step 1: Add the Funnels tab button**

  In `src/views/admin-prototype-detail.html`, find the tabs bar:
  ```html
  <button class="tab" data-tab="settings">Settings</button>
  ```
  Add the Funnels button after it:
  ```html
  <button class="tab" data-tab="funnels">Funnels</button>
  ```

- [ ] **Step 2: Add the Funnels tab panel HTML**

  Find `<!-- Settings tab -->` and add the Funnels panel before it (or after the access log panel, before settings):

  ```html
  <!-- Funnels tab -->
  <div class="tab-panel" id="tab-funnels">
    <div id="funnels-loading" style="padding:40px;text-align:center;color:hsl(220,9%,46%)">Loading…</div>
    <div id="funnels-empty" style="display:none;padding:40px;text-align:center;color:hsl(220,9%,46%)">
      <p style="font-size:13px">No navigation data yet. Share the prototype link to start collecting sessions.</p>
    </div>
    <div id="funnels-content" style="display:none;padding:16px;display:none">

      <!-- Panel 1: Page Funnel -->
      <div style="margin-bottom:24px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <h3 style="font-size:13px;font-weight:700;color:hsl(222,47%,11%);margin:0">Page Funnel</h3>
          <label style="font-size:12px;color:hsl(220,9%,46%);display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" id="funnel-unique"> Unique visitors only
          </label>
        </div>
        <div class="tbl-wrap"><table class="tbl" id="funnel-table">
          <thead><tr>
            <th>Page</th>
            <th>Sessions</th>
            <th>% of total</th>
            <th>Drop-off</th>
          </tr></thead>
          <tbody id="funnel-body"></tbody>
        </table></div>
      </div>

      <!-- Panel 2: Session Journeys -->
      <div style="margin-bottom:24px">
        <h3 style="font-size:13px;font-weight:700;color:hsl(222,47%,11%);margin:0 0 10px">Session Journeys</h3>
        <div id="journeys-list"></div>
      </div>

      <!-- Panel 3: Time on Page -->
      <div style="margin-bottom:24px">
        <h3 style="font-size:13px;font-weight:700;color:hsl(222,47%,11%);margin:0 0 10px">Time on Page</h3>
        <div class="tbl-wrap"><table class="tbl" id="time-table">
          <thead><tr>
            <th>Page</th>
            <th>Median time</th>
            <th>Visits</th>
          </tr></thead>
          <tbody id="time-body"></tbody>
        </table></div>
      </div>

    </div>
  </div>
  ```

- [ ] **Step 3: Add the Funnels JS at the bottom of the `<script>` block**

  Add before the closing `</script>` tag:

  ```js
  // Funnels
  let funnelsData = null;
  let funnelsLoaded = false;

  function fmtDuration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
  }

  function renderFunnels(data) {
    document.getElementById('funnels-loading').style.display = 'none';
    if (!data.funnel.length && !data.journeys.length) {
      document.getElementById('funnels-empty').style.display = 'block';
      return;
    }
    const content = document.getElementById('funnels-content');
    content.style.display = 'block';

    renderFunnelTable(data, false);

    document.getElementById('funnel-unique').addEventListener('change', e => {
      renderFunnelTable(data, e.target.checked);
    });

    // Journeys
    const jList = document.getElementById('journeys-list');
    if (!data.journeys.length) {
      jList.innerHTML = '<p style="font-size:13px;color:hsl(220,9%,46%);padding:8px 0">No sessions recorded yet.</p>';
    } else {
      jList.innerHTML = data.journeys.map(j => {
        const pages = j.pages.map(p => `<code style="background:hsl(220,14%,96%);border:1px solid hsl(220,13%,87%);padding:1px 6px;border-radius:4px;font-size:11px">${esc(p)}</code>`).join(' <span style="color:hsl(220,9%,60%);font-size:12px">→</span> ');
        const pin = j.hadComment ? ' <span title="Had comment">📌</span>' : '';
        const ts = new Date(j.startedAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        return `<div style="padding:10px 0;border-bottom:1px solid hsl(220,13%,91%);font-size:12px;display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
          <span style="color:hsl(252,83%,50%);font-weight:600;white-space:nowrap">${esc(j.email)}</span>
          <span style="color:hsl(220,9%,46%);white-space:nowrap">${ts}</span>
          <span style="flex:1">${pages}${pin}</span>
        </div>`;
      }).join('');
    }

    // Time on page
    const tBody = document.getElementById('time-body');
    if (!data.timeOnPage.length) {
      tBody.innerHTML = '<tr><td colspan="3" style="color:hsl(220,9%,46%);text-align:center;padding:20px">Not enough data yet.</td></tr>';
    } else {
      tBody.innerHTML = data.timeOnPage.map(r => `
        <tr>
          <td><code style="font-size:11px">${esc(r.page)}</code></td>
          <td>${fmtDuration(r.medianMs)}</td>
          <td>${r.visits}</td>
        </tr>
      `).join('');
    }
  }

  function renderFunnelTable(data, uniqueOnly) {
    const totalSessions = data.journeys.length || 1;
    const body = document.getElementById('funnel-body');
    if (!data.funnel.length) {
      body.innerHTML = '<tr><td colspan="4" style="color:hsl(220,9%,46%);text-align:center;padding:20px">No pages tracked yet.</td></tr>';
      return;
    }
    const maxSessions = data.funnel[0] ? data.funnel[0].sessions : 1;
    body.innerHTML = data.funnel.map((row, i) => {
      const count = uniqueOnly
        ? new Set(data.journeys.filter(j => j.pages.includes(row.page)).map(j => j.email)).size
        : row.sessions;
      const pct = maxSessions ? Math.round(count / maxSessions * 100) : 0;
      const dropColor = row.dropPct > 30 ? 'color:hsl(0,84%,50%)' : 'color:hsl(220,9%,46%)';
      return `<tr>
        <td><code style="font-size:11px">${esc(row.page)}</code></td>
        <td>${count}</td>
        <td>
          <div style="display:flex;align-items:center;gap:8px">
            <div style="background:hsl(252,83%,57%);height:6px;border-radius:3px;width:${pct}%;min-width:2px;max-width:120px"></div>
            <span>${pct}%</span>
          </div>
        </td>
        <td style="${i === 0 ? 'color:hsl(220,9%,60%)' : dropColor}">${i === 0 ? '—' : row.dropPct + '%'}</td>
      </tr>`;
    }).join('');
  }

  async function loadFunnels() {
    if (funnelsLoaded) return;
    funnelsLoaded = true;
    try {
      const resp = await fetch('/admin/prototypes/' + PROTO_ID + '/funnels');
      funnelsData = await resp.json();
      renderFunnels(funnelsData);
    } catch (e) {
      document.getElementById('funnels-loading').textContent = 'Failed to load funnel data.';
    }
  }
  ```

- [ ] **Step 4: Hook `loadFunnels` into the tab-switching logic**

  The existing tab-switching code is:
  ```js
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });
  ```
  Change it to:
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

- [ ] **Step 5: Restart the server and open the admin detail page**

  ```bash
  kill %1 2>/dev/null; node src/server.js &
  sleep 1
  ```
  Open `http://localhost:1337/admin/prototypes/<id>` in the browser. Click the Funnels tab. Verify:
  - "Loading…" briefly appears then is replaced by the three panels.
  - If test data from Task 4 is still in the DB: funnel table shows `/home`, `/pricing`, `/features` with correct percentages; session journeys show two rows; time-on-page shows `/home` and `/pricing`.
  - If no data: empty state message "No navigation data yet…" appears.

- [ ] **Step 6: Open the shared prototype link and navigate around, then re-check Funnels**

  Visit `http://localhost:1337/p/<share_token>` in a browser. Click through a few pages/sections. Return to the admin Funnels tab (refresh the admin page) and click Funnels again. Verify new nav events appear as sessions in the Journeys panel.

- [ ] **Step 7: Commit**

  ```bash
  git add src/views/admin-prototype-detail.html
  git commit -m "feat: add Funnels tab to admin prototype detail"
  ```

---

## Self-Review Checklist

After completing all tasks:

- [ ] `nav_events` table exists and has the index
- [ ] `POST /api/nav` returns 201 for valid input, 400 for missing fields
- [ ] `feedback.js` fires a nav event on initial load AND on each subsequent route change
- [ ] `breadcrumb` is included in the comment POST payload
- [ ] Funnels tab loads lazily (only on first click, not on page load)
- [ ] Empty state shows when no nav data exists
- [ ] Funnel table, session journeys, and time-on-page all render correctly with test data
- [ ] Server restarts cleanly with old DB (migration guard creates the table)
