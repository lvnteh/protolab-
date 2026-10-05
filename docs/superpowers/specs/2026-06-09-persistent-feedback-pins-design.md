# Persistent Feedback Pins Design

**Goal:** Replace the current ephemeral, orange selector-heavy feedback mode with persistent numbered pin markers that stick to annotated elements across reloads, and add an admin preview mode for reviewing feedback in prototype context.

**Architecture:** The SDK renders pins by fetching all existing comments on load and anchoring absolute-positioned dots to their target elements via `getBoundingClientRect()`. A separate read-only `preview.js` is injected for admin preview. No schema changes required.

**Tech Stack:** Vanilla JS (IIFE), Express 4, better-sqlite3, existing `__fb-` CSS prefix convention.

---

## 1. Persistent Pin Rendering (SDK)

### How pins are anchored

After init (and after each new comment submission), the SDK calls `GET /api/comments/:prototypeId` to fetch all element-type comments. For each comment, it runs `document.querySelector(element_selector)` to find the target element. If found, it places a pin at the element's top-right corner using:

```js
const rect = el.getBoundingClientRect();
pin.style.left = (rect.right + window.scrollX - 11) + 'px';
pin.style.top  = (rect.top  + window.scrollY - 11) + 'px';
```

All pins live in a single `position:absolute; top:0; left:0; pointer-events:none; z-index:2147483639` container div appended to `document.body`. They sit below the feedback panel (`z-index: 2147483647`) so they never obstruct the UI.

### Pin style (option C selected)

- 22×22px filled blue (`#0052cc`) circle, white number, `box-shadow: 0 2px 6px rgba(0,82,204,0.4)`
- `pointer-events: auto` on individual pins (so they're clickable despite container being pointer-events:none)
- Multiple pins on the same element spread horizontally: each additional pin is offset 26px to the left from the previous one

### Pin repositioning

A single `requestAnimationFrame` loop (only active when the page has any pins) calls a `repositionPins()` function that re-reads `getBoundingClientRect()` for each anchored element and updates pin positions. This handles scroll, resize, and any layout shifts.

### Pin tooltip

Clicking a pin shows a small tooltip (not a modal) anchored above the pin:
- Commenter email (bold)
- Comment text
- Submission date (e.g. "9 Jun 2026")
- No actions — read-only

Clicking anywhere else dismisses the tooltip. Only one tooltip visible at a time.

### Selector fallback

If `document.querySelector(element_selector)` throws or returns null (element no longer in DOM), the pin is silently skipped — no error, no orphaned dot.

---

## 2. Simplified Feedback UI

### Removed entirely
- Orange overlay tint (`#__fb-overlay`, `rgba(255,136,68,0.06)` background)
- Orange hover outlines (`body.__fb-mode *:hover { outline: 2px solid rgba(255,136,68,0.8) }`)
- Breadcrumb journey display in the popup
- `__fb-popup-title` ("Annotating: X") header in the popup
- "Leave feedback" label in the bottom bar

### Bottom bar (simplified)
- Textarea + "Submit" button + pin-mode toggle (labelled "Pin Mode")
- No leading label element

### Element popup (simplified)
- Just: textarea + Post/Cancel buttons
- Border colour: `#0052cc` (blue, not orange)
- No element label, no journey breadcrumb

### Pin mode cursor
- `cursor: crosshair` on `body.__fb-mode *` (kept)
- No hover outlines

---

## 3. Admin Preview Mode

### Route
`GET /admin/prototypes/:id/preview` — protected by `adminAuth` middleware.

Reads the prototype file from `config.uploadsPath`, injects `preview.js` via `injectPreview(html, protoId)` (parallel to existing `injectSdk`), and serves the result.

Optional query param `?comment=<commentId>` — passed as a `data-highlight-comment` attribute on the script tag.

### `preview.js` behaviour
- On load: reads pin data from a `data-comments` attribute on the script tag (JSON-encoded array embedded by the server at inject time — avoids needing a customer session from within admin preview)
- No bottom bar, no popup, no toggle, no submit UI
- If `data-highlight-comment` is set: after pins render, finds that pin, adds a `__fb-pin--highlight` CSS class (keyframe pulse animation: scale 1→1.4→1 over 0.6s, repeated 3×), and calls `pin.scrollIntoView({ behavior: 'smooth', block: 'center' })`
- `pointer-events: auto` on pins — clicking still shows the tooltip

### `injectPreview` function
Added to `src/services/inject.js` alongside `injectSdk`. Same `lastIndexOf('</body>')` injection strategy. Injects:
```html
<script src="/sdk/preview.js"
  data-proto-id="PROTO_ID"
  data-highlight-comment="COMMENT_ID_OR_EMPTY"
  data-comments="[{&quot;id&quot;:&quot;abc&quot;,...}]"></script>
```

The `data-comments` attribute contains the JSON-encoded array of all element-type comments for the prototype, embedded by `injectPreview` at serve time. This means `preview.js` makes no API calls and works without a customer session.

### Admin comments table
- "View in prototype" button added to each row — only rendered for `type === 'element'` rows
- Links to `/admin/prototypes/:id/preview?comment=<commentId>`, opens in new tab (`target="_blank"`)
- Button style: same `.btn-secondary` class used elsewhere in the admin UI

---

## 4. API

### New: `GET /api/comments/:prototypeId`

Added to `src/routes/api.js`. Requires `customerAuth` (valid session for that prototype).

Response:
```json
[
  {
    "id": "abc123",
    "email": "user@example.com",
    "element_selector": "#hero-button",
    "element_label": "Get Started",
    "comment": "This CTA is confusing",
    "created_at": "2026-06-09T10:00:00.000Z",
    "order": 1
  }
]
```

Only returns `type = 'element'` comments (general comments have no pin). Ordered by `created_at ASC` so order numbers are stable. The `order` field is the 1-based row number.

### Existing unchanged
- `POST /api/comments` — no changes
- `POST /admin/prototypes/:id/comments` — no changes (admin table still uses this)

---

## 5. Files Changed

| File | Change |
|------|--------|
| `public/sdk/feedback.js` | Remove orange UI, add pin rendering + RAF loop + tooltip, simplify bottom bar and popup |
| `public/sdk/preview.js` | New file — read-only pin viewer with highlight support |
| `src/routes/api.js` | Add `GET /api/comments/:prototypeId` |
| `src/routes/admin.js` | Add `GET /admin/prototypes/:id/preview` route |
| `src/services/inject.js` | Add `injectPreview(html, protoId, commentId)` |
| `src/views/admin-prototype-detail.html` | Add "View in prototype" button to element-type comment rows |

---

## 6. Out of Scope

- General comments do not get pins (no element anchor)
- No pin editing or deletion from within the prototype view
- No pin visibility toggle for end users
- Admin preview pins are read-only — no new comments can be submitted from preview mode
