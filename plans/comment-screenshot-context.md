# Screenshot context for prototype comments

Date: 2026-11-21
Status: Proposed design
Relates to: `html-prototype-comment-context.md` (this refines that plan's §2 and
replaces its reliance on client DOM-to-canvas capture with consented screen capture)

## Goal

When a reviewer places a comment pin, preserve a screenshot of what they saw.
This gives the prototype owner visual context for every comment — including
comments whose target is later hidden or absent (see the availability states
shipped in `feedback.js`) — without attempting to reproduce the prototype's
interaction state. A screenshot is a hint, not a time machine: it shows what the
reviewer saw; it does not navigate anyone back to that state.

Non-goal: interaction history / click replay / state restoration. Those remain
deferred (and unreliable on arbitrary HTML) per the parent plan.

## Decisions (settled with the product owner)

1. **Capture method — consented screen capture (`getDisplayMedia`), asked once.**
   - Rejected client DOM-to-canvas (html2canvas): only an approximation, cannot
     render canvas/WebGL/cross-origin images/iframes, and adds a large dependency.
   - Rejected server-side headless capture: the server cannot know the reviewer's
     in-page interaction state, so it would only ever capture the initial load.
   - `getDisplayMedia` gives true fidelity. The permission prompt and the
     browser's persistent "sharing" indicator are treated as a FEATURE: the
     reviewer is explicitly told screenshots will be taken and stays aware of it,
     so they do not enter anything into the prototype they do not want preserved.

2. **Ask once, capture many.** Call `getDisplayMedia()` a single time, from a
   user gesture, when the reviewer opts in. Keep the returned `MediaStream` alive
   for the session and grab a still frame per pin (draw the video frame to a
   canvas) — no re-prompt per comment.

3. **On decline / unsupported: comment normally, no screenshot.** No nagging, no
   re-prompt, no blocking. Commenting keeps working exactly as today. A capture
   failure for a single pin must likewise never block posting the comment.

4. **Pin overlay.** Store the pin's position relative to the captured frame and
   draw the numbered pin on top of the saved image in the preview.

5. **Storage — thumbnail inline, full image in object storage.** A small
   thumbnail (data URL / bytea) on the comment row for the sidebar preview; the
   full-resolution image in object storage (Supabase Storage in prod, local-disk
   fallback in dev), fetched on demand.

6. **Visibility — owner/admins only.** Screenshots are shown only to the
   prototype owner and org admins, NOT to other reviewers. Stronger boundary than
   the comment text (which reviewers see on each other's comments), matching the
   "don't broadcast what a reviewer didn't intend to share" intent. The commenter
   sees their own capture at placement time.

7. **Timing — on pin placement only.** Not on replies.

## Experience

1. Reviewer opens a prototype. A clear, dismissible notice explains that placing
   a comment can capture a screenshot of the current view, and offers to enable
   it. Enabling triggers the single `getDisplayMedia` prompt; the reviewer picks
   the tab. The browser recording indicator remains visible all session.
2. Reviewer places a pin as today. If capture is enabled, a still frame is grabbed
   and the pin's frame-relative position recorded. The comment posts with the
   screenshot; if capture fails, it posts without.
3. If the reviewer never enables capture, everything behaves as it does today.
4. Owner/admins viewing comments see a thumbnail with the pin drawn on it; opening
   it shows the full image. Reviewers do not see saved screenshots.

## Data model

Extend `comments` via the established `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
pattern (nullable — legacy and no-capture comments have none):

- `screenshot_key TEXT` — object-storage key for the full image (null = none).
- `screenshot_thumb TEXT` — small inline thumbnail (data URL or bytea) for preview.
- `screenshot_w INTEGER`, `screenshot_h INTEGER` — captured frame dimensions.
- `screenshot_x_pct REAL`, `screenshot_y_pct REAL` — pin position within the frame.

The existing `x_pct`/`y_pct` remain the pin's position within the *element*;
these new columns are the pin's position within the *captured image*, which may
differ (scroll offset, viewport).

## Touchpoints (verified against current code)

- `public/sdk/feedback.js`: opt-in notice + one-time `getDisplayMedia`; keep the
  stream; grab a frame on pin placement; compute frame-relative pin position;
  send image + metadata with the comment; degrade silently on decline/failure.
- `src/services/storage.js`: add image put/get verbs alongside the HTML verbs
  (same Supabase-bucket / local-disk split). Full images live in the same bucket,
  under the prototype's access boundary.
- `src/services/annotations.js` + `src/routes/api.js`: accept and persist the new
  fields on create; return `screenshot_thumb` + pin position in the comment list
  ONLY for owner/admin viewers; never leak `screenshot_key`/images to reviewers.
- New owner/admin-only route to fetch the full image by comment id, gated by the
  same org/ownership check used elsewhere, returning 403 to reviewers.
- `src/db.js`: the ADD COLUMN migrations above.

## Access control

The full-image route and the thumbnail field must both enforce owner/admin-only.
Reviewers authorized to *comment* are NOT authorized to *view screenshots*. This
is a deliberately tighter check than `authorizedForPrototype`; it needs an
owner/admin predicate (owner_id match or org admin role).

## Privacy / security notes

- Screen capture can include content outside the prototype if the reviewer shares
  the wrong source. The picker is the reviewer's choice; the notice should warn to
  share the prototype tab, not the whole screen.
- Images inherit the prototype's deletion/cascade (delete comment / prototype →
  delete image). Fold `screenshot_key` cleanup into the existing delete paths.
- No capture without an explicit, visible, revocable grant (stopping the share
  from the browser bar ends capture for the session).

## Acceptance scenarios

- Enable capture, place a pin: owner sees a thumbnail with the pin overlaid;
  opening shows the full frame. A second reviewer does NOT see the image.
- Decline capture, place a pin: comment posts normally, no image, no re-prompt.
- Capture throws on one pin: that comment still posts, without an image.
- Stop sharing mid-session: subsequent pins post without images; no errors.
- Legacy comment with no screenshot columns: renders exactly as today.
- Reviewer hits the full-image route directly: 403.
- Delete a comment / prototype: its stored image is removed.

## Delivery order

1. Schema columns + storage verbs (no behaviour change yet).
2. SDK opt-in notice + one-time capture + per-pin frame grab + send.
3. Persist + owner/admin-only list field + full-image route with access check.
4. Preview: thumbnail with pin overlay, open-to-full.
5. Deletion cleanup + the access-control tests in the acceptance list.
