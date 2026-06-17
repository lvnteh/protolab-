# Threaded Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow any reviewer to reply to an existing feedback pin — replies appear threaded in the pin popover, the read-only tooltip, and the admin Comments tab.

**Architecture:** Add a nullable `parent_id` FK column to the existing `comments` table. Replies are rows with `parent_id` set and `type = 'reply'`. The GET endpoint nests replies under parents before responding. The SDK popover gains a reply thread and reply form. The admin panel shows reply sub-rows inline.

**Tech Stack:** Node.js/Express, PostgreSQL (via `pg` Pool), plain JS SDK (no bundler), supertest for API tests.

---

## File Map

| File | Change |
|------|--------|
| `src/db.js` | Add `parent_id` column migration + widen `type` CHECK |
| `src/routes/api.js` | `GET` nests replies; `POST` handles `parentId` |
| `src/routes/admin.js` | Comments query fetches replies; preview query includes replies |
| `public/sdk/feedback.js` | Reply thread + reply form in popover |
| `public/sdk/preview.js` | Read-only reply thread in tooltip |
| `src/views/admin-prototype-detail.html` | Reply sub-rows in Comments tab |
| `tests/api.test.js` | New tests for reply POST and GET nesting |

---

### Task 1: Database migration — add `parent_id` and widen `type` CHECK

**Files:**
- Modify: `src/db.js`

- [ ] **Step 1: Add the migration statements to `initDb()`**

In `src/db.js`, after the existing `CREATE TABLE IF NOT EXISTS comments` block (around line 61), add:

```js
  // Widen the type CHECK to also allow 'reply' rows
  await _pool.query(`
    ALTER TABLE comments
      DROP CONSTRAINT IF EXISTS comments_type_check
  `);
  await _pool.query(`
    ALTER TABLE comments
      ADD CONSTRAINT comments_type_check
      CHECK(type IN ('general', 'element', 'reply'))
  `);

  // Add parent_id FK (idempotent)
  await _pool.query(`
    ALTER TABLE comments
      ADD COLUMN IF NOT EXISTS parent_id TEXT
      REFERENCES comments(id) ON DELETE CASCADE
  `);
```

These run every startup — `IF NOT EXISTS` / `DROP … IF EXISTS` make them safe to re-run.

- [ ] **Step 2: Verify the server still starts without error**

```bash
node -e "require('./src/db').initDb().then(() => { console.log('OK'); process.exit(0); }).catch(e => { console.error(e.message); process.exit(1); })"
```

Expected output: `OK`

- [ ] **Step 3: Commit**

```bash
git add src/db.js
git commit -m "feat: add parent_id column and widen type check for reply rows"
```

---

### Task 2: API — `POST /api/comments` accepts `parentId`

**Files:**
- Modify: `src/routes/api.js`
- Test: `tests/api.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/api.test.js` inside the `describe('api routes', ...)` block:

```js
  test('POST /api/comments with parentId stores a reply', async () => {
    // create a parent pin first
    const parent = await request(app).post('/api/comments').send({
      prototypeId: protoId,
      type: 'element',
      element: { selector: '#hero', label: 'Hero', tagName: 'DIV' },
      comment: 'Parent pin',
      pageUrl: '/p/abc/view',
    });
    expect(parent.status).toBe(201);
    const parentId = parent.body.id;

    const reply = await request(app).post('/api/comments').send({
      prototypeId: protoId,
      parentId,
      comment: 'A reply',
    });
    expect(reply.status).toBe(201);

    const { rows } = await getDb().query('SELECT * FROM comments WHERE id = $1', [reply.body.id]);
    expect(rows[0].parent_id).toBe(parentId);
    expect(rows[0].type).toBe('reply');
  });

  test('POST /api/comments with unknown parentId returns 404', async () => {
    const res = await request(app).post('/api/comments').send({
      prototypeId: protoId,
      parentId: 'nonexistent-id',
      comment: 'orphan reply',
    });
    expect(res.status).toBe(404);
  });

  test('POST /api/comments cannot reply to a reply', async () => {
    // create parent → reply → try to reply to the reply
    const parent = await request(app).post('/api/comments').send({
      prototypeId: protoId,
      type: 'element',
      element: { selector: '#x', label: 'X', tagName: 'DIV' },
      comment: 'Parent',
      pageUrl: '/p/abc/view',
    });
    const r1 = await request(app).post('/api/comments').send({
      prototypeId: protoId,
      parentId: parent.body.id,
      comment: 'First reply',
    });
    const r2 = await request(app).post('/api/comments').send({
      prototypeId: protoId,
      parentId: r1.body.id,
      comment: 'Nested reply — must fail',
    });
    expect(r2.status).toBe(400);
  });
```

