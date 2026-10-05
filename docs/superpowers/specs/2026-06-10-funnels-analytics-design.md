# Funnels Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Funnels tab to the prototype admin detail page that shows page visit sequences, conversion drop-off, session journeys, and time-on-page — giving admins visibility into what path users took through a prototype before (or without) leaving a comment.

**Architecture:** Navigation events are captured in `feedback.js` via pushState/popstate/hashchange interception and sent to a new `POST /api/nav` endpoint. They are stored in a `nav_events` SQLite table. Session stitching (grouping events by email within a 30-minute gap) happens at query time in the admin route. The Funnels tab renders three panels computed server-side.

**Tech Stack:** Node.js/Express, better-sqlite3, vanilla JS, existing server-side HTML template system.

---

## Data Model

### New table: `nav_events`

```sql
CREATE TABLE IF NOT EXISTS nav_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  prototype_id TEXT NOT NULL,
  email        TEXT NOT NULL,
  page_url     TEXT NOT NULL,
  occurred_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nav_events_proto ON nav_events(prototype_id, occurred_at);
```

No session ID column. Sessions are derived at query time by splitting on 30-minute gaps between consecutive events per `(prototype_id, email)`.

### Existing `comments` table

The `breadcrumb` column (already in schema, stored as JSON) will be populated by `feedback.js` when posting a comment — it will contain the current session's page sequence at comment time. This connects the micro view (per-comment path) to the macro funnel.

---

## API

### `POST /api/nav`

Inserts one navigation event. Called by `feedback.js` on every distinct page change.

**Request body:**
```json
{ "prototypeId": "abc123", "email": "user@example.com", "pageUrl": "/dashboard" }
```

**Validation:**
- `prototypeId` and `pageUrl` are required; if missing return `400`
- `email` defaults to `"local@test.com"` if absent (consistent with comment endpoint)
- `pageUrl` is truncated to 500 characters

**Response:** `201 { "ok": true }`

### `GET /admin/prototypes/:id/funnels`

Returns pre-computed funnel data as JSON. Called by the Funnels tab on load.

**Response shape:**
```json
{
  "funnel": [
    { "page": "/home", "sessions": 12, "pct": 100, "dropPct": 0 }
  ],
  "journeys": [
    {
      "email": "user@example.com",
      "startedAt": "2026-06-10T09:00:00Z",
      "pages": ["/home", "/pricing", "/features"],
      "hadComment": true
    }
  ],
  "timeOnPage": [
    { "page": "/home", "medianMs": 12400, "visits": 9 }
  ]
}
```

---

## `feedback.js` — Navigation Interceptor

Added to the boot section, after the RAF loop starts.

**Behaviour:**
1. Record the initial page on load: `normalizeUrl(location)` → send to `/api/nav`.
2. Patch `history.pushState` and `history.replaceState` to fire a custom `fb-nav` event after the original call.
3. Listen for `popstate`, `hashchange`, and `fb-nav` events.
4. On each event, compute `normalizeUrl(location)` — whichever of `location.pathname` or `location.hash` changed from the previous value.
5. If the new URL equals the last recorded URL, skip (dedup).
6. Send `POST /api/nav` (fire-and-forget, no await blocking the UI).
7. Update the in-memory `navHistory` array (used to populate `breadcrumb` when posting a comment).

**URL normalisation:**
- If `location.hash` is non-empty and changed → use the hash value (strips leading `#`).
- Otherwise use `location.pathname + location.search`.
- Trim to 500 characters.

**Breadcrumb population:**
When submitting a comment via the draft card, include `breadcrumb: navHistory` in the POST body. The existing `breadcrumb` column in `comments` stores it as JSON. This is already wired in the API endpoint — just needs the client to send the value.

---

## Session Stitching Algorithm

Runs in `GET /admin/prototypes/:id/funnels`.

```
events = SELECT * FROM nav_events WHERE prototype_id = ? ORDER BY email, occurred_at ASC

sessions = []
current = null
GAP = 30 * 60 * 1000  (30 minutes in ms)

for each event:
  if current is null
  or event.email != current.email
  or (event.occurred_at - current.lastAt) > GAP:
    start new session { email, startedAt: event.occurred_at, events: [] }
    push to sessions
    current = new session
  current.events.push(event.page_url)
  current.lastAt = event.occurred_at

for each session:
  deduplicate consecutive identical pages
  (keep distinct ordered sequence, not unique set)
```

---

## Admin UI — Funnels Tab

### Tab button (added to `.tabs` bar)

```html
<button class="tab" data-tab="funnels">Funnels</button>
```

### Tab panel structure

```html
<div class="tab-panel" id="tab-funnels">
  <div id="funnels-loading" style="padding:40px;text-align:center;color:…">Loading…</div>
  <div id="funnels-content" style="display:none">
    <!-- Panel 1: Page Funnel -->
    <div class="funnels-section" id="funnel-panel">…</div>
    <!-- Panel 2: Session Journeys -->
    <div class="funnels-section" id="journeys-panel">…</div>
    <!-- Panel 3: Time on Page -->
    <div class="funnels-section" id="time-panel">…</div>
  </div>
</div>
```

### Panel 1 — Page Funnel

Table with columns: Page, Sessions, % of total, Drop-off.

- Pages ordered by median position across sessions (page most commonly visited first gets rank 1).
- Drop-off % = `(prev.sessions - curr.sessions) / prev.sessions * 100`, shown in red if > 30%.
- "Sessions" heading toggles between session count and unique-email count (client-side toggle, no re-fetch).

### Panel 2 — Session Journeys

One row per session (max 50, most recent first):

```
user@example.com  Jun 10 09:00    /home → /pricing → /features 📌
```

- Pages shown as inline code badges connected by `→`.
- Pin emoji (📌) if any comment was left during that session (cross-referenced with `comments` table by email + time window).
- Sessions with a single page visit are included (not filtered out).

### Panel 3 — Time on Page

Table: Page | Median time | Visits.

- Time shown as `1m 02s` format.
- Only pages with ≥ 2 visits shown (single-visit pages have no reliable time).
- Final page of each session excluded from time calculation (no end event).
- Sessions where any gap > 4 hours are not capped — the individual inter-page interval is capped at 4h instead, so partial session data is retained.

### Loading behaviour

Funnels data is fetched lazily — only when the Funnels tab is first clicked. A loading spinner shows until the fetch resolves. If `nav_events` is empty, each panel shows an empty state: "No navigation data yet. Share the prototype link to start collecting sessions."

---

## Files Modified

| File | Change |
|------|--------|
| `src/db.js` | Add `nav_events` table + index creation; add migration guard |
| `public/sdk/feedback.js` | Add nav interceptor, `navHistory` array, breadcrumb wiring |
| `src/routes/api.js` | Add `POST /api/nav` endpoint |
| `src/routes/admin.js` | Add `GET /admin/prototypes/:id/funnels` route with session stitching |
| `src/views/admin-prototype-detail.html` | Add Funnels tab button, panel HTML, fetch + render JS |

No new files.

---

## Edge Cases

- **Prototype not using a JS router** (static single page): only one nav event per session is recorded (the initial load). Funnel has one row, journeys show single-page sessions. This is correct and useful.
- **Very fast navigation** (user clicks back/forward rapidly): dedup on the client prevents duplicate consecutive entries. Server does no dedup.
- **Email unknown**: defaults to `local@test.com` — all local sessions are grouped together. Acceptable for local dev use.
- **nav_events table missing on old DB**: migration guard in `initDb()` creates it on next server start.
