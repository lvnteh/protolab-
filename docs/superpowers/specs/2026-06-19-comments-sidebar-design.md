# Comments Sidebar Design

**Date:** 2026-06-19
**Status:** Approved

---

## Summary

Add a collapseable sidebar to the right of the prototype viewer that lists existing pins (Pins tab) and allows general comments (General tab). Clicking a pin row in the sidebar navigates to it on the canvas and opens its popover. The sidebar lives entirely in `feedback.js` — no API, schema, or server changes required.

---

## 1. Sidebar Structure & State

### Layout

A fixed-position panel on the right edge of the viewport, below the 44px toolbar:

```
position: fixed
top: 44px
right: 0
height: calc(100vh - 44px)
z-index: 2147483644  (below toolbar/draft card, above pins)
```

Two states:

| State | Width | Body padding-right |
|-------|-------|--------------------|
| Expanded | 260px | 260px |
| Collapsed | 32px | 32px |

`document.body` gets `padding-right` set to whichever applies, updated on toggle. The existing `padding-top: 44px` (set by the toolbar) is unchanged.

### Collapsed strip

The 32px collapsed strip shows (top to bottom):
- `‹` chevron to expand
- Total comment count badge (pins + general combined), purple background
- Rotated "Comments" label in grey

### Toggle

A `›` / `‹` button in the top-right corner of the tab header row toggles between expanded and collapsed. State persists in `localStorage` keyed by `__fb_sidebar_${PROTO_ID}`.

### Auto-open behaviour

On load, after `loadPins()` completes:
- If there are any element-type or general-type comments → start expanded
- Otherwise → start collapsed

This overrides the `localStorage` value only on first load when comments are present and the stored state is collapsed. Subsequent toggles respect `localStorage`.

---

## 2. Pins Tab

### Content

Lists all element-type comments for the **current page** (same `page_url` filtering as `recomputePositions()`). Re-renders whenever `loadPins()` completes or the page URL changes.

Each row:
- Numbered colored pin dot (22×22px, same color as canvas pin for that tag)
- Email (truncated, `text-overflow: ellipsis`)
- Tag badge (colored, same style as `.fb-popover__tag`)
- Comment text (2-line clamp via `-webkit-line-clamp: 2`)
- Reply count line if `pin.replies.length > 0`: "N repl{y|ies}" in grey 10px

Empty state: grey centered text "No pins on this page yet."

### Click behaviour

Clicking a row:
1. If mode is `comment` or `explain`, calls `setMode('view')` first
2. Calls `focusPin(pin.id)` — scrolls and pulses the pin
3. After a 50ms delay (to allow scroll to settle), simulates a click on the pin's DOM element (`pinElements[pin.id].click()`) which triggers the existing pinned-popover logic inside `renderPinEl`

`showPopover` is a closure scoped inside `renderPinEl` and is not directly accessible. Dispatching a synthetic click on the pin DOM element is the correct way to open it — this reuses the existing click handler that sets `pinned = true` and calls `showPopover()`.

---

## 3. General Tab

### Content

Lists all `type: 'general'` comments, ordered oldest-first. Each entry shows:
- Email (bold, purple)
- Comment text
- Date (`toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })`)

Empty state: grey centered text "No general comments yet."

### Input

A persistent textarea + "Post comment" button always visible at the bottom of the sidebar (above the bottom edge, below the list). No tag selector — general comments are tag-free.

Submit behaviour:
1. Disable button, set text to "Posting…"
2. `POST /api/comments` with `{ prototypeId: PROTO_ID, email: EMAIL, type: 'general', comment: text }`
3. On success: clear textarea, call `loadPins()` to refresh both tabs
4. On error: show existing `showToast('Failed to post comment.', true)`, re-enable button

---

## 4. Data Layer Changes in `feedback.js`

`loadPins()` currently stores only element-type comments in `pins`. After this change:

- `pins` — unchanged, contains only element-type rows (used by canvas pin layer)
- `generalComments` — new array, contains only `type: 'general'` rows from the same fetch response

Both are populated from the single existing `GET /api/comments/:protoId` response. No new fetch.

The existing `GET /api/comments/:protoId` already returns all comment types including `type: 'general'`. The sidebar renders `generalComments` in the General tab.

---

## 5. CSS

All new CSS added to the `STYLE` constant in `feedback.js` under the existing `/* ── styles ── */` section. Prefix: `fb-sidebar` for all new classes.

Key classes:

```
#__fb-sidebar          — outer container, fixed positioning
#__fb-sidebar-tabs     — tab header row
.fb-sidebar-tab        — individual tab button
.fb-sidebar-tab.active — active tab (purple underline)
#__fb-sidebar-pins     — pins tab content panel
#__fb-sidebar-general  — general tab content panel
.fb-sidebar-pin-row    — clickable pin list item
.fb-sidebar-pin-dot    — colored numbered circle
.fb-sidebar-gen-item   — general comment entry
#__fb-sidebar-gen-input — general comment textarea
#__fb-sidebar-gen-submit — post button
#__fb-sidebar-collapse — collapse/expand chevron button
#__fb-sidebar-badge    — comment count badge on collapsed strip
```

---

## 6. Interaction with Existing Modes

| Mode | Sidebar visible? | Sidebar behaviour |
|------|-----------------|-------------------|
| view | Yes | Normal |
| comment | Yes | Clicking a pin row exits comment mode, navigates to pin |
| review | Yes | Pin rows navigate normally; general comment input remains functional |
| explain | Yes | Clicking a pin row exits explain mode, navigates to pin |

The sidebar is always rendered regardless of toolbar mode. It does not hide or dim in any mode.

---

## 7. Files Changed

| File | Change |
|------|--------|
| `public/sdk/feedback.js` | Add `#__fb-sidebar` HTML + CSS, `generalComments` state, sidebar render functions, pin-row click handler, general comment submit, `loadPins()` split, `localStorage` collapse state, `body` padding-right management |

No other files change. No new API routes. No schema migrations.

---

## 8. Out of Scope

- Sidebar in `preview.js` (admin read-only preview) — not included in this spec
- Filtering pins by tag or reviewer in the sidebar
- Sorting controls
- Sidebar on mobile / responsive behaviour
- General comment replies (general comments are top-level only, same as today)
- Editing or deleting general comments from the sidebar