- [ ] **Step 2: Run to confirm they fail**

```bash
DATABASE_URL="$DATABASE_URL" npx jest tests/api.test.js --testNamePattern="parentId|reply to a reply" 2>&1 | tail -20
```

Expected: 3 failing tests (route doesn't handle `parentId` yet).

- [ ] **Step 3: Implement `parentId` handling in `POST /api/comments`**

In `src/routes/api.js`, replace the existing `router.post('/comments', ...)` handler with:

```js
router.post('/comments', async (req, res) => {
  const { prototypeId, type, comment, element, breadcrumb, pageUrl, tag, xPct, yPct, email, parentId } = req.body;
  const commentEmail = email || 'local@test.com';
  if (!comment || !comment.trim()) return res.status(400).json({ error: 'Comment is required.' });

  const id = nanoid(12);

  if (parentId) {
    // Validate parent exists and is not itself a reply
    const { rows: parentRows } = await getDb().query(
      'SELECT id, parent_id FROM comments WHERE id = $1 AND prototype_id = $2',
      [parentId, prototypeId]
    );
    if (!parentRows.length) return res.status(404).json({ error: 'Parent comment not found.' });
    if (parentRows[0].parent_id) return res.status(400).json({ error: 'Cannot reply to a reply.' });

    await getDb().query(
      `INSERT INTO comments
        (id, prototype_id, email, type, comment, created_at, parent_id)
       VALUES ($1,$2,$3,'reply',$4,$5,$6)`,
      [id, prototypeId, commentEmail, comment.trim(), new Date().toISOString(), parentId]
    );
    return res.status(201).json({ ok: true, id });
  }

  if (!['general', 'element'].includes(type)) return res.status(400).json({ error: 'Invalid type.' });

  await getDb().query(
    `INSERT INTO comments
      (id, prototype_id, email, type, element_selector, element_label, element_tag,
       breadcrumb, comment, page_url, created_at, tag, x_pct, y_pct)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id, prototypeId, commentEmail, type,
      element?.selector || null,
      element?.label    || null,
      element?.tagName  || null,
      breadcrumb ? JSON.stringify(breadcrumb) : null,
      comment.trim(),
      pageUrl || null,
      new Date().toISOString(),
      VALID_TAGS.includes(tag) ? tag : null,
      typeof xPct === 'number' ? xPct : null,
      typeof yPct === 'number' ? yPct : null,
    ]
  );
  res.status(201).json({ ok: true, id });
});
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
DATABASE_URL="$DATABASE_URL" npx jest tests/api.test.js 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/routes/api.js tests/api.test.js
git commit -m "feat: POST /api/comments accepts parentId for threaded replies"
```

---

### Task 3: API — `GET /api/comments/:protoId` nests replies

**Files:**
- Modify: `src/routes/api.js`
- Test: `tests/api.test.js`

- [ ] **Step 1: Write the failing test**

Add inside the `describe` block in `tests/api.test.js`:

```js
  test('GET /api/comments/:protoId nests replies under their parent', async () => {
    // Create a fresh prototype so we get a clean comment set
    const pid = nanoid(12);
    await getDb().query(
      'INSERT INTO prototypes (id, name, filename, share_token, created_at) VALUES ($1,$2,$3,$4,$5)',
      [pid, 'NestTest', 'nest.html', nanoid(12), new Date().toISOString()]
    );

    // Post parent
    const p = await request(app).post('/api/comments').send({
      prototypeId: pid,
      type: 'element',
      element: { selector: '#a', label: 'A', tagName: 'DIV' },
      comment: 'Top comment',
      pageUrl: '/p/x/view',
    });

    // Post reply
    await request(app).post('/api/comments').send({
      prototypeId: pid,
      parentId: p.body.id,
      comment: 'A reply text',
    });

    const get = await request(app).get('/api/comments/' + pid);
    expect(get.status).toBe(200);
    const pins = get.body;
    expect(pins.length).toBe(1);
    expect(pins[0].replies.length).toBe(1);
    expect(pins[0].replies[0].comment).toBe('A reply text');
    expect(pins[0].replies[0].id).toBeDefined();
    // reply must not appear at top level
    expect(pins.find(p => p.comment === 'A reply text')).toBeUndefined();
  });
