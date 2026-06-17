# Threaded Replies on Feedback Pins

**Date:** 2026-06-17  
**Status:** Approved

---

## Summary

Any reviewer who can access a prototype can reply to an existing feedback pin. Replies are plain text — no tag, no new pin placed on the canvas. Threads are visible in the pin popover (feedback.js), the read-only tooltip (preview.js), and the admin Comments tab.

---

## 1. Database

### Schema change

```sql
ALTER TABLE comments
  ADD COLUMN IF NOT EXISTS parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE;
```

- Top-level pins: `parent_id = NULL`, `type IN ('general', 'element')` (unchanged)
- Replies: `parent_id = <parent comment id>`, `type = 'reply'`
- The existing `CHECK(type IN ('general', 'element'))` constraint is widened to also allow `'reply'`
- `ON DELETE CASCADE` means deleting a pin auto-deletes all its replies
- Applied via `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in `initDb()` so it is idempotent on Railway restart

### Fields unused on replies

`element_selector`, `element_label`, `element_tag`, `breadcrumb`, `page_url`, `tag`, `x_pct`, `y_pct` are all `NULL` for reply rows. No separate table needed.

---

## 2. API

### `GET /api/comments/:protoId`

Unchanged URL. Fetches all rows where `prototype_id = $1` (parents **and** replies) ordered by `created_at ASC`. Groups them in JS before responding: replies are nested under their parent in a `replies` array. Only top-level rows appear in the outer array; reply-only rows are never surfaced at the top level.

Response shape:

```json
[
  {
    "id": "abc",
    "email": "alice@co.com",
    "comment": "This button is broken",
    "tag": "bug",
    "order": 1,
    "element_selector": "…",
    "x_pct": 0.75,
    "y_pct": 0.1,
    "created_at": "…",
    "replies": [
      {
        "id": "xyz",
        "email": "bob@co.com",
        "comment": "Confirmed, I see it too",
        "created_at": "…"
      }
    ]
  }
]
```

`order` is assigned only to top-level pins (1-based index of non-reply rows).

### `POST /api/comments`

Accepts an optional `parentId` field. Behaviour:

- **No `parentId`**: identical to today — inserts a top-level pin
- **With `parentId`**: validates the parent exists and belongs to the same `prototypeId`, inserts a reply row (`parent_id` set, `type = 'reply'`, position/selector fields `NULL`)

Returns `{ ok: true, id }` in both cases.

Validation errors:
- `400` if `comment` is empty
- `404` if `parentId` is provided but the parent row does not exist
- `400` if `parentId` references a reply (no nesting beyond one level)

### `DELETE /api/comments/:id`

Unchanged. Cascade handles reply cleanup when a parent is deleted.

No new routes.

---

## 3. `public/sdk/feedback.js` — Pin popover

### Styles added

```
.fb-popover__replies       — reply thread container, border-top divider
.fb-popover__reply         — single reply row
.fb-popover__reply-email   — semi-bold purple, same style as existing email
.fb-popover__reply-body    — normal weight, dark
.fb-popover__reply-date    — grey 11px
.fb-reply-form             — reply textarea + button row
.fb-reply-input            — single-line textarea, same focus style as draft card
.fb-reply-btn              — small primary button, disabled when empty
```

### Popover render change (`renderPinEl`)

After the existing comment body + meta + actions block, append:

1. A `<div class="fb-popover__replies">` containing one `fb-popover__reply` per `pin.replies` entry (if any)
2. A `<div class="fb-reply-form">` with a textarea and "Reply" button — always shown, available to any authenticated reviewer

### Reply submission

On "Reply" click:
1. Call `POST /api/comments` with `{ prototypeId, email: EMAIL, parentId: pin.id, type: 'reply', comment: text }`
2. On success: call `loadPins()`, keep the popover open (re-render it with the new reply included), show toast "Reply posted."
3. On failure: show error toast, re-enable button

The popover stays pinned open during the async call (button shows "Posting…").

### Edit window

The 5-minute edit/delete window applies only to top-level pins. Reply rows have no edit action — only delete (within 5 minutes, same logic, same `canEdit` check).

---

## 4. `public/sdk/preview.js` — Read-only tooltip

### Layout change

After the existing email + comment + date block, if `c.replies.length > 0`:

1. Add a thin divider
2. Render a compact reply list: each entry shows `<email> · <comment> · <date>`

No reply input — preview.js is for read-only stakeholder access.

### Data change

`preview.js` reads `comments` from the injected `data-comments` attribute (server-rendered JSON). The server-side injection in `src/services/inject.js` already serialises the full comments array; it will now include the `replies` array per pin.

---

## 5. Admin panel — `src/views/admin-prototype-detail.html`

### Comments tab

- The `loadComments` fetch hits the existing admin endpoint (`POST /admin/prototypes/:id/comments`) which queries the `comments` table directly. That query is extended to also fetch replies for the returned page of comments (a second query or a join).
- Each parent row in the table gains a **"N replies"** badge in the Comment cell when `replies.length > 0`
- Clicking the parent row toggles inline reply sub-rows (expanded by default if the page loads with replies present)
- Reply sub-rows: indented with `padding-left: 32px` and a `3px solid hsl(252,83%,57%)` left border, showing email / reply text / date / Delete button
- `stat-comments` count includes reply rows

### Admin delete

The existing per-row Delete button on a parent deletes the pin and cascades to replies (no change needed). The per-reply Delete button calls `DELETE /api/comments/:replyId` directly.

---

## 6. Files changed

| File | Change |
|------|--------|
| `src/db.js` | `ALTER TABLE comments ADD COLUMN IF NOT EXISTS parent_id …` + widen `type` check |
| `src/routes/api.js` | `GET` groups replies; `POST` handles `parentId` |
| `src/routes/admin.js` | Comments query includes replies |
| `public/sdk/feedback.js` | Reply thread + reply form in popover |
| `public/sdk/preview.js` | Read-only reply thread in tooltip |
| `src/views/admin-prototype-detail.html` | Reply sub-rows in Comments tab |
| `src/services/inject.js` | Pass `replies` array through to preview script (if not already serialised) |

---

## 7. Out of scope

- Reply threading beyond one level (no replies-to-replies)
- Notifications / email on new reply
- Reactions or emoji on replies
- Reply tags or pin placement
