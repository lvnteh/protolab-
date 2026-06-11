# ProtoLab — Product Specification

> Reverse-engineered from live codebase. Last updated: 2026-06-11.

---

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [Vocabulary & Domain Model](#2-vocabulary--domain-model)
3. [Data Model](#3-data-model)
4. [User Roles & Authentication](#4-user-roles--authentication)
5. [Features & User Stories](#5-features--user-stories)
6. [Gherkin Scenarios](#6-gherkin-scenarios)
7. [API Reference](#7-api-reference)
8. [SDK Reference](#8-sdk-reference)
9. [Business Rules](#9-business-rules)

---

## 1. Product Overview

**ProtoLab** is a self-hosted web app that lets a team share interactive HTML prototypes with stakeholders — customers, org members, or internal reviewers — and collect structured feedback directly on the prototype.

**Core value proposition:**
- Emailing HTML files is broken. ProtoLab hosts them, gates access by email, and wraps them in a feedback toolbar so reviewers can leave pinned comments on specific elements without leaving the prototype.

**Primary users:**
- **Admin** — product designer or PM who uploads prototypes and manages access
- **Reviewer** — customer, stakeholder, or team member who reviews and comments

---

## 2. Vocabulary & Domain Model

| Term | Definition |
|------|-----------|
| **Prototype** | A self-contained HTML file uploaded by an admin representing a UI to be reviewed |
| **Share Token** | A unique random token in the URL that identifies a prototype for public access (e.g. `/p/abc123`) |
| **Allowlist** | The set of email addresses permitted to view a specific prototype |
| **Reviewer** | A person who accesses a prototype via share link after entering their email |
| **Comment** | Feedback left by a reviewer, either pinned to a specific element or general |
| **Pin** | A numbered visual marker overlaid on a prototype element, representing a comment |
| **Explanation** | Admin-authored annotation attached to an element, visible in Explain mode |
| **Tag** | A category label on a comment: `bug`, `copy`, `question`, `idea`, or `other` |
| **Toolbar** | The fixed UI bar injected at the top of a prototype, providing mode controls |
| **Mode** | The current interaction state of the toolbar: View, Comment, Review, or Explain |
| **Nav Event** | A recorded page navigation within a prototype (supports SPA routing) |
| **Funnel** | An analytics view showing how reviewers moved through the prototype pages |
| **Session** | A reviewer's continuous journey through prototype pages starting from the root page |
| **Edit Window** | The 5-minute grace period after posting a comment during which the commenter can edit or delete it |
| **CSS Selector** | The programmatically generated identifier for the DOM element a pin is attached to |
| **x_pct / y_pct** | Fractional position (0–1) within the element's bounding box where the pin was placed |

---

## 3. Data Model

### prototypes
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | 12-char nanoid |
| name | TEXT | Human-readable name set by admin |
| filename | TEXT | Stored filename on disk (`{id}.html`) |
| share_token | TEXT UNIQUE | 12-char nanoid used in public URLs |
| created_at | TEXT | ISO 8601 timestamp |

### allowlist
| Column | Type | Notes |
|--------|------|-------|
| prototype_id | TEXT FK → prototypes.id | Cascades on delete |
| email | TEXT | Lowercase, trimmed |
| PK | (prototype_id, email) | |

### access_log
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| prototype_id | TEXT | |
| email | TEXT | |
| opened_at | TEXT | ISO 8601 timestamp |
| user_agent | TEXT | Raw browser user-agent string |

### comments
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | 12-char nanoid |
| prototype_id | TEXT | |
| email | TEXT | Reviewer's email |
| type | TEXT | CHECK: 'general' or 'element' |
| element_selector | TEXT | CSS selector (null for general) |
| element_label | TEXT | Human-readable element label |
| element_tag | TEXT | HTML tag name |
| breadcrumb | TEXT | JSON array of ancestor selector path |
| comment | TEXT | Comment body |
| page_url | TEXT | URL where comment was made |
| created_at | TEXT | ISO 8601 timestamp |
| tag | TEXT | One of: bug, copy, question, idea, other (nullable) |
| x_pct | REAL | X position within element (0–1) |
| y_pct | REAL | Y position within element (0–1) |

### nav_events
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| prototype_id | TEXT | |
| email | TEXT | |
| page_url | TEXT | Max 500 chars |
| occurred_at | TEXT | ISO 8601 timestamp |
| INDEX | (prototype_id, email, occurred_at) | For funnel queries |

### explanations
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | 12-char nanoid |
| prototype_id | TEXT FK → prototypes.id | Cascades on delete |
| element_selector | TEXT | CSS selector |
| x_pct | REAL | X position within element (0–1) |
| y_pct | REAL | Y position within element (0–1) |
| page_url | TEXT | Scope to page (null = all pages) |
| body | TEXT | Explanation content |
| created_at | TEXT | ISO 8601 timestamp |
| updated_at | TEXT | ISO 8601 timestamp |
| UNIQUE | (prototype_id, element_selector, COALESCE(page_url, '')) | One explanation per element per page |

---

## 4. User Roles & Authentication

### Admin
- Single user configured via environment variables (`ADMIN_USER`, `ADMIN_PASSWORD_HASH`)
- Password is bcrypt-hashed
- Session set via `POST /admin/login`; `session.isAdmin = true`
- Has access to all admin routes

### Reviewer
- No account required; identified by email address
- Must enter email at the share link entry page
- Email is checked case-insensitively against the prototype's allowlist
- Session set on successful entry; `session.customerEmail` and `session.prototypeId` stored
- Access is per-prototype — entering one prototype's email does not grant access to others

---

## 5. Features & User Stories

### F1 — Prototype Upload

**Description:** An admin uploads a self-contained HTML file and assigns a name and an email allowlist. The system stores the file, generates a unique share link, and makes it accessible.

**User Story:**
> As an admin, I want to upload an HTML prototype and specify who can view it, so that I can share it with specific reviewers without exposing it to anyone else.

**Acceptance Criteria:**
- Admin can upload `.html` files only
- Admin must provide a name for the prototype
- Admin can optionally add an email allowlist (one email per line)
- System generates a unique share link after upload
- Share link is copyable from the prototype list
- Prototype appears in the admin list with 0 views, 0 comments

---

### F2 — Email-Gated Access

**Description:** Reviewers access a prototype via share link and must enter their email. If the email is on the allowlist, they are granted a session. If not, they are shown an access denied page.

**User Story:**
> As an admin, I want only the people I've invited to be able to view the prototype, so that confidential designs aren't accessible to anyone with the link.

**Acceptance Criteria:**
- Share link shows an email entry form, not the prototype directly
- Email matching is case-insensitive
- Correct email grants access and records the reviewer's session
- Incorrect email shows an "Access Denied" page
- Session is scoped to the specific prototype

---

### F3 — Prototype Viewing with SDK Toolbar

**Description:** Authorized reviewers see the prototype with a 44px toolbar injected at the top providing mode controls.

**User Story:**
> As a reviewer, I want to view the prototype in its original state without any distractions, so that I can evaluate it as intended.

**Acceptance Criteria:**
- Prototype HTML renders faithfully with toolbar above it
- Toolbar shows: prototype title, View / Comment / Review / Explain mode buttons
- Body is offset by 44px so toolbar does not overlap content
- Default mode on load is View
- Each view is logged with email and user-agent in access_log

---

### F4 — Comment Mode & Feedback Pins

**Description:** Reviewers switch to Comment mode, click any element to open a feedback card, optionally categorize the comment with a tag, and post it. A numbered pin appears anchored to the element.

**User Story:**
> As a reviewer, I want to click directly on a part of the prototype to leave a comment, so that my feedback is clearly tied to the specific element I'm referring to.

**Acceptance Criteria:**
- Comment mode activates crosshair cursor across the whole page
- Clicking any element opens a draft card on the right side
- Draft card shows: element selector, tag pills (bug/copy/question/idea/other), textarea, Post button
- Post is disabled until text is entered
- Submitted comment creates a numbered pin on the element
- Pin is colored by tag type
- Multiple pins on the same element cluster into a count bubble
- Clicking a cluster expands it radially
- Escape key closes draft card and exits Comment mode

---

### F5 — Pin Popovers & Edit Window

**Description:** Hovering or clicking a pin shows the comment details. The original commenter can edit or delete their comment within 5 minutes of posting.

**User Story:**
> As a reviewer, I want to correct or delete a comment I just posted, so that I don't leave incorrect feedback for the admin to review.

**Acceptance Criteria:**
- Hovering a pin shows a popover with: tag badge, comment body, email, date
- Clicking a pin pins the popover open; clicking outside closes it
- Within 5 minutes of posting, the commenter sees Edit and Delete buttons and a countdown timer
- Editing replaces the comment body in-place
- Deleting removes the pin immediately
- After 5 minutes, no edit or delete options appear

---

### F6 — Review Mode

**Description:** Reviewers can switch to Review mode to read the prototype without comment pins overlaid, approximating a clean viewing experience.

**User Story:**
> As a reviewer, I want to read through the prototype without pins in the way, so that I can evaluate the overall flow before diving into specific feedback.

**Acceptance Criteria:**
- Review mode hides all comment pins
- No interaction (clicking, hovering pins) is possible in Review mode
- Switching back to View mode restores all pins

---

### F7 — Explain Mode & Annotations

**Description:** Admins can annotate prototype elements with explanations (user stories, Gherkin, design rationale) that reviewers can read by hovering orange markers.

**User Story:**
> As an admin, I want to annotate specific elements with context and intent, so that reviewers understand what they're looking at before commenting.

**Acceptance Criteria:**
- Admin clicks an element in Explain mode to open the explain card
- Card shows "Add explanation" or "Edit explanation" depending on whether one exists
- Explanation text is saved and an orange ℹ marker appears on the element
- Hovering the marker shows a popover with the explanation text
- Only one explanation per element per page is allowed
- Explanations can be deleted via the explain card or the admin Explanations tab

---

### F8 — Navigation Tracking & Funnel Analytics

**Description:** Every page navigation within the prototype is recorded. Admins can view a page funnel showing drop-off, user journeys, and median time on each page.

**User Story:**
> As an admin, I want to understand how reviewers navigated through the prototype, so that I can identify where they got confused or dropped off.

**Acceptance Criteria:**
- Navigation events are recorded for hash changes, popstate, and SPA history.pushState
- Admin Funnels tab shows: Page Funnel (sessions per page, drop-off %), Session Journeys (last 50), Time on Page (median)
- "Unique visitors only" toggle filters to one session per email
- Session defined as: starts when user first arrives; new session when user returns to the root page
- Time-on-page is the median inter-navigation interval (max 4 hours per step)

---

### F9 — Admin Comment Management

**Description:** Admins can review, filter, paginate, and delete comments across all reviewers. They can also preview the prototype with pins shown in context.

**User Story:**
> As an admin, I want to see all the feedback my reviewers left in one place, so that I can triage and act on it efficiently.

**Acceptance Criteria:**
- Comments tab shows paginated table (25 per page) with: email, type, tag, element info, comment, date, actions
- Filter by type: All / General / Element
- Each row has "View on prototype" action that opens admin preview with the pin highlighted
- Admin can delete individual comments
- Admin can clear all comments for a prototype
- Access Log tab shows all views with email, timestamp, user-agent

---

### F10 — Prototype Settings Management

**Description:** Admins can rename a prototype and update its allowlist at any time. Deleting a prototype removes all associated data.

**User Story:**
> As an admin, I want to update who can see a prototype after I've already shared it, so that I can add new reviewers or revoke access without re-uploading.

**Acceptance Criteria:**
- Settings tab shows name field and allowlist textarea
- Saving replaces the entire allowlist (old emails not in new list are removed)
- Prototype can be deleted; deletion cascades to comments, allowlist, nav events, explanations
- Access log is preserved after prototype deletion (audit trail)

---

## 6. Gherkin Scenarios

### F1 — Prototype Upload

```gherkin
Feature: Prototype Upload

  Scenario: Admin uploads a valid prototype
    Given I am logged in as admin
    When I click "Upload Prototype"
    And I enter the name "Change Delegation v2"
    And I select a valid .html file
    And I enter emails "reviewer@sap.com" in the allowlist
    And I click "Upload & Generate Link"
    Then I see a success message with the share link
    And the prototype appears in the prototypes list
    And the view count is 0 and comment count is 0

  Scenario: Admin tries to upload without a file
    Given I am logged in as admin
    When I click "Upload Prototype"
    And I enter a name but no file
    And I click "Upload & Generate Link"
    Then I see the error "Please select an HTML file."

  Scenario: Admin tries to upload without a name
    Given I am logged in as admin
    When I click "Upload Prototype"
    And I select a file but enter no name
    And I click "Upload & Generate Link"
    Then I see the error "Please enter a name."
```

### F2 — Email-Gated Access

```gherkin
Feature: Email-Gated Access

  Scenario: Reviewer with valid email gains access
    Given a prototype exists with share token "abc123"
    And "reviewer@sap.com" is on the allowlist
    When I visit "/p/abc123"
    And I enter "reviewer@sap.com" and click Continue
    Then I am redirected to the prototype view
    And the prototype renders with the SDK toolbar

  Scenario: Email matching is case-insensitive
    Given "Reviewer@SAP.com" is on the allowlist
    When I enter "reviewer@sap.com" on the entry form
    Then I am granted access

  Scenario: Reviewer with invalid email is denied
    Given "reviewer@sap.com" is NOT on the allowlist
    When I enter "reviewer@sap.com" on the entry form
    Then I see the "Access Denied" page
    And I am not granted a session

  Scenario: Direct URL access without session is redirected
    Given I have no active session
    When I navigate directly to "/p/abc123/view"
    Then I am redirected to "/p/abc123"
```

### F4 — Comment Mode & Feedback Pins

```gherkin
Feature: Feedback Pins

  Scenario: Reviewer posts a comment on an element
    Given I am viewing a prototype in Comment mode
    When I click on a button element
    Then a draft card appears showing the element's CSS selector
    When I type "The label is unclear"
    And I click "Post comment"
    Then a numbered pin appears on the element
    And the draft card closes
    And I see a "Comment posted." toast

  Scenario: Reviewer tags a comment as a bug
    Given I am in Comment mode
    When I click an element and type a comment
    And I click the "Bug" tag pill
    And I click "Post comment"
    Then the pin is colored red
    And the comment has tag "bug"

  Scenario: Post button is disabled with empty comment
    Given I am in Comment mode and clicked an element
    When the textarea is empty
    Then the "Post comment" button is disabled

  Scenario: Pressing Escape closes draft card
    Given a draft card is open
    When I press Escape
    Then the draft card closes
    And I remain in Comment mode

  Scenario: Pressing Escape again exits Comment mode
    Given no draft card is open and mode is Comment
    When I press Escape
    Then the mode switches to View
```

### F5 — Edit Window

```gherkin
Feature: Comment Edit Window

  Scenario: Commenter edits within 5 minutes
    Given I posted a comment less than 5 minutes ago
    When I hover the pin
    Then I see an Edit button and a countdown timer
    When I click Edit and change the text
    And I click Save
    Then the comment is updated
    And the pin popover shows the new text

  Scenario: Commenter deletes within 5 minutes
    Given I posted a comment less than 5 minutes ago
    When I hover the pin and click Delete
    Then the pin is removed
    And I see a "Comment deleted." toast

  Scenario: Edit option absent after 5 minutes
    Given a comment was posted more than 5 minutes ago
    When I hover the pin
    Then I see only the comment text, email, and date — no Edit or Delete buttons

  Scenario: Only commenter can edit
    Given a comment was posted by "other@sap.com"
    And I am "me@sap.com"
    When I hover the pin
    Then I see no Edit or Delete buttons
```

### F7 — Explain Mode

```gherkin
Feature: Explain Mode

  Scenario: Admin adds an explanation to an element
    Given I am viewing a prototype in Explain mode
    When I click a navigation element
    Then an Explain card appears with "Add explanation"
    When I type "This nav triggers the delegation flow. Entry point for the main user journey."
    And I click Save
    Then an orange ℹ marker appears on the element
    And hovering the marker shows the explanation text

  Scenario: Admin edits an existing explanation
    Given an explanation exists on an element
    When I click the element in Explain mode
    Then the card shows "Edit explanation" with the current text pre-filled
    When I change the text and save
    Then the marker shows the updated explanation

  Scenario: Duplicate explanation rejected
    Given an explanation already exists for ".nav-btn" on page "/home"
    When I try to save a new explanation for ".nav-btn" on "/home"
    Then I see an error (409 conflict)

  Scenario: Admin deletes an explanation
    Given an explanation exists on an element
    When I click the element in Explain mode and click Delete
    Then the orange marker is removed
```

### F8 — Navigation Analytics

```gherkin
Feature: Funnel Analytics

  Scenario: Page funnel shows reviewer drop-off
    Given multiple reviewers have navigated through the prototype
    When I open the Funnels tab
    Then I see a table of pages ordered by visit frequency
    And each page shows session count and drop-off percentage

  Scenario: Journey shows a reviewer's full path
    Given a reviewer visited pages: /home → /delegation → /confirm
    When I view the Session Journeys section
    Then I see their journey as "home → delegation → confirm"
    And if they left a comment during the journey, a pin icon appears

  Scenario: Unique visitors toggle deduplicates sessions
    Given a reviewer visited the same prototype twice
    When I toggle "Unique visitors only"
    Then the funnel counts that reviewer once
```

---

## 7. API Reference

### Comments

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/comments | session | Create a comment |
| GET | /api/comments/:prototypeId | session | List element comments for prototype |
| PATCH | /api/comments/:commentId | session | Update comment body |
| DELETE | /api/comments/:commentId | session | Delete comment |

**POST /api/comments body:**
```json
{
  "prototypeId": "string",
  "type": "element | general",
  "comment": "string",
  "element": { "selector": "string", "label": "string", "tagName": "string" },
  "breadcrumb": ["string"],
  "pageUrl": "string",
  "tag": "bug | copy | question | idea | other | null",
  "xPct": 0.5,
  "yPct": 0.5,
  "email": "string"
}
```

### Navigation

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/nav | — | Record a page navigation event |

### Explanations

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/explanations/:prototypeId | session | List all explanations |
| POST | /api/explanations | session | Create explanation |
| PATCH | /api/explanations/:id | session | Update explanation body |
| DELETE | /api/explanations/:id | session | Delete explanation |

### Admin

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /admin/prototypes | admin | List all prototypes with stats |
| POST | /admin/prototypes | admin | Upload new prototype |
| GET | /admin/prototypes/:id | admin | Prototype detail page |
| POST | /admin/prototypes/:id/settings | admin | Update name & allowlist |
| DELETE | /admin/prototypes/:id | admin | Delete prototype + cascade |
| GET | /admin/prototypes/:id/preview | admin | Admin preview with SDK |
| POST | /admin/prototypes/:id/comments | admin | Paginated comment list |
| DELETE | /admin/prototypes/:id/comments | admin | Clear all comments |
| DELETE | /admin/prototypes/:id/comments/:commentId | admin | Delete single comment |
| POST | /admin/prototypes/:id/access-log | admin | Paginated access log |
| GET | /admin/prototypes/:id/funnels | admin | Funnel analytics data |

---

## 8. SDK Reference

### feedback.js (Reviewer SDK)

Injected into every shared prototype view. Initialised via `<script>` tag with `data-proto-id` and `data-email` attributes.

**Toolbar Modes:**

| Mode | Class on body | Behaviour |
|------|--------------|-----------|
| View | — | Shows pins; no interaction |
| Comment | `__fb-comment-mode` | Crosshair cursor; click to place pin |
| Review | — | Hides all pins |
| Explain | `__fb-explain-mode` | Click to add/edit explanations |

**Events tracked:**
- `hashchange` — hash-based SPA routing
- `popstate` — browser back/forward
- `history.pushState` / `history.replaceState` — modern SPA routing (patched)

**Key constants:**
- `CLUSTER_PX = 28` — distance threshold for pin clustering
- `EDIT_WINDOW_MS = 5 * 60 * 1000` — 5-minute edit window

### preview.js (Admin Preview SDK)

Injected into admin prototype preview. Receives pre-loaded comment data via `data-comments` attribute. Read-only — no comment creation. Supports `?focus=<commentId>` to highlight a specific pin on load.

---

## 9. Business Rules

| Rule | Detail |
|------|--------|
| File type | Only `.html` files accepted on upload |
| Allowlist matching | Case-insensitive, trimmed; email stored lowercase |
| Allowlist update | Full replace on settings save — removed emails lose access immediately |
| Edit window | 5 minutes from `created_at`; enforced client-side only |
| Edit permission | Client-side check: `pin.email === EMAIL` — only original commenter sees edit controls |
| Explanation uniqueness | One per (prototype, selector, page_url); `page_url = null` applies globally |
| Nav URL max length | 500 characters |
| Funnel session | New session when reviewer returns to the prototype root page |
| Time on page cap | Max 4 hours per step to filter abandoned tabs |
| Cascade on delete | Prototype deletion cascades: allowlist, comments, nav_events, explanations |
| Access log retention | NOT cascaded on prototype deletion — preserved as audit trail |
| Share token | Separate from prototype ID; used only in public-facing URLs |
| Session scope | Reviewer session is per-prototype; entering one prototype does not grant access to others |