```

- [ ] **Step 2: Run to confirm it fails**

```bash
DATABASE_URL="$DATABASE_URL" npx jest tests/api.test.js --testNamePattern="nests replies" 2>&1 | tail -20
```

Expected: FAIL — `pins[0].replies` is `undefined`.

- [ ] **Step 3: Update `GET /api/comments/:protoId` to nest replies**

Replace the existing `router.get('/comments/:prototypeId', ...)` handler in `src/routes/api.js`:

```js
router.get('/comments/:prototypeId', async (req, res) => {
  const { rows } = await getDb().query(
    `SELECT id, email, element_selector, element_label, comment, created_at, tag, x_pct, y_pct, page_url, parent_id
     FROM comments
     WHERE prototype_id = $1
     ORDER BY created_at ASC`,
    [req.params.prototypeId]
  );

  const parents = [];
  const replyMap = {}; // parentId -> reply[]

  rows.forEach(r => {
    if (r.parent_id) {
      if (!replyMap[r.parent_id]) replyMap[r.parent_id] = [];
      replyMap[r.parent_id].push({ id: r.id, email: r.email, comment: r.comment, created_at: r.created_at });
    } else {
      parents.push(r);
    }
  });

  const result = parents.map((r, i) => ({
    ...r,
    order: i + 1,
    replies: replyMap[r.id] || [],
  }));

  res.json(result);
});
```

- [ ] **Step 4: Run all tests**

```bash
DATABASE_URL="$DATABASE_URL" npx jest tests/api.test.js 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/routes/api.js tests/api.test.js
git commit -m "feat: GET /api/comments nests replies under parent pins"
```

---

### Task 4: Admin route — include replies in comments list and preview

**Files:**
- Modify: `src/routes/admin.js`

- [ ] **Step 1: Fetch replies for the paged comment list**

In `src/routes/admin.js`, find the `router.post('/prototypes/:id/comments', ...)` handler. After the existing `rowsResult` query (around line 166) and before `res.json(...)`, add a second query to attach replies:

```js
  // Fetch replies for the returned page of parent comments
  const parentIds = rows.filter(r => r.type !== 'reply').map(r => r.id);
  let replyRows = [];
  if (parentIds.length) {
    const placeholders = parentIds.map((_, i) => `$${i + 1}`).join(',');
    const rr = await getDb().query(
      `SELECT id, parent_id, email, comment, created_at FROM comments WHERE parent_id IN (${placeholders}) ORDER BY created_at ASC`,
      parentIds
    );
    replyRows = rr.rows;
  }

  const replyMap = {};
  replyRows.forEach(r => {
    if (!replyMap[r.parent_id]) replyMap[r.parent_id] = [];
    replyMap[r.parent_id].push(r);
  });

  const rowsWithReplies = rows.map(r => ({ ...r, replies: replyMap[r.id] || [] }));
```

Then change `res.json({ data: rows, totalCount: total })` to:

```js
  res.json({ data: rowsWithReplies, totalCount: total });
