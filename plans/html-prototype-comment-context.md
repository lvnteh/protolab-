# Comments on interactive HTML prototypes

Date: 2026-11-21
Status: Proposed design

## Problem

An HTML prototype can reveal elements through interactions: expanding a section,
opening a dialog, switching tabs, or advancing through a flow. A reviewer can
attach a comment to one of those elements, but another session starts with the
element hidden or absent from the DOM.

The comment must remain understandable and accessible before someone reproduces
the interaction. Its live pin should appear when the correct target becomes
available.

## Existing behaviour

- `public/sdk/feedback.js` repeatedly resolves comment selectors and recalculates
  pin positions. Pins can already appear when their targets enter the DOM.
- The sidebar labels missing targets “Element no longer in the page” and disables
  opening those rows. Absence does not establish that an element was removed.
- Visibility detection primarily checks the element's bounding-box dimensions;
  that does not cover every way an element can be hidden.
- Comments already store a prototype version, selector, relative position within
  the element, URL, and navigation breadcrumb. The breadcrumb records URL
  navigation, not the interactions that reveal content within a page.
- The selector generator can use `nth-of-type`. Dynamic insertion or reordering
  can cause the same selector to identify a different element.

## Recommended experience

Each HTML comment should preserve its prototype version, target identity, and
the visual context the reviewer saw. Opening its thread must work independently
of locating its live pin.

### 1. Keep comment threads accessible

Always allow a reviewer to open, read, and reply to a comment from the sidebar.
Make locating the target a separate action. Keep comments from other pages of
the selected version discoverable, with page or availability grouping where
useful.

| Target condition | Behaviour |
| --- | --- |
| Identified and visible | Show the pin; Locate scrolls to the target. |
| Identified but outside the viewport | Allow Locate to scroll it into view. |
| Present but collapsed or hidden | Keep the thread accessible and explain that the target is hidden. |
| Absent from the current DOM | Show “Element isn't available in this view” and offer saved context. |
| Match is ambiguous | Keep the thread accessible and avoid attaching a pin to an uncertain target. |

Re-evaluate availability as the prototype changes. A missing target should not
be described as deleted unless there is evidence beyond its current absence.

### 2. Preserve visual context

Capture the current viewport when the reviewer places a pin, excluding Protolab's
controls from the image. Save the pin's position relative to the captured image
so it can be displayed accurately in the preview.

Keep the following context with the comment:

- Screenshot reference and image-relative pin position.
- Prototype version and page URL.
- Viewport dimensions.
- Readable target label and identifying metadata.
- Optional “How to reach it” instructions.

Show a thumbnail in the thread that opens a larger saved view. For example:

> **Comment #12:** This extra field needs an explanation.
>
> Element isn't available in this view.
>
> [Screenshot showing the expanded section and pin]
>
> **How to reach it:** Open Settings → Enable advanced options

Start with manually entered, optional instructions. A later improvement could
suggest them from a short trail of interaction labels. Such a trail describes
what happened; it does not guarantee that automatically replaying it will work.

Screenshot capture preserves visual context, not executable application state.
Client-side capture needs a fallback for unsupported content, including some
cross-origin assets, canvas content, and embedded frames. A capture failure must
not prevent posting the comment; retain the other context and allow a manual
image attachment. Apply the prototype's access controls to saved images.

### 3. Offer state restoration for supported prototypes

For prototypes whose source or generation templates we control, introduce an
optional integration with `captureState()` and `restoreState(state)` hooks. These
are proposed APIs, not existing Protolab functionality.

Example captured state:

```json
{
  "screen": "settings",
  "activeTab": "advanced",
  "expandedSections": ["delivery-options"]
}
```

The prototype owns the meaning of this state and how it is restored. Capture it
alongside the visual context when the pin is placed.

An explicit **Open this state** action should:

1. Open the same prototype version the comment was made against.
2. Restore the saved state through the prototype's integration.
3. Wait for the target to render, with a bounded timeout.
4. Verify the target, then scroll to and focus its pin.
5. Keep the thread and saved context available if restoration fails.

Opening a thread alone should not reset the reviewer's current interaction.
Arbitrary uploaded HTML without these hooks still receives accessible threads
and saved visual context.

## Improve target identity

Prefer stable element IDs or author-provided `data-protolab-id` attributes. For
generated prototypes, include stable annotation identifiers in the templates.

Capture identifying text and other useful metadata as supporting evidence when
resolving a target. Treat positional selectors as a fallback and avoid silently
attaching a comment to a different element after dynamic insertion or reordering.
Preserve the existing relative coordinates within the correctly identified
element.

## Delivery order

### First release

- Make sidebar threads usable when their target is unavailable.
- Replace the missing-element warning with accurate availability messages.
- Capture and display screenshots with pin locations and context metadata.
- Add optional “How to reach it” instructions.
- Improve target identity and bound attempts to focus unavailable pins.
- Keep existing comments usable when they have no saved context.

### Follow-up

- Add optional state capture and restoration to supported prototype templates.
- Add the explicit Open this state action and restoration failure handling.
- Consider suggesting navigation instructions from observed interactions.

Defer generic automatic click replay. Toggle states, asynchronous rendering,
external data, and application-specific logic make it unreliable across arbitrary
HTML. A serialized DOM also cannot preserve JavaScript application state.

## Implementation touchpoints

- `public/sdk/feedback.js`: sidebar/thread access, target availability, capture,
  selector generation, and locating or restoring a comment's target.
- `public/sdk/preview.js`: apply equivalent target resolution and availability
  behaviour wherever the preview renderer is used.
- `src/services/annotations.js` and `src/routes/api.js`: store and return optional
  context metadata without breaking existing comments.
- `src/db.js` and `src/services/storage.js`: context persistence and screenshot
  storage, following existing version and access-control boundaries.

## Acceptance scenarios

- Comment on a field inside an expanded section, then reload with it collapsed:
  the thread, replies, and saved screenshot remain accessible.
- Expand that section in the new session: the pin appears on the correct field.
- Create an element dynamically after a click: its comment stays accessible
  before creation and attaches when the element appears.
- Insert or reorder neighbouring elements: the comment does not silently move
  to a different target.
- Open a supported saved state: the correct version and interaction state are
  restored before focusing the pin.
- Fail screenshot capture or state restoration: the comment remains usable with
  the context that is available.
- Open a legacy comment with no context metadata: its thread still works.
