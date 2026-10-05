# Explain Mode Design

## Overview

A fourth viewer mode — **Explain** — added to the existing View / Comment / Review toolbar in ProtoLab. Admins attach free-form explanations (user stories, Gherkin, notes) to individual elements in a prototype. Any viewer can switch to Explain mode and hover elements to read those explanations.

---

## Toolbar & Mode

- A fourth button `Explain` is added to the mode switcher in `public/sdk/feedback.js`, after Review.
- Active style: amber/yellow (`hsl(38,92%,50%)`) to visually distinguish it from the purple Comment mode.
- When Explain mode is active, a banner appears below the toolbar: *"Hover any element to see its explanation · Click to add or edit"*
- Pressing Esc exits back to View mode.
- No role gating yet — all users see the Explain button and can add/edit explanations. Role-based write restriction is deferred.

---

## Data Model

### New table: `explanations`

```sql
CREATE TABLE IF NOT EXISTS explanations (
  id                TEXT PRIMARY KEY,
  prototype_id      TEXT NOT NULL,
  element_selector  TEXT NOT NULL,
  x_pct             REAL,
  y_pct             REAL,
  page_url          TEXT,
  body              TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  FOREIGN KEY (prototype_id) REFERENCES prototypes(id) ON DELETE CASCADE
);

-- Unique index uses COALESCE so that two rows with the same selector and NULL page_url
-- are correctly treated as duplicates (SQLite UNIQUE treats NULLs as distinct).
CREATE UNIQUE INDEX IF NOT EXISTS idx_explanations_unique
  ON explanations(prototype_id, element_selector, COALESCE(page_url, ''));
```

- One row per element per prototype per page. The `(prototype_id, element_selector, page_url)` triple is unique — clicking an already-explained element opens an edit flow, not a new row.
- `body` stores free-form text; line breaks and paragraphs are preserved (`white-space: pre-wrap` on display).
- `x_pct` / `y_pct` store the click position within the element (same convention as comments), used to position the marker.

### DB migration

`db.js` checks for the `explanations` table on startup and creates it if absent (same pattern as existing column migrations).

---

## API

All endpoints live under `/api/explanations`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/explanations/:prototypeId` | session cookie (customer or admin) | Return all explanations for the prototype |
| POST | `/api/explanations` | session cookie | Create a new explanation |
| PATCH | `/api/explanations/:id` | session cookie | Update body |
| DELETE | `/api/explanations/:id` | session cookie | Delete |

**GET response shape:**
```json
[
  {
    "id": "abc123",
    "element_selector": "#cta-button",
    "x_pct": 0.5,
    "y_pct": 0.5,
    "page_url": "/",
    "body": "As a user I want to...",
    "created_at": "2026-06-10T12:00:00.000Z",
    "updated_at": "2026-06-10T12:00:00.000Z"
  }
]
```

**POST body:**
```json
{
  "prototypeId": "...",
  "elementSelector": "#cta-button",
  "xPct": 0.5,
  "yPct": 0.5,
  "pageUrl": "/",
  "body": "Free-form text"
}
```

**PATCH body:** `{ "body": "Updated text" }`

---

## SDK Behaviour (`public/sdk/feedback.js`)

### Boot

`loadExplanations()` is called on boot alongside `loadPins()`. It fetches `GET /api/explanations/:protoId` and stores results in an `explanations` array (parallel to `pins`).

### Markers

- In Explain mode, the existing RAF loop (`recomputePositions`) also computes positions for explain markers.
- Each explained element gets a small amber circle marker (≈18px) with an `ℹ` glyph, positioned at the top-right corner of the element's bounding rect (not at the click x/y — the marker is always at the corner for predictability).
- Markers use a separate DOM layer `#__fb-explains` (parallel to `#__fb-pins`) so they never interfere with comment pins.
- Markers are only rendered when mode is `explain`.

### Hover (read)

- Hovering the marker **or** the element itself (when in Explain mode, and only if that element has an explanation) shows a popover:
  - Amber header strip with `ℹ` icon
  - Body text with `white-space: pre-wrap`
  - No edit controls on hover — click opens the edit card
- Popover hides on mouseleave (same pattern as comment popovers).

### Click (write)

- Clicking any element in Explain mode opens `#__fb-explain-card` (a card in the same style as `#__fb-draft-card`):
  - Title: **"Add explanation"** (no existing explanation) or **"Edit explanation"** (existing)
  - Textarea pre-filled with current body (empty for new)
  - **Save** button (disabled until textarea has content)
  - **Cancel** button
  - **Delete** button (only shown when editing an existing explanation)
- On Save:
  - If new: POST `/api/explanations`, add to local `explanations` array, re-render markers
  - If existing: PATCH `/api/explanations/:id`, update local array, re-render markers
- On Delete: DELETE `/api/explanations/:id`, remove from local array, re-render markers, show toast

### Mode isolation

- Explain markers are only visible in Explain mode — `renderExplainLayer()` returns early if mode !== `explain`.
- Comment pins are hidden when mode is `explain` (and vice versa for explain markers in comment/view mode).

---

## Admin Detail Page (`src/views/admin-prototype-detail.html`)

A new **Explanations** tab is added alongside the existing Comments tab.

### Tab content

A table listing all explanations for the prototype:

| Selector | Explanation (truncated to 80 chars) | Page | Actions |
|----------|--------------------------------------|------|---------|
| `#cta-button` | "As a user I want to click..." | `/` | Edit · Delete |

- **Edit**: expands an inline edit form below the row (textarea + Save button)
- **Delete**: uses the existing confirm modal (`showModal(...)`)
- Empty state: "No explanations yet. Open the prototype in Explain mode to add some."

### Data loading

The detail page template already receives prototype data server-side. Explanations are fetched client-side via `GET /api/explanations/:protoId` on tab activation (lazy load, same pattern as the funnels tab).

---

## Files Changed

| File | Change |
|------|--------|
| `src/db.js` | Add `explanations` table creation + migration guard |
| `src/routes/api.js` | Add GET/POST/PATCH/DELETE `/api/explanations` routes |
| `public/sdk/feedback.js` | Add Explain mode button, `loadExplanations()`, marker layer, hover popover, edit card |
| `src/views/admin-prototype-detail.html` | Add Explanations tab with management table |

---

## Out of Scope (deferred)

- Role-based write restriction (admin-only editing) — no roles exist yet; deferred
- Bulk import from spec file (`.feature`, markdown) — separate feature
- Explain markers visible in Comment/View/Review modes — markers only show in Explain mode