```

Also update the total count query to exclude reply rows from the count (replies are already children, not standalone comments):

Find both `COUNT(*)` queries in this handler and add `AND parent_id IS NULL` (or keep as-is — replies belong to the prototype so counting them in the total is acceptable per spec). Per spec: "stat-comments count includes reply rows" — so leave count queries unchanged.

- [ ] **Step 2: Include replies in the preview script injection**

In `src/routes/admin.js`, find the `router.get('/prototypes/:id/preview', ...)` handler (around line 204). Replace the comment query and mapping with:

```js
  const { rows: allCommentRows } = await getDb().query(
    `SELECT id, email, element_selector, element_label, comment, created_at, tag, x_pct, y_pct, page_url, parent_id
     FROM comments WHERE prototype_id = $1
     ORDER BY created_at ASC`,
    [proto.id]
  );

  const replyMap = {};
  allCommentRows.filter(r => r.parent_id).forEach(r => {
    if (!replyMap[r.parent_id]) replyMap[r.parent_id] = [];
    replyMap[r.parent_id].push({ id: r.id, email: r.email, comment: r.comment, created_at: r.created_at });
  });

  const comments = allCommentRows
    .filter(r => !r.parent_id)
    .map((r, i) => ({ ...r, order: i + 1, replies: replyMap[r.id] || [] }));
```

- [ ] **Step 3: Restart the server and verify it starts cleanly**

```bash
node -e "require('./src/server.js')" &
sleep 2 && kill %1 2>/dev/null; echo "OK"
```

Expected: no crash / no unhandled promise rejection printed.

- [ ] **Step 4: Commit**

```bash
git add src/routes/admin.js
git commit -m "feat: admin comments endpoint and preview include reply threads"
```

---

### Task 5: `feedback.js` — reply thread and reply form in pin popover

**Files:**
- Modify: `public/sdk/feedback.js`

- [ ] **Step 1: Add reply styles to the STYLE constant**

In `public/sdk/feedback.js`, find the `const STYLE = \`` block. Before the closing backtick of the `STYLE` string, append:

```css
    .fb-popover__replies {
      margin-top: 8px; padding-top: 8px;
      border-top: 1px solid hsl(220,13%,91%);
      display: flex; flex-direction: column; gap: 6px;
    }
    .fb-popover__reply { font-size: 12px; line-height: 1.45; }
    .fb-popover__reply-email { font-weight: 600; color: hsl(252,83%,50%); margin-right: 4px; }
    .fb-popover__reply-body { color: hsl(222,47%,11%); }
    .fb-popover__reply-date { color: hsl(220,9%,46%); font-size: 11px; margin-left: 4px; }
    .fb-reply-form {
      margin-top: 8px; padding-top: 8px;
      border-top: 1px solid hsl(220,13%,91%);
      display: flex; gap: 6px; align-items: flex-start;
    }
    .fb-reply-input {
      flex: 1; resize: none; border: 1px solid hsl(220,13%,87%); border-radius: 8px;
      padding: 5px 8px; font-size: 12px; font-family: inherit; outline: none;
      background: #fff; color: hsl(222,47%,11%); line-height: 1.4;
    }
    .fb-reply-input:focus { border-color: hsl(252,83%,57%); box-shadow: 0 0 0 2px hsl(252,83%,90%); }
    .fb-reply-btn {
      padding: 5px 10px; border-radius: 6px; font-size: 12px; font-weight: 600;
      cursor: pointer; border: none; background: hsl(252,83%,57%); color: #fff;
      font-family: inherit; white-space: nowrap;
    }
    .fb-reply-btn:hover { background: hsl(252,83%,48%); }
    .fb-reply-btn:disabled { opacity: .5; cursor: default; }
```

- [ ] **Step 2: Add reply rendering and form to `renderPinEl`**

In `renderPinEl`, find the section inside `showPopover` where the non-editing popover HTML is built (the `else` branch around line 796). Replace the final `popoverEl.innerHTML = ...` assignment and the subsequent `btn.appendChild(popoverEl)` call with:

```js
        const repliesHtml = (pin.replies || []).map(r => {
          const rDate = new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
          return `<div class="fb-popover__reply">
            <span class="fb-popover__reply-email">${escHtml(r.email)}</span>
            <span class="fb-popover__reply-body">${escHtml(r.comment)}</span>
            <span class="fb-popover__reply-date">· ${rDate}</span>
          </div>`;
        }).join('');

        const repliesBlock = (pin.replies && pin.replies.length)
          ? `<div class="fb-popover__replies">${repliesHtml}</div>`
          : '';

        popoverEl.innerHTML = `${tagHtml}
          <div class="fb-popover__body">${escHtml(pin.comment)}</div>
          <div class="fb-popover__meta">${escHtml(pin.email)} · ${timeStr}</div>
          ${actionsHtml}
          ${repliesBlock}
          <div class="fb-reply-form">
            <textarea class="fb-reply-input" rows="1" placeholder="Reply…"></textarea>
            <button class="fb-reply-btn" disabled>Reply</button>
          </div>`;

        btn.appendChild(popoverEl);

        const replyInput = popoverEl.querySelector('.fb-reply-input');
        const replyBtn   = popoverEl.querySelector('.fb-reply-btn');

        replyInput.addEventListener('input', () => {
          replyBtn.disabled = !replyInput.value.trim();
        });

        replyBtn.addEventListener('click', async e => {
          e.stopPropagation();
          const text = replyInput.value.trim();
          if (!text) return;
          replyBtn.disabled = true;
          replyBtn.textContent = 'Posting…';
          try {
            await postComment({ type: 'reply', comment: text, parentId: pin.id });
            showToast('Reply posted.');
            await loadPins();
            // re-open so the new reply appears
            pinned = true;
            showPopover();
          } catch (_) {
            showToast('Failed to post reply.', true);
            replyBtn.disabled = false;
            replyBtn.textContent = 'Reply';
          }
        });
```

- [ ] **Step 3: Update `postComment` to pass `parentId`**

`postComment` already spreads `payload` into the fetch body, so no change needed — calling `postComment({ type: 'reply', comment: text, parentId: pin.id })` already sends `parentId` correctly. Verify `postComment` in `feedback.js`:

```js
  async function postComment(payload) {
    const resp = await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prototypeId: PROTO_ID, email: EMAIL, ...payload }),
      credentials: 'include',
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return resp.json();
  }
```

No change needed.

- [ ] **Step 4: Widen the popover container to fit reply form**

The `.fb-popover` width is currently `240px`. Replies + form need more room. In the `STYLE` constant, change:

```css
    .fb-popover {
      position: absolute; left: calc(100% + 8px); top: -4px;
      width: 240px;
```

to:

```css
    .fb-popover {
      position: absolute; left: calc(100% + 8px); top: -4px;
      width: 280px;
```

- [ ] **Step 5: Commit**

```bash
git add public/sdk/feedback.js
git commit -m "feat: threaded reply form and thread in pin popover"
```

---

### Task 6: `preview.js` — read-only reply thread in tooltip

**Files:**
- Modify: `public/sdk/preview.js`

- [ ] **Step 1: Add reply styles**

In `public/sdk/preview.js`, inside the `STYLE` constant, after the `.__fb-tooltip-date` rule, append:

```css
    .__fb-tooltip-replies {
      margin-top: 8px; padding-top: 8px;
      border-top: 1px solid hsl(220,13%,91%);
      display: flex; flex-direction: column; gap: 4px;
    }
    .__fb-tooltip-reply { font-size: 12px; color: hsl(222,47%,11%); line-height: 1.4; }
    .__fb-tooltip-reply-email { font-weight: 600; color: hsl(252,83%,50%); margin-right: 3px; }
    .__fb-tooltip-reply-date { color: hsl(220,9%,46%); font-size: 11px; margin-left: 3px; }
```

- [ ] **Step 2: Render replies in `showTooltip`**

In `public/sdk/preview.js`, find the `showTooltip` function. Replace the `tooltipEl.innerHTML = ...` assignment with:

```js
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
```

- [ ] **Step 3: Commit**

```bash
git add public/sdk/preview.js
git commit -m "feat: read-only reply thread in preview tooltip"
```

---

### Task 7: Admin panel — reply sub-rows in Comments tab

**Files:**
- Modify: `src/views/admin-prototype-detail.html`

- [ ] **Step 1: Add reply sub-row styles**

In `admin-prototype-detail.html`, find the `<style>` block. Before the closing `</style>`, append:

```css
.reply-row td { background: hsl(252,83%,98%); border-left: 3px solid hsl(252,83%,57%); padding-left: 32px; font-size: 12px; }
.reply-row:hover td { background: hsl(252,83%,95%); }
.reply-badge { display:inline-block; padding:1px 7px; border-radius:20px; font-size:10px; font-weight:700; background:hsl(252,83%,95%); color:hsl(252,83%,40%); margin-left:6px; cursor:pointer; }
```

- [ ] **Step 2: Update `loadComments` to render reply sub-rows**

In the `loadComments` function in `admin-prototype-detail.html`, replace the `tbody.innerHTML = data.map(r => ...)` block with:

```js
    tbody.innerHTML = data.map(r => {
      const replyCount = r.replies ? r.replies.length : 0;
      const replyBadge = replyCount > 0
        ? `<span class="reply-badge" onclick="toggleReplies('${r.id}')">${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}</span>`
        : '';

      const replyRows = (r.replies || []).map(rep => `
        <tr class="reply-row" id="reply-row-${rep.id}">
          <td style="white-space:nowrap">${esc(rep.email)}</td>
          <td colspan="3"></td>
          <td class="comment-text">${esc(rep.comment)}</td>
          <td class="ts">${fmtDate(rep.created_at)}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-danger" style="font-size:11px;padding:4px 8px" onclick="deleteComment('${rep.id}')">Delete</button>
          </td>
        </tr>
      `).join('');

      return `
        <tr id="comment-row-${r.id}">
          <td style="white-space:nowrap">${esc(r.email)}</td>
          <td><span class="badge badge-${r.type}">${r.type}</span></td>
          <td>${tagBadge(r.tag)}</td>
          <td>${r.element_label ? `<span style="font-weight:500">${esc(r.element_label)}</span><br><span class="selector" title="${esc(r.element_selector||'')}">${esc(r.element_selector||'')}</span>` : '<span style="color:hsl(220,13%,80%)">—</span>'}</td>
          <td class="comment-text">${esc(r.comment)}${replyBadge}</td>
          <td class="ts">${fmtDate(r.created_at)}</td>
          <td style="white-space:nowrap;display:flex;gap:6px;align-items:center">
            ${r.type === 'element' ? `<a href="/p/${SHARE_TOKEN}?focus=${r.id}" target="_blank" class="btn btn-secondary" style="font-size:11px;padding:4px 8px;white-space:nowrap">View</a>` : ''}
            <button class="btn btn-danger" style="font-size:11px;padding:4px 8px" onclick="deleteComment('${r.id}')">Delete</button>
          </td>
        </tr>
        ${replyRows}
      `;
    }).join('');
```

- [ ] **Step 3: Add `toggleReplies` helper**

Before the closing `</script>` tag in `admin-prototype-detail.html`, add:

```js
function toggleReplies(parentId) {
  const parent = document.getElementById('comment-row-' + parentId);
  if (!parent) return;
  let el = parent.nextElementSibling;
  while (el && el.classList.contains('reply-row')) {
    el.style.display = el.style.display === 'none' ? '' : 'none';
    el = el.nextElementSibling;
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/views/admin-prototype-detail.html
git commit -m "feat: reply sub-rows in admin Comments tab"
```

---

### Task 8: Push and verify on Railway

- [ ] **Step 1: Push to main**

```bash
git push origin main
```

- [ ] **Step 2: Verify the Railway deployment picks up the changes**

Wait ~60 seconds for Railway to redeploy, then:
1. Open the prototype share link in a browser
2. Switch to Comment mode, click an element to add a pin
3. Hover/click the pin — confirm the reply form appears at the bottom of the popover
4. Type a reply and click Reply — confirm "Reply posted." toast and the reply appears in the thread
5. Open the prototype via the admin preview link — confirm the tooltip shows the reply
6. Open the admin detail page → Comments tab — confirm the reply badge and sub-row appear

- [ ] **Step 3: Done**

All tasks complete.
