// public/sdk/feedback.js
(function () {
  const script = document.currentScript;
  if (!script) return;
  const PROTO_ID = script.getAttribute('data-proto-id');
  const EMAIL = decodeURIComponent(script.getAttribute('data-email') || '');
  // Rendered-markdown docs annotate by selecting text (range comments); HTML
  // prototypes annotate by clicking an element (element pins). delivery.js sets
  // data-content-type="markdown" only for the former. This flips comment mode to
  // selection-only and keeps the text (I-beam) cursor instead of the crosshair.
  const IS_MARKDOWN = script.getAttribute('data-content-type') === 'markdown';
  // HTML prototypes use screenshot-anchored pins (viewport %, no DOM selector).
  // This avoids broken pins on dynamic elements (dialogs, Angular components, etc).
  const IS_HTML_PROTO = !IS_MARKDOWN;
  // Framed mode: the prototype renders inside a shell iframe and this SDK runs in
  // the PARENT shell. Prototype clicks/navigation arrive over postMessage (via
  // frame-bridge.js) instead of on this document. Only HTML prototypes are framed.
  const IS_FRAMED = script.getAttribute('data-framed') === '1';
  const PROTO_FRAME = IS_FRAMED ? document.getElementById('__fb-proto-frame') : null;
  // In framed mode the "current page" is the iframe's URL, reported by the bridge,
  // not the shell's own location. Seeded on the bridge 'ready'/'page' messages.
  let framedHref = IS_FRAMED ? '' : null;

  // Versioned annotations: the viewed version (null when the delivery view omits
  // the attrs — half-deployed safety: behave exactly as today). VIEW_BASE drives
  // the switcher reload; VERSIONS lists the published versions for the switcher.
  let VERSION = script.getAttribute('data-version');
  VERSION = (VERSION == null || VERSION === '') ? null : parseInt(VERSION, 10);
  const VIEW_BASE = script.getAttribute('data-view-base') || '';
  let VERSIONS = [];
  try { VERSIONS = JSON.parse(script.getAttribute('data-versions') || '[]'); } catch (e) { VERSIONS = []; }

  function withVersion(url) {
    if (VERSION == null) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'version=' + VERSION;
  }

  const TAGS = ['bug', 'copy', 'question', 'idea', 'explanation', 'other'];
  const TAG_LABEL = { bug: 'Bug', copy: 'Copy', question: 'Question', idea: 'Idea', explanation: 'Explanation', other: 'Other' };
  const TAG_COLOR = {
    bug:         'hsl(0,84%,60%)',
    copy:        'hsl(38,92%,50%)',
    question:    'hsl(217,91%,60%)',
    idea:        'hsl(142,71%,45%)',
    explanation: 'hsl(271,76%,53%)',
    other:       'hsl(252,83%,57%)',
  };
  const CLUSTER_PX = 28;
  const EDIT_WINDOW_MS = 5 * 60 * 1000;

  // Every piece of SDK chrome lives inside a top-level container whose id starts
  // with "__fb-" (toolbar, comment/explain banners, pins, ranges, explains,
  // sidebar, draft/explain cards, toast — see the creation block ~L400-530).
  // A click or text-selection anywhere inside that chrome must NEVER be treated
  // as interacting with the prototype (which would drop a pin / open a draft
  // card, and — because our handlers run at capture phase with stopPropagation —
  // would also swallow the real control's click, e.g. a popover's Delete button).
  // Keying on the id-prefix keeps this drift-proof: the three handlers below
  // previously carried three separate, out-of-sync exclusion lists.
  const FB_UI_SELECTOR = '[id^="__fb-"]';
  function isOwnUi(target) {
    return !!(target && target.closest && target.closest(FB_UI_SELECTOR));
  }

  /* ── styles ── */
  const STYLE = `
    #__fb-toolbar {
      position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
      height: 44px; background: hsl(252,83%,57%);
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 16px; gap: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px; box-shadow: 0 1px 3px rgba(0,0,0,.12);
    }
    #__fb-toolbar-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
    #__fb-toolbar-title { font-weight: 600; font-size: 13px; color: #fff; }
    /* Comment-mode: the single toolbar tints to signal the mode (replaces the
       old separate full-width banner stripe). */
    body.__fb-comment-mode #__fb-toolbar { background: hsl(252,83%,45%); }
    /* Inline comment-mode hint, shown only while commenting — folds the former
       banner's instruction into the toolbar so no second stripe is needed. */
    #__fb-toolbar-hint {
      display: none; align-items: center; gap: 6px;
      margin-left: 4px; padding-left: 12px;
      border-left: 1px solid rgba(255,255,255,.3);
      font-size: 12px; color: rgba(255,255,255,.92);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    body.__fb-comment-mode #__fb-toolbar-hint { display: inline-flex; }
    #__fb-toolbar-hint kbd {
      font-family: inherit; font-size: 11px; line-height: 1;
      background: rgba(255,255,255,.2); border: 1px solid rgba(255,255,255,.35);
      border-radius: 4px; padding: 2px 5px;
    }
    #__fb-mode-switcher {
      display: inline-flex; border-radius: 8px; border: 1px solid rgba(255,255,255,.25);
      background: rgba(255,255,255,.15); padding: 2px; gap: 0;
    }
    .fb-mode-btn {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 4px 12px; border-radius: 6px; border: none; cursor: pointer;
      font-size: 12px; font-weight: 500; background: none;
      color: rgba(255,255,255,.75); transition: background .15s, color .15s;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .fb-mode-btn:hover { color: #fff; }
    .fb-mode-btn.active-view    { background: #fff; color: hsl(252,83%,57%); box-shadow: 0 1px 3px rgba(0,0,0,.12); }
    .fb-mode-btn.active-comment { background: rgba(255,255,255,.25); color: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.08); }

    /* Right-side toolbar cluster: mode switcher + the view-only hide-comments pill. */
    #__fb-toolbar-right { display: flex; align-items: center; gap: 10px; }

    /* Screenshot opt-in button (toolbar-right). Matches the pill styling of the
       mode switcher / hide toggle so it reads as native chrome. */
    #__fb-shot-btn {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 4px 12px; height: 26px; border-radius: 6px;
      border: 1px solid rgba(255,255,255,.25); background: rgba(255,255,255,.15);
      color: #fff; cursor: pointer; font-size: 12px; font-weight: 500;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      transition: background .15s, opacity .15s; white-space: nowrap;
    }
    #__fb-shot-btn:hover { background: rgba(255,255,255,.25); }
    #__fb-shot-btn.active { background: #fff; color: hsl(252,83%,57%); }
    #__fb-shot-btn:disabled { opacity: .45; cursor: default; }

    /* Screenshot prompt: shown once when entering comment mode without screenshots
       enabled. Centered modal overlay so it reads as a deliberate gate, not a
       sidebar nudge. The reviewer can enable screenshots or skip. */
    #__fb-shot-prompt-backdrop {
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0,0,0,.35); display: none; align-items: center; justify-content: center;
    }
    #__fb-shot-prompt-backdrop.visible { display: flex; }
    #__fb-shot-prompt {
      width: 360px; background: #fff; border-radius: 16px;
      padding: 24px; box-shadow: 0 16px 48px rgba(0,0,0,.22);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px; line-height: 1.55; color: hsl(222,47%,11%);
    }
    #__fb-shot-prompt-icon {
      width: 44px; height: 44px; border-radius: 12px;
      background: hsl(252,83%,95%); display: flex; align-items: center; justify-content: center;
      margin-bottom: 14px;
    }
    #__fb-shot-prompt h4 { margin: 0 0 8px; font-size: 15px; font-weight: 700; }
    #__fb-shot-prompt p { margin: 0 0 18px; color: hsl(220,9%,40%); font-size: 13px; }
    #__fb-shot-prompt .fb-shot-prompt-actions { display: flex; flex-direction: column; gap: 8px; }
    #__fb-shot-prompt-enable {
      width: 100%; padding: 10px; border-radius: 8px; border: none;
      background: hsl(252,83%,57%); color: #fff; font-size: 13px; font-weight: 600;
      cursor: pointer; font-family: inherit; display: flex; align-items: center; justify-content: center; gap: 6px;
    }
    #__fb-shot-prompt-enable:hover { background: hsl(252,83%,48%); }
    #__fb-shot-prompt-skip {
      width: 100%; padding: 9px; border-radius: 8px;
      border: 1px solid hsl(220,13%,87%); background: none;
      color: hsl(220,9%,46%); font-size: 13px; font-weight: 500;
      cursor: pointer; font-family: inherit;
    }
    #__fb-shot-prompt-skip:hover { background: hsl(220,14%,96%); color: hsl(222,47%,11%); }

    /* Screenshot opt-in notice: a small styled inline panel (not window.confirm),
       anchored under the toolbar on the right, explaining what capture does. */
    #__fb-shot-notice {
      position: fixed; top: 52px; right: 16px; z-index: 2147483646;
      width: 300px; background: #fff; border: 1px solid hsl(220,13%,91%);
      border-radius: 12px; padding: 14px; box-shadow: 0 8px 24px rgba(0,0,0,.16);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px; line-height: 1.5; color: hsl(222,47%,11%); display: none;
    }
    #__fb-shot-notice.visible { display: block; }
    #__fb-shot-notice h4 { margin: 0 0 6px; font-size: 13px; font-weight: 600; }
    #__fb-shot-notice p { margin: 0 0 8px; color: hsl(220,9%,40%); }
    #__fb-shot-notice ul { margin: 0 0 10px; padding-left: 16px; color: hsl(220,9%,40%); }
    #__fb-shot-notice li { margin-bottom: 3px; }
    #__fb-shot-notice .fb-shot-actions { display: flex; gap: 6px; justify-content: flex-end; }
    #__fb-hide-toggle {
      position: fixed; bottom: 24px; right: calc(var(--fb-sidebar-w, 32px) + 12px);
      display: inline-flex; align-items: center; gap: 5px;
      padding: 6px 14px; height: 32px; border-radius: 20px;
      border: none; background: hsl(222,47%,11%); color: #fff;
      cursor: pointer; font-size: 12px; font-weight: 500;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 2px 8px rgba(0,0,0,.25);
      transition: background .15s, right .2s;
      z-index: 2147483644;
    }
    #__fb-hide-toggle:hover { background: hsl(222,47%,20%); }
    #__fb-hide-toggle.active { background: hsl(252,83%,57%); }

    #__fb-version-switcher {
      appearance: none; -webkit-appearance: none; -moz-appearance: none;
      margin-left: 2px; padding: 4px 26px 4px 10px; height: 26px;
      border-radius: 6px; border: 1px solid rgba(255,255,255,.25);
      background-color: rgba(255,255,255,.15);
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23ffffff' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 9px center; background-size: 10px;
      color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px; font-weight: 500; line-height: 1.4; cursor: pointer; outline: none;
      transition: background-color .15s, border-color .15s;
    }
    #__fb-version-switcher:hover { background-color: rgba(255,255,255,.25); }
    #__fb-version-switcher:focus-visible { border-color: rgba(255,255,255,.6); box-shadow: 0 0 0 2px rgba(255,255,255,.25); }
    #__fb-version-switcher option { color: hsl(222,47%,11%); background: #fff; font-weight: 500; }

    body.__fb-comment-mode { cursor: crosshair !important; }
    body.__fb-comment-mode * { cursor: crosshair !important; }
    body.__fb-comment-mode.__fb-draft-open,
    body.__fb-comment-mode.__fb-draft-open * { cursor: default !important; }
    body.__fb-comment-mode.__fb-draft-open [id^="__fb-"],
    body.__fb-comment-mode.__fb-draft-open [id^="__fb-"] * { cursor: auto !important; }
    /* Markdown docs annotate by selecting text, so keep the text (I-beam) cursor
       over the document body — but our own chrome keeps its normal pointer. */
    body.__fb-markdown.__fb-comment-mode,
    body.__fb-markdown.__fb-comment-mode .md-doc,
    body.__fb-markdown.__fb-comment-mode .md-doc * { cursor: text !important; }
    body.__fb-markdown.__fb-comment-mode [id^="__fb-"],
    body.__fb-markdown.__fb-comment-mode [id^="__fb-"] * { cursor: auto !important; }

    /* pin layer */
    #__fb-pins {
      position: fixed; top: 0; left: 0; width: 0; height: 0;
      pointer-events: none; z-index: 2147483639;
    }
    .fb-pin {
      position: absolute; width: 28px; height: 28px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      color: #fff; font-size: 12px; font-weight: 700;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 2px 8px rgba(0,0,0,.25), 0 0 0 2px #fff;
      cursor: pointer; pointer-events: auto;
      transform: translate(-50%,-50%);
    }
    .fb-pin:hover { transform: translate(-50%,-50%); }
    .fb-pin--draft { opacity: .8; animation: fb-pulse .8s ease-in-out infinite; }
    .fb-pin--focus { animation: fb-focus-pulse 1.2s ease-in-out 3; }
    .fb-pin--dim { opacity: .25; transition: opacity .3s; }
    .fb-cluster--dim { opacity: .25; transition: opacity .3s; }
    @keyframes fb-pulse { 0%,100% { transform: translate(-50%,-50%) scale(1); } 50% { transform: translate(-50%,-50%) scale(1.2); } }
    @keyframes fb-focus-pulse { 0%,100% { box-shadow: 0 2px 8px rgba(0,0,0,.25),0 0 0 2px #fff; } 50% { box-shadow: 0 2px 8px rgba(0,0,0,.25),0 0 0 8px hsl(252,83%,70%); } }

    .fb-cluster {
      position: absolute; width: 32px; height: 32px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      background: hsl(222,47%,11%); color: #fff; font-size: 12px; font-weight: 700;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 2px 8px rgba(0,0,0,.25), 0 0 0 2px #fff;
      cursor: pointer; pointer-events: auto; transform: translate(-50%,-50%);
    }
    .fb-cluster:hover { transform: translate(-50%,-50%); }

    /* pin popover */
    .fb-popover {
      position: absolute; left: calc(100% + 8px); top: -4px;
      width: 280px; background: #fff;
      border: 1px solid hsl(220,13%,91%); border-radius: 12px;
      padding: 12px; font-size: 12px; font-weight: 400; line-height: 1.5;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 4px 16px rgba(0,0,0,.12);
      pointer-events: auto; z-index: 10;
    }
    .fb-popover__tag {
      display: inline-block; padding: 2px 8px; border-radius: 20px;
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .04em; color: #fff; margin-bottom: 6px;
    }
    .fb-popover__body { color: hsl(222,47%,11%); white-space: pre-wrap; word-break: break-word; }
    .fb-popover__meta { font-size: 11px; color: hsl(220,9%,46%); margin-top: 4px; }
    .fb-popover__actions { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; padding-top: 8px; border-top: 1px solid hsl(220,13%,91%); }
    .fb-popover__timer { font-size: 10px; color: hsl(220,9%,46%); }
    .fb-popover__btns { display: flex; gap: 4px; }
    .fb-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: none; border-radius: 6px; cursor: pointer; background: none; color: hsl(220,9%,46%); }
    .fb-icon-btn:hover { background: hsl(220,14%,93%); color: hsl(222,47%,11%); }
    .fb-icon-btn--danger:hover { background: hsl(0,84%,95%); color: hsl(0,84%,50%); }
    .fb-popover textarea {
      width: 100%; resize: none; border: 1px solid hsl(220,13%,87%); border-radius: 8px;
      padding: 6px 8px; font-size: 12px; font-family: inherit; outline: none;
      background: #fff; color: hsl(222,47%,11%); line-height: 1.4; margin-top: 6px;
    }
    .fb-popover textarea:focus { border-color: hsl(252,83%,57%); box-shadow: 0 0 0 3px hsl(252,83%,90%); }
    .fb-popover__save { margin-top: 6px; display: flex; gap: 6px; justify-content: flex-end; }
    .fb-btn-sm {
      padding: 4px 12px; border-radius: 6px; font-size: 12px; font-weight: 600;
      cursor: pointer; border: none; font-family: inherit;
    }
    .fb-btn-primary { background: hsl(252,83%,57%); color: #fff; }
    .fb-btn-primary:hover { background: hsl(252,83%,48%); }
    .fb-btn-primary:disabled { opacity: .5; cursor: default; }
    .fb-btn-ghost { background: none; color: hsl(220,9%,46%); border: 1px solid hsl(220,13%,87%); }
    .fb-btn-ghost:hover { background: hsl(220,14%,93%); }

    /* draft card */
    #__fb-draft-card {
      position: fixed; right: 16px; top: 60px; width: 296px;
      transition: width .15s ease;
      background: #fff; border: 1px solid hsl(220,13%,91%); border-radius: 12px;
      padding: 16px; box-shadow: 0 8px 24px rgba(0,0,0,.12);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px; z-index: 2147483645; display: none;
    }
    #__fb-draft-card.has-shot { width: 480px; }
    #__fb-draft-card.visible { display: block; }
    .fb-draft-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .fb-draft-title { font-weight: 600; font-size: 13px; color: hsl(222,47%,11%); }
    .fb-draft-close { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: none; border-radius: 6px; cursor: pointer; background: none; color: hsl(220,9%,46%); }
    .fb-draft-close:hover { background: hsl(220,14%,93%); }
    .fb-draft-selector { font-size: 11px; color: hsl(220,9%,46%); margin-bottom: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fb-tag-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
    .fb-tag-pill {
      padding: 3px 10px; border-radius: 20px; border: 1.5px solid; font-size: 11px;
      font-weight: 600; cursor: pointer; background: none; font-family: inherit;
      transition: background .12s, color .12s;
    }
    .fb-tag-pill.active { color: #fff !important; }
    #__fb-draft-textarea {
      width: 100%; resize: none; border: 1px solid hsl(220,13%,87%); border-radius: 8px;
      padding: 8px 10px; font-size: 13px; font-family: inherit; outline: none;
      background: #fff; color: hsl(222,47%,11%); line-height: 1.5;
    }
    #__fb-draft-textarea:focus { border-color: hsl(252,83%,57%); box-shadow: 0 0 0 3px hsl(252,83%,90%); }
    #__fb-draft-submit {
      margin-top: 10px; width: 100%; padding: 8px; border-radius: 8px; border: none;
      background: hsl(252,83%,57%); color: #fff; font-size: 13px; font-weight: 600;
      cursor: pointer; font-family: inherit;
    }
    #__fb-draft-submit:hover { background: hsl(252,83%,48%); }
    #__fb-draft-submit:disabled { opacity: .5; cursor: default; }
    /* Draft screenshot preview (HTML prototypes) */
    #__fb-draft-shot-wrap { margin-bottom: 10px; border-radius: 8px; overflow: hidden; border: 1px solid hsl(220,13%,91%); background: hsl(220,14%,96%); position: relative; line-height: 0; }
    #__fb-draft-shot-wrap img { display: block; width: 100%; height: auto; max-height: 320px; object-fit: cover; object-position: top; }
    #__fb-draft-shot-wrap.no-shot { display: none; }

    /* Click ripple — brief animated ring at click point, HTML proto comment mode */
    .fb-click-ripple {
      position: fixed; border-radius: 50%; pointer-events: none;
      border: 2.5px solid hsl(252,83%,57%); z-index: 2147483646;
      transform: translate(-50%, -50%) scale(0);
      animation: fb-ripple .65s ease-out forwards;
    }
    @keyframes fb-ripple {
      0%   { transform: translate(-50%,-50%) scale(0); opacity: 1; width: 20px; height: 20px; }
      100% { transform: translate(-50%,-50%) scale(1); opacity: 0; width: 72px; height: 72px; }
    }

    /* toast */
    #__fb-toast {
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%) translateY(-8px);
      z-index: 2147483647;
      background: hsl(142,71%,30%); color: #fff; border-radius: 8px; padding: 10px 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px; opacity: 0; transition: opacity .2s, transform .2s; pointer-events: none;
      box-shadow: 0 4px 12px rgba(0,0,0,.15);
    }
    #__fb-toast.visible { opacity: 1; transform: translateX(-50%) translateY(0); }

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

    /* ── sidebar ── */
    #__fb-sidebar {
      position: fixed; top: 44px; right: 0;
      height: calc(100vh - 44px);
      z-index: 2147483644;
      display: flex; flex-direction: column;
      background: #fff; border-left: 1px solid hsl(220,13%,91%);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      transition: width .2s ease;
      box-shadow: -2px 0 8px rgba(0,0,0,.06);
    }
    #__fb-sidebar.expanded { width: 260px; }
    #__fb-sidebar.collapsed { width: 32px; overflow: hidden; }

    /* collapsed strip */
    #__fb-sidebar-strip {
      display: none; flex-direction: column; align-items: center;
      padding-top: 12px; gap: 8px; cursor: pointer; width: 32px; flex: 1;
    }
    #__fb-sidebar.collapsed #__fb-sidebar-strip { display: flex; }
    #__fb-sidebar.collapsed #__fb-sidebar-main { display: none; }
    #__fb-sidebar-badge {
      background: hsl(252,83%,57%); color: #fff;
      font-size: 10px; font-weight: 700;
      padding: 2px 6px; border-radius: 10px;
    }
    #__fb-sidebar-strip-label {
      font-size: 9px; color: hsl(220,9%,46%); letter-spacing: .04em;
      writing-mode: vertical-rl; transform: rotate(180deg); font-weight: 500;
    }

    /* expanded main */
    #__fb-sidebar-main { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
    #__fb-sidebar-tabs {
      display: flex; align-items: center; border-bottom: 1px solid hsl(220,13%,91%); flex-shrink: 0;
    }
    .fb-sidebar-tab {
      flex: 1; padding: 9px 6px; text-align: center;
      font-size: 11px; font-weight: 500; color: hsl(220,9%,46%);
      border-bottom: 2px solid transparent; cursor: pointer; border-top: none;
      border-left: none; border-right: none; background: none;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      white-space: nowrap;
    }
    .fb-sidebar-tab.active { font-weight: 600; color: hsl(252,83%,57%); border-bottom-color: hsl(252,83%,57%); }
    .fb-sidebar-tab-badge {
      display: inline-block; font-size: 9px; font-weight: 700;
      padding: 1px 6px; border-radius: 10px; margin-left: 3px;
    }
    .fb-sidebar-tab.active .fb-sidebar-tab-badge { background: hsl(252,83%,57%); color: #fff; }
    .fb-sidebar-tab:not(.active) .fb-sidebar-tab-badge { background: hsl(220,13%,91%); color: hsl(220,9%,46%); }
    #__fb-sidebar-collapse {
      padding: 9px 8px; color: hsl(220,9%,46%); cursor: pointer; font-size: 14px;
      background: none; border: none; line-height: 1; flex-shrink: 0;
      font-family: inherit;
    }
    #__fb-sidebar-collapse:hover { color: hsl(222,47%,11%); }

    /* panels */
    #__fb-sidebar-pins,
    #__fb-sidebar-general { display: none; flex-direction: column; flex: 1; overflow: hidden; }
    #__fb-sidebar-pins.active,
    #__fb-sidebar-general.active { display: flex; }

    /* pins list */
    #__fb-sidebar-pins-list { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
    .fb-sidebar-pin-row {
      padding: 8px 10px; border-radius: 8px; border: 1px solid hsl(220,13%,91%);
      cursor: pointer; background: #fff;
    }
    .fb-sidebar-pin-row:hover { background: hsl(252,83%,97%); border-color: hsl(252,83%,85%); }
    .fb-sidebar-pin-row-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
    .fb-sidebar-pin-dot {
      width: 20px; height: 20px; border-radius: 50%; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      color: #fff; font-size: 9px; font-weight: 700;
      box-shadow: 0 1px 3px rgba(0,0,0,.2), 0 0 0 1.5px #fff;
    }
    .fb-sidebar-pin-email {
      font-size: 10px; font-weight: 600; color: hsl(252,83%,50%);
      flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .fb-sidebar-pin-tag {
      font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
      color: #fff; padding: 1px 5px; border-radius: 4px; flex-shrink: 0;
    }
    .fb-sidebar-pin-body {
      font-size: 11px; color: hsl(222,47%,11%); line-height: 1.4;
      overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    }
    .fb-sidebar-pin-replies { font-size: 10px; color: hsl(220,9%,46%); margin-top: 3px; }
    .fb-sidebar-pin-avail {
      display: inline-flex; align-items: center; gap: 3px;
      margin-top: 4px; font-size: 10px; color: hsl(38,92%,38%);
      background: hsl(38,92%,95%); border: 1px solid hsl(38,92%,80%);
      border-radius: 4px; padding: 2px 6px; font-weight: 500;
    }
    .fb-sidebar-pin-row--unavailable { opacity: 0.85; }
    /* Inline thread shown in the sidebar when the target isn't on screen. */
    .fb-inline-thread { margin-top: 6px; border-top: 1px solid hsl(220,13%,91%); padding-top: 6px; }
    .fb-inline-thread__reply { font-size: 11px; line-height: 1.45; margin-top: 4px; }
    .fb-inline-thread__reply-email { font-weight: 600; color: hsl(252,83%,50%); margin-right: 4px; }
    .fb-inline-thread__reply-date { color: hsl(220,9%,46%); font-size: 10px; margin-left: 4px; }
    .fb-inline-thread textarea {
      width: 100%; box-sizing: border-box; margin-top: 6px; resize: vertical;
      font: inherit; font-size: 11px; border: 1px solid hsl(220,13%,87%);
      border-radius: 4px; padding: 4px 6px;
    }
    .fb-inline-thread textarea:focus { outline: none; border-color: hsl(252,83%,57%); box-shadow: 0 0 0 3px hsl(252,83%,90%); }
    .fb-inline-thread__btn {
      margin-top: 4px; font-size: 10px; font-weight: 600; cursor: pointer;
      color: #fff; background: hsl(252,83%,57%); border: none;
      border-radius: 4px; padding: 3px 10px;
    }
    .fb-inline-thread__btn:disabled { opacity: 0.5; cursor: default; }
    .fb-sidebar-empty {
      flex: 1; display: flex; align-items: center; justify-content: center;
      font-size: 12px; color: hsl(220,9%,60%); text-align: center; padding: 16px;
    }

    /* general tab */
    #__fb-sidebar-gen-list { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
    .fb-sidebar-gen-item {
      padding: 8px 10px; border-radius: 8px; border: 1px solid hsl(220,13%,91%);
    }
    .fb-sidebar-gen-email { font-size: 10px; font-weight: 600; color: hsl(252,83%,50%); margin-bottom: 3px; }
    .fb-sidebar-gen-body { font-size: 11px; color: hsl(222,47%,11%); line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
    .fb-sidebar-gen-date { font-size: 10px; color: hsl(220,9%,46%); margin-top: 3px; }
    #__fb-sidebar-gen-form {
      padding: 8px; border-top: 1px solid hsl(220,13%,91%); flex-shrink: 0;
    }
    #__fb-sidebar-gen-input {
      width: 100%; box-sizing: border-box; resize: none;
      border: 1px solid hsl(220,13%,87%); border-radius: 6px;
      padding: 6px 8px; font-size: 11px; font-family: inherit; outline: none;
      background: #fff; color: hsl(222,47%,11%); line-height: 1.4;
    }
    #__fb-sidebar-gen-input:focus { border-color: hsl(252,83%,57%); box-shadow: 0 0 0 3px hsl(252,83%,90%); }
    #__fb-sidebar-gen-submit {
      margin-top: 6px; width: 100%; padding: 6px; border-radius: 6px; border: none;
      background: hsl(252,83%,57%); color: #fff; font-size: 11px; font-weight: 600;
      cursor: pointer; font-family: inherit;
    }
    #__fb-sidebar-gen-submit:hover { background: hsl(252,83%,48%); }
    #__fb-sidebar-gen-submit:disabled { opacity: .5; cursor: default; }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);

  /* ── adjust body to not be hidden behind toolbar ── */
  // Framed mode sizes the iframe explicitly (layoutFrame) rather than padding the
  // shell body, so this padding is only for the in-document (markdown) layout.
  if (!IS_FRAMED) document.body.style.paddingTop = '44px';

  /* ── toolbar ── */
  const toolbar = document.createElement('div');
  toolbar.id = '__fb-toolbar';
  toolbar.innerHTML = `
    <div id="__fb-toolbar-left">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#fff" width="18" height="18" style="flex-shrink:0"><path d="M13.13 22.19L11.5 18.36C13.07 17.78 14.54 17 15.9 16.09L13.13 22.19M5.64 12.5L1.81 10.87L7.91 8.1C7 9.46 6.22 10.93 5.64 12.5M21.61 2.39C21.61 2.39 16.66 .269 11 5.93C8.81 8.12 7.5 10.53 6.65 12.64C6.37 13.39 6.56 14.21 7.11 14.77L9.24 16.89C9.79 17.45 10.61 17.63 11.36 17.35C13.5 16.53 15.88 15.19 18.07 13C23.73 7.34 21.61 2.39 21.61 2.39M14.54 9.46C13.76 8.68 13.76 7.41 14.54 6.63S16.59 5.85 17.37 6.63C18.14 7.41 18.15 8.68 17.37 9.46C16.59 10.24 15.32 10.24 14.54 9.46M8.88 16.53L7.47 15.12L8.88 16.53M6.24 22L9.88 18.36C9.54 18.27 9.21 18.12 8.91 17.91L4.83 22H6.24M2 22H3.41L8.18 17.24L6.76 15.83L2 20.59V22M2 19.17L6.09 15.09C5.88 14.79 5.73 14.46 5.64 14.12L2 17.76V19.17Z"/></svg>
      <span id="__fb-toolbar-title">ProtoLab</span>
      <span id="__fb-toolbar-hint">
        <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="flex-shrink:0"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span id="__fb-toolbar-hint-text"></span>
      </span>
    </div>
    <div id="__fb-toolbar-right">
      <button id="__fb-shot-btn" type="button" title="Capture a screenshot of the shared view when you place a comment">
        <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
        <span id="__fb-shot-label">Enable screenshots</span>
      </button>
      <div id="__fb-mode-switcher">
        <button class="fb-mode-btn active-view" data-mode="view">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          View
        </button>
        <button class="fb-mode-btn" data-mode="comment">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          Comment
        </button>
      </div>
    </div>
  `;
  document.body.insertBefore(toolbar, document.body.firstChild);

  // Version switcher: only when more than one published version exists. Reloads
  // the share URL with ?version=N (CSP-safe: addEventListener, no inline handler).
  if (VERSIONS.length > 1) {
    const toolbarLeft = toolbar.querySelector('#__fb-toolbar-left');
    const sel = document.createElement('select');
    sel.id = '__fb-version-switcher';
    VERSIONS.forEach(function (v) {
      const opt = document.createElement('option');
      opt.value = v.version;
      opt.textContent = 'v' + v.version + (v.isCurrent ? ' (live)' : '');
      if (VERSION != null && v.version === VERSION) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () {
      window.location.assign(VIEW_BASE + '?version=' + sel.value);
    });
    toolbarLeft.appendChild(sel);
  }

  // Comment-mode hint text lives inline in the toolbar (shown via the
  // body.__fb-comment-mode CSS). Wording depends on how this proto is annotated.
  const hintText = document.getElementById('__fb-toolbar-hint-text');
  if (hintText) {
    hintText.innerHTML = (IS_MARKDOWN
      ? 'Select any text to leave a comment · '
      : 'Click any element to leave a comment · ') + '<kbd>Esc</kbd> to exit';
  }
  // Tag the body so the markdown-only CSS (text cursor, selection-first) applies.
  if (IS_MARKDOWN) document.body.classList.add('__fb-markdown');

  /* ── pin layer ── */
  const pinContainer = document.createElement('div');
  pinContainer.id = '__fb-pins';
  document.body.appendChild(pinContainer);

  /* ── range highlight / gutter marker layer ── */
  const rangeLayer = document.createElement('div');
  rangeLayer.id = '__fb-ranges';
  rangeLayer.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483637';
  document.body.appendChild(rangeLayer);

  /* ── sidebar ── */
  const sidebar = document.createElement('div');
  sidebar.id = '__fb-sidebar';
  sidebar.innerHTML = `
  <div id="__fb-sidebar-strip" title="Show comments">
    <button id="__fb-sidebar-collapse" style="transform:none">&#8250;</button>
    <span id="__fb-sidebar-badge">0</span>
    <span id="__fb-sidebar-strip-label">Comments</span>
  </div>
  <div id="__fb-sidebar-main">
    <div id="__fb-sidebar-tabs">
      <button class="fb-sidebar-tab active" data-tab="pins">
        Pins <span class="fb-sidebar-tab-badge" id="__fb-pins-badge">0</span>
      </button>
      <button class="fb-sidebar-tab" data-tab="general">
        General <span class="fb-sidebar-tab-badge" id="__fb-gen-badge">0</span>
      </button>
      <button id="__fb-sidebar-collapse">&#8250;</button>
    </div>
    <div id="__fb-sidebar-pins" class="active">
      <div id="__fb-sidebar-pins-list"></div>
    </div>
    <div id="__fb-sidebar-general">
      <div id="__fb-sidebar-gen-list"></div>
      <div id="__fb-sidebar-gen-form">
        <textarea id="__fb-sidebar-gen-input" rows="3" placeholder="Add a general comment…"></textarea>
        <button id="__fb-sidebar-gen-submit">Post comment</button>
      </div>
    </div>
  </div>
`;
  document.body.appendChild(sidebar);

  /* ── hide-comments toggle ── */
  const hideToggleEl = document.createElement('button');
  hideToggleEl.id = '__fb-hide-toggle';
  hideToggleEl.type = 'button';
  hideToggleEl.setAttribute('aria-pressed', 'false');
  document.body.appendChild(hideToggleEl);
  // HTML prototypes have no on-canvas pins to show/hide — the toggle is irrelevant.
  if (IS_HTML_PROTO) hideToggleEl.style.display = 'none';

  /* ── draft card ── */
  const draftCard = document.createElement('div');
  draftCard.id = '__fb-draft-card';
  draftCard.innerHTML = `
    <div class="fb-draft-header">
      <span class="fb-draft-title">New comment</span>
      <button class="fb-draft-close" id="__fb-draft-close">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="fb-draft-selector" id="__fb-draft-selector"></div>
    <div id="__fb-draft-shot-wrap" class="no-shot">
      <img id="__fb-draft-shot-img" alt="" />
    </div>
    <div class="fb-tag-row" id="__fb-tag-row">
      ${TAGS.map(t => `<button class="fb-tag-pill" data-tag="${t}" style="border-color:${TAG_COLOR[t]};color:${TAG_COLOR[t]}">${TAG_LABEL[t]}</button>`).join('')}
    </div>
    <textarea id="__fb-draft-textarea" rows="4" placeholder="What's your feedback?"></textarea>
    <button id="__fb-draft-submit" disabled>Post comment</button>
  `;
  document.body.appendChild(draftCard);

  /* ── toast ── */
  const toast = document.createElement('div');
  toast.id = '__fb-toast';
  document.body.appendChild(toast);

  /* ── screenshot opt-in notice panel ── */
  // A styled inline panel (preferred over window.confirm) shown once, before the
  // first getDisplayMedia prompt, explaining what capture does. The Enable button
  // handler calls getDisplayMedia directly so the user gesture is preserved.
  const shotNotice = document.createElement('div');
  shotNotice.id = '__fb-shot-notice';
  shotNotice.innerHTML = `
    <h4>Enable screenshots?</h4>
    <p>When you place a comment, ProtoLab will capture a screenshot of the view you're sharing, so the prototype owner sees exactly what you saw.</p>
    <ul>
      <li>Your browser will ask what to share — pick <strong>this tab</strong>, not your whole screen.</li>
      <li>A recording indicator stays visible while sharing is on.</li>
      <li>Avoid entering anything into the prototype you don't want preserved.</li>
    </ul>
    <div class="fb-shot-actions">
      <button class="fb-btn-sm fb-btn-ghost" id="__fb-shot-cancel">Not now</button>
      <button class="fb-btn-sm fb-btn-primary" id="__fb-shot-ok">Enable</button>
    </div>
  `;
  document.body.appendChild(shotNotice);

  // Centered modal prompt shown the first time a reviewer switches to comment mode
  // without screenshots enabled. Welcoming, not alarming — explains the value and
  // lets them opt in or skip. Only shown once per session.
  const shotPromptBackdrop = document.createElement('div');
  shotPromptBackdrop.id = '__fb-shot-prompt-backdrop';
  shotPromptBackdrop.innerHTML = `
    <div id="__fb-shot-prompt">
      <div id="__fb-shot-prompt-icon">
        <svg width="22" height="22" fill="none" stroke="hsl(252,83%,57%)" stroke-width="2" viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
      </div>
      <h4>Add a screenshot to your comment?</h4>
      <p>Enabling screenshots lets the prototype owner see the exact context of your feedback — what was on screen when you wrote it. This makes comments much easier to understand, especially on complex flows.</p>
      <div class="fb-shot-prompt-actions">
        <button id="__fb-shot-prompt-enable" type="button">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          Enable screenshots
        </button>
        <button id="__fb-shot-prompt-skip" type="button">Continue without screenshots</button>
      </div>
    </div>
  `;
  document.body.appendChild(shotPromptBackdrop);

  /* ── helpers ── */
  // The reviewer's current page. In framed mode this is the iframe's URL (from the
  // bridge); otherwise it is the shell/document's own location.
  function currentHref() {
    return IS_FRAMED ? (framedHref || '') : location.href;
  }
  function currentPageKey() {
    if (IS_FRAMED) return pageKeyOf(framedHref || '');
    if (location.hash && location.hash.length > 1) return location.hash.slice(1);
    return location.pathname + location.search;
  }
  function pageKeyOf(url) {
    try {
      const u = new URL(url);
      if (u.hash && u.hash.length > 1) return u.hash.slice(1);
      return u.pathname + u.search;
    } catch (_) { return url; }
  }

  /* ── state ── */
  let mode = 'view';
  let commentsHidden = false; // View-tab toggle: hide on-canvas pins + range highlights for a clean read
  let pins = [];          // [{id,email,element_selector,comment,created_at,order,tag,x_pct,y_pct,page_url}]
  let generalComments = [];
  let sidebarExpanded = false;
  let pinPositions = {};  // {id: {x,y,visible}}
  let pinElements = {};   // {id: domElement} — persistent map for RAF repositioning
  let clusterElements = []; // cluster bubble elements for dimming
  let openPinId = null;
  let openClusterKey = null;
  let draft = null;       // {selector, xPct, yPct, tag}
  let rafId = null;
  let editingPinId = null;
  let unpinActive = null; // callback to close whichever pin is currently pinned open
  let reopenPinId = null; // set before loadPins(); consumed by renderPinEl to reopen the popover after re-render
  let navHistory = [];   // page URLs visited this session, for breadcrumb
  let rangeComments = [];        // [{id,email,comment,tag,anchor_quote,anchor_prefix,anchor_suffix,anchor_start,anchor_end,page_url,replies,created_at, order, __unresolved}]
  let rangeDraft = null;         // { anchor, tagSel } pending selection comment
  let suppressNextClick = false; // swallow the click that ends a selection mouseup
  let openRangePopoverEl = null; // the currently-open range popover element (one at a time)
  let now = Date.now();

  setInterval(() => { now = Date.now(); }, 1000);

  // HTML prototypes have no element pins — hide the Pins tab and default to General.
  if (IS_HTML_PROTO) {
    document.getElementById('__fb-sidebar-tabs').style.display = 'none';
    document.getElementById('__fb-sidebar-pins').classList.remove('active');
    document.getElementById('__fb-sidebar-general').classList.add('active');
  }

  /* ── mode switching ── */
  const hideToggle = document.getElementById('__fb-hide-toggle');
  const EYE_SVG = '<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF_SVG = '<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  // The pill advertises the action it performs: when comments are showing it
  // offers to hide them (eye-off); when hidden it offers to show them (eye).
  function renderHideToggle() {
    hideToggle.classList.toggle('active', commentsHidden);
    hideToggle.setAttribute('aria-pressed', String(commentsHidden));
    hideToggle.innerHTML = (commentsHidden ? EYE_SVG : EYE_OFF_SVG)
      + (commentsHidden ? 'Show comments' : 'Hide comments');
  }

  function setMode(m) {
    mode = m;
    document.querySelectorAll('.fb-mode-btn').forEach(btn => {
      const bm = btn.dataset.mode;
      btn.className = 'fb-mode-btn' + (bm === m ? ` active-${m}` : '');
    });
    // The hide-comments pill only makes sense on the View tab, and only for
    // non-HTML prototypes (HTML protos have no on-canvas pins to show/hide).
    hideToggle.style.display = (!IS_HTML_PROTO && m === 'view') ? 'inline-flex' : 'none';
    document.body.classList.toggle('__fb-comment-mode', m === 'comment');
    // Tell the bridge whether to intercept prototype clicks and show the crosshair.
    postToFrame({ type: 'commentMode', on: m === 'comment' });
    if (IS_FRAMED) layoutFrame(); // keep the iframe width in sync on mode change
    if (m !== 'comment') closeDraft();
    renderPinLayer();
    renderRangeLayer();
  }

  renderHideToggle();
  hideToggle.addEventListener('click', () => {
    commentsHidden = !commentsHidden;
    renderHideToggle();
    renderPinLayer();
    renderRangeLayer();
  });

  toolbar.querySelectorAll('.fb-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.mode;
      // First time switching to comment mode without screenshots: show a welcoming
      // prompt explaining the value. The user can enable (then enter comment mode)
      // or skip (enter comment mode directly). After the first time, don't re-ask.
      if (target === 'comment' && SHOT_SUPPORTED && !captureEnabled() && !shotPromptShown) {
        shotPromptShown = true;
        shotPromptBackdrop.classList.add('visible');
        return;
      }
      setMode(target);
    });
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (shotPromptBackdrop.classList.contains('visible')) {
        shotPromptBackdrop.classList.remove('visible');
        return;
      }
      if (openRangePopoverEl) { closeRangePopover(); return; }
      if (unpinActive) { unpinActive(); unpinActive = null; return; }
      if (draft || rangeDraft) { closeDraft(); return; }
      if (mode !== 'view') setMode('view');
    }
  });

  /* ── load pins ── */
  async function loadPins() {
    try {
      const resp = await fetch(withVersion('/api/comments/' + PROTO_ID), { credentials: 'include' });
      if (resp.ok) {
        const all = await resp.json();
        pins = all.filter(c => c.element_selector);
        rangeComments = all.filter(c => c.type === 'range' && c.anchor_quote);
        generalComments = all.filter(c => !c.element_selector && c.type !== 'range' && !c.parent_id);
        rangeComments.forEach((c, i) => { c.order = i + 1; });
        requestAnimationFrame(() => requestAnimationFrame(() => {
          renderPinLayer();
          renderRangeLayer();
          renderSidebar();
          if (focusId) focusPin(focusId);
        }));
      }
    } catch (e) {}
  }

  function setSidebarExpanded(expanded, persist = true) {
    sidebarExpanded = expanded;
    sidebar.classList.toggle('expanded', expanded);
    sidebar.classList.toggle('collapsed', !expanded);
    const sidebarW = expanded ? '260px' : '32px';
    document.body.style.setProperty('--fb-sidebar-w', sidebarW);
    if (IS_FRAMED) {
      // Framed: resize the iframe instead of padding the body. This makes the
      // sidebar (and toolbar/banner) a hard boundary the prototype cannot cross.
      layoutFrame();
    } else {
      document.body.style.paddingRight = sidebarW;
    }
    if (persist) {
      try { localStorage.setItem('__fb_sidebar_' + PROTO_ID, expanded ? '1' : '0'); } catch (_) {}
    }
  }

  // Position/size the prototype iframe within the shell so it fills the area below
  // the toolbar and left of the sidebar. Only used in framed mode. The toolbar is a
  // fixed 44px in every mode (the comment hint is inline, not a separate stripe).
  function layoutFrame() {
    if (!PROTO_FRAME) return;
    const sidebarW = sidebarExpanded ? 260 : 32;
    const topOffset = 44; // toolbar height
    PROTO_FRAME.style.top = topOffset + 'px';
    PROTO_FRAME.style.height = 'calc(100vh - ' + topOffset + 'px)';
    PROTO_FRAME.style.width = 'calc(100vw - ' + sidebarW + 'px)';
  }

  function renderSidebar() {
    const currentPage = currentPageKey();
    const pagePins = pins.filter(p =>
      !p.page_url || pageKeyOf(p.page_url) === currentPage
    );
    const pageRanges = rangeComments.filter(c =>
      !c.page_url || pageKeyOf(c.page_url) === currentPage
    );
    const pinsTabCount = pagePins.length + pageRanges.length;
    const totalCount = IS_HTML_PROTO ? generalComments.length : pinsTabCount + generalComments.length;

    const stored = (() => { try { return localStorage.getItem('__fb_sidebar_' + PROTO_ID); } catch (_) { return null; } })();
    if (stored === null) {
      setSidebarExpanded(totalCount > 0, false);
    }

    document.getElementById('__fb-pins-badge').textContent = pinsTabCount;
    document.getElementById('__fb-gen-badge').textContent = generalComments.length;
    document.getElementById('__fb-sidebar-badge').textContent = totalCount;

    const pinsList = document.getElementById('__fb-sidebar-pins-list');
    pinsList.innerHTML = '';
    if (pinsTabCount === 0) {
      pinsList.innerHTML = '<div class="fb-sidebar-empty">No pins on this page yet.</div>';
    } else {
      pagePins.forEach(p => {
        const avail = p.__avail || 'located';
        const row = document.createElement('div');
        row.className = 'fb-sidebar-pin-row' + (avail !== 'located' ? ' fb-sidebar-pin-row--unavailable' : '');
        row.setAttribute('data-pin-id', p.id);
        const tagHtml = p.tag
          ? `<span class="fb-sidebar-pin-tag" style="background:${TAG_COLOR[p.tag] || TAG_COLOR.other}">${TAG_LABEL[p.tag] || p.tag}</span>`
          : '';
        const repliesHtml = (p.replies && p.replies.length)
          ? `<div class="fb-sidebar-pin-replies">${p.replies.length} repl${p.replies.length === 1 ? 'y' : 'ies'}</div>`
          : '';
        // Honest availability messaging: absence is not deletion, and a hidden
        // target is distinguished from one that isn't in this view at all.
        const availHtml = avail === 'hidden'
          ? `<div class="fb-sidebar-pin-avail">⚠ Target is hidden in this view</div>`
          : avail === 'absent'
            ? `<div class="fb-sidebar-pin-avail">⚠ Target isn't available in this view</div>`
            : '';
        row.innerHTML = `
          <div class="fb-sidebar-pin-row-head">
            <div class="fb-sidebar-pin-dot" style="background:${TAG_COLOR[p.tag] || TAG_COLOR.other}">${p.order}</div>
            <span class="fb-sidebar-pin-email">${escHtml(p.email)}</span>
            ${tagHtml}
          </div>
          <div class="fb-sidebar-pin-body">${escHtml(p.comment)}</div>
          ${repliesHtml}
          ${availHtml}
        `;
        // Clicking the row opens the thread. When the target is on screen this
        // also locates the live pin (prior behaviour); when it isn't, the thread
        // opens inline in the sidebar — so reading/replying never depends on
        // reproducing the interaction that reveals the element.
        row.addEventListener('click', () => openThread(p.id));
        pinsList.appendChild(row);
      });

      pageRanges.forEach(c => {
        const row = document.createElement('div');
        row.className = 'fb-sidebar-pin-row';
        const tagHtml = c.tag
          ? `<span class="fb-sidebar-pin-tag" style="background:${TAG_COLOR[c.tag] || TAG_COLOR.other}">${TAG_LABEL[c.tag] || c.tag}</span>`
          : '';
        const repliesHtml = (c.replies && c.replies.length)
          ? `<div class="fb-sidebar-pin-replies">${c.replies.length} repl${c.replies.length === 1 ? 'y' : 'ies'}</div>`
          : '';
        const unresolvedHtml = c.__unresolved
          ? `<div class="fb-sidebar-pin-replies" style="font-style:italic">text no longer present</div>`
          : '';
        row.innerHTML = `
          <div class="fb-sidebar-pin-row-head">
            <div class="fb-sidebar-pin-dot" style="background:${TAG_COLOR[c.tag] || TAG_COLOR.other}">${c.order || ''}</div>
            <span class="fb-sidebar-pin-email">${escHtml(c.email)}</span>
            ${tagHtml}
          </div>
          <div class="fb-sidebar-pin-body">${escHtml(c.comment)}</div>
          ${repliesHtml}
          ${unresolvedHtml}
        `;
        row.addEventListener('click', () => {
          if (mode === 'comment') setMode('view');
          const mark = document.querySelector(`mark.__fb-mark[data-range-id="${c.id}"]`);
          if (mark) { mark.scrollIntoView({ behavior: 'smooth', block: 'center' }); openRangePopover(c, mark); }
        });
        pinsList.appendChild(row);
      });
    }

    const genList = document.getElementById('__fb-sidebar-gen-list');
    genList.innerHTML = '';
    if (generalComments.length === 0) {
      genList.innerHTML = '<div class="fb-sidebar-empty">No general comments yet.</div>';
    } else {
      generalComments.forEach(c => {
        const item = document.createElement('div');
        item.className = 'fb-sidebar-gen-item';
        const date = new Date(c.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        item.innerHTML = `
          <div class="fb-sidebar-gen-email">${escHtml(c.email)}</div>
          <div class="fb-sidebar-gen-body">${escHtml(c.comment)}</div>
          <div class="fb-sidebar-gen-date">${date}</div>
        `;
        genList.appendChild(item);
      });
    }
  }

  document.getElementById('__fb-sidebar-tabs').addEventListener('click', e => {
    const tabBtn = e.target.closest('.fb-sidebar-tab');
    if (!tabBtn) return;
    const tab = tabBtn.dataset.tab;
    document.querySelectorAll('.fb-sidebar-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.getElementById('__fb-sidebar-pins').classList.toggle('active', tab === 'pins');
    document.getElementById('__fb-sidebar-general').classList.toggle('active', tab === 'general');
  });

  sidebar.addEventListener('click', e => {
    if (e.target.closest('#__fb-sidebar-collapse') || e.target.closest('#__fb-sidebar-strip')) {
      setSidebarExpanded(!sidebarExpanded);
    }
  });

  document.getElementById('__fb-sidebar-gen-submit').addEventListener('click', async () => {
    const input = document.getElementById('__fb-sidebar-gen-input');
    const submitBtn = document.getElementById('__fb-sidebar-gen-submit');
    const text = input.value.trim();
    if (!text) return;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Posting…';
    try {
      // General comments have no element anchor, so capture with no pin point
      // (frame-relative xPct/yPct sent as null → owner-side draws at centre).
      const shot = captureScreenshot(null, null);
      const payload = { type: 'general', comment: text };
      if (shot) payload.screenshot = shot;
      await postComment(payload);
      input.value = '';
      await loadPins();
    } catch (_) {
      showToast('Failed to post comment.', true);
    }
    submitBtn.disabled = false;
    submitBtn.textContent = 'Post comment';
  });

  // Open a comment's thread. When its target is on screen we reuse the live
  // pin popover (full edit/delete/reply). When the target is hidden or absent
  // there is no pin to anchor to, so we expand a read + reply view inline in
  // the sidebar row — the thread stays usable regardless of the target state.
  function openThread(id) {
    const pin = pins.find(p => p.id === id);
    if (!pin) return;
    const avail = pin.__avail || 'located';
    if (avail === 'located' && pinElements[id]) {
      if (mode === 'comment') setMode('view');
      focusPin(id);
      setTimeout(() => {
        const pinEl = pinElements[id];
        if (pinEl) pinEl.click();
      }, 50);
      return;
    }
    renderInlineThread(id);
  }

  // Expand/collapse an inline read+reply thread inside a sidebar row. Scoped to
  // read and reply; edit/delete stay on the live pin (reached via Locate once
  // the target is on screen), so we don't duplicate the edit-window UI here.
  // forceOpen=false toggles (sidebar row click); forceOpen=true always (re-)opens,
  // used after a reply reload so the thread doesn't toggle shut on the fresh row.
  function renderInlineThread(id, forceOpen = false) {
    const row = document.querySelector(`.fb-sidebar-pin-row[data-pin-id="${id}"]`);
    if (!row) return;
    const existing = row.querySelector('.fb-inline-thread');
    if (existing) {
      if (forceOpen) existing.remove(); // rebuild below with the latest replies
      else { existing.remove(); return; } // plain toggle off
    }
    const pin = pins.find(p => p.id === id);
    if (!pin) return;

    const repliesHtml = (pin.replies || []).map(r => {
      const rDate = new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
      return `<div class="fb-inline-thread__reply">
        <span class="fb-inline-thread__reply-email">${escHtml(r.email)}</span>
        <span>${escHtml(r.comment)}</span>
        <span class="fb-inline-thread__reply-date">· ${rDate}</span>
      </div>`;
    }).join('');

    const wrap = document.createElement('div');
    wrap.className = 'fb-inline-thread';
    wrap.innerHTML = `
      ${repliesHtml}
      <textarea rows="2" placeholder="Reply…"></textarea>
      <button class="fb-inline-thread__btn" disabled>Reply</button>
    `;
    wrap.addEventListener('click', e => e.stopPropagation());
    const ta = wrap.querySelector('textarea');
    const btn = wrap.querySelector('.fb-inline-thread__btn');
    ta.addEventListener('input', () => { btn.disabled = !ta.value.trim(); });
    btn.addEventListener('click', async () => {
      const text = ta.value.trim();
      if (!text) return;
      btn.disabled = true;
      btn.textContent = 'Posting…';
      try {
        await postComment({ type: 'reply', comment: text, parentId: id });
        showToast('Reply posted.');
        await loadPins();
        // loadPins defers its renderSidebar by a double rAF, so re-open the
        // thread after that rebuild (matching nesting) and force it open — the
        // fresh row has no thread yet, and we must not toggle it shut.
        requestAnimationFrame(() => requestAnimationFrame(() => renderInlineThread(id, true)));
      } catch (_) {
        showToast('Failed to post reply.', true);
        btn.disabled = false;
        btn.textContent = 'Reply';
      }
    });
    row.appendChild(wrap);
  }

  function focusPin(id, attempts = 0) {
    const pin = pinElements[id];
    // Bounded retry: if the pin never materialises (target not rendered), give
    // up rather than reschedule forever.
    if (!pin) { if (attempts < 60) requestAnimationFrame(() => focusPin(id, attempts + 1)); return; }
    Object.entries(pinElements).forEach(([pid, el]) => {
      if (pid !== id) el.classList.add('fb-pin--dim');
    });
    clusterElements.forEach(el => el.classList.add('fb-cluster--dim'));
    pin.classList.add('fb-pin--focus');
    const pos = pinPositions[id];
    if (pos) window.scrollTo({ top: Math.max(0, pos.y - window.innerHeight / 2), behavior: 'smooth' });
    pin.addEventListener('animationend', () => {
      pin.classList.remove('fb-pin--focus');
      Object.values(pinElements).forEach(el => el.classList.remove('fb-pin--dim'));
      clusterElements.forEach(el => el.classList.remove('fb-cluster--dim'));
    }, { once: true });
  }

  /* ── pin position polling ── */
  // A pin's target can be in one of three states, which the sidebar renders
  // differently and which govern whether a live pin is drawn:
  //   'located' — resolved and actually rendered (a pin is shown)
  //   'hidden'  — resolved but not rendered (display:none, collapsed, zero-box)
  //   'absent'  — selector resolves to nothing (or throws)
  // Absence is NOT treated as deletion: the element may simply not exist in the
  // current interaction state. The thread stays openable in every state.
  function isRendered(el) {
    // offsetParent is null for display:none (and fixed-position edge cases,
    // which we then confirm via the box). visibility:hidden keeps layout boxes
    // but must not count as rendered. Resolve computed style once — this runs
    // for every pin on every animation frame, so avoid duplicate style reads.
    const cs = getComputedStyle(el);
    if (el.offsetParent === null && cs.position !== 'fixed') return false;
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  function recomputePositions() {
    const map = {};
    let availChanged = false;
    const setAvail = (p, next) => {
      if (p.__avail !== next) { p.__avail = next; availChanged = true; }
    };
    pins.forEach(p => {
      if (!p.element_selector) { map[p.id] = { x: 0, y: 0, visible: false }; setAvail(p, 'absent'); return; }
      if (p.page_url && pageKeyOf(p.page_url) !== currentPageKey()) {
        // Off-page: not a target-availability judgement, so leave __avail as-is.
        map[p.id] = { x: 0, y: 0, visible: false };
        return;
      }
      try {
        const el = document.querySelector(p.element_selector);
        if (!el) {
          map[p.id] = { x: 0, y: 0, visible: false };
          setAvail(p, 'absent');
          return;
        }
        if (!isRendered(el)) {
          map[p.id] = { x: 0, y: 0, visible: false };
          setAvail(p, 'hidden');
          return;
        }
        setAvail(p, 'located');
        const r = el.getBoundingClientRect();
        const ox = typeof p.x_pct === 'number' ? p.x_pct : 0.5;
        const oy = typeof p.y_pct === 'number' ? p.y_pct : 0.5;
        map[p.id] = { visible: true, x: r.left + r.width * ox, y: r.top + r.height * oy };
      } catch (_) {
        map[p.id] = { x: 0, y: 0, visible: false };
        setAvail(p, 'absent');
      }
    });
    if (draft?.selector) {
      try {
        const el = document.querySelector(draft.selector);
        if (el) {
          const r = el.getBoundingClientRect();
          map['__draft__'] = { visible: true, x: r.left + r.width * draft.xPct, y: r.top + r.height * draft.yPct };
        }
      } catch (_) {}
    }

    // If the set of visible pins changed, rebuild the DOM
    const prevVisible = new Set(Object.keys(pinElements));
    const nextVisible = new Set(Object.entries(map).filter(([, v]) => v.visible).map(([k]) => k));
    const visibilityChanged = prevVisible.size !== nextVisible.size ||
      [...nextVisible].some(id => !prevVisible.has(id));

    pinPositions = map;

    if (visibilityChanged) {
      renderPinLayer();
    } else {
      // Directly update positions of existing pin DOM elements
      Object.entries(pinElements).forEach(([id, el]) => {
        const pos = map[id];
        if (!pos) return;
        el.style.left = pos.x + 'px';
        el.style.top = pos.y + 'px';
        el.style.display = pos.visible ? '' : 'none';
      });
    }

    if (availChanged) renderSidebar();

    repositionRangeMarkers();
    rafId = requestAnimationFrame(recomputePositions);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }
    else if (!rafId) rafId = requestAnimationFrame(recomputePositions);
  });

  /* ── clustering ── */
  function buildClusters(visibleItems) {
    const used = new Array(visibleItems.length).fill(false);
    const clusters = [];
    for (let i = 0; i < visibleItems.length; i++) {
      if (used[i]) continue;
      const group = [visibleItems[i]];
      used[i] = true;
      for (let j = i + 1; j < visibleItems.length; j++) {
        if (used[j]) continue;
        const dx = visibleItems[j].pos.x - visibleItems[i].pos.x;
        const dy = visibleItems[j].pos.y - visibleItems[i].pos.y;
        if (Math.hypot(dx, dy) < CLUSTER_PX) { group.push(visibleItems[j]); used[j] = true; }
      }
      const cx = group.reduce((s, g) => s + g.pos.x, 0) / group.length;
      const cy = group.reduce((s, g) => s + g.pos.y, 0) / group.length;
      clusters.push({ x: cx, y: cy, members: group });
    }
    return clusters;
  }

  /* ── render ── */
  function renderPinLayer() {
    pinContainer.innerHTML = '';
    pinElements = {};
    clusterElements = [];
    if (mode === 'view' && commentsHidden) return;

    const visibleItems = pins
      .map((p, i) => ({ pin: p, idx: i + 1, pos: pinPositions[p.id] }))
      .filter(x => x.pos?.visible);

    const clusters = buildClusters(visibleItems);

    clusters.forEach(c => {
      const key = c.members.map(m => m.pin.id).join('|');
      if (c.members.length === 1) {
        renderPinEl(c.members[0], c.x, c.y);
      } else if (openClusterKey === key) {
        const radius = 28;
        c.members.forEach((m, i) => {
          const angle = (i / c.members.length) * Math.PI * 2 - Math.PI / 2;
          renderPinEl(m, c.x + Math.cos(angle) * radius, c.y + Math.sin(angle) * radius);
        });
        const collapseBtn = document.createElement('div');
        collapseBtn.className = 'fb-cluster';
        collapseBtn.style.cssText = `left:${c.x}px;top:${c.y}px;width:10px;height:10px;background:hsl(220,13%,87%)`;
        collapseBtn.addEventListener('click', () => { openClusterKey = null; renderPinLayer(); });
        pinContainer.appendChild(collapseBtn);
        clusterElements.push(collapseBtn);
      } else {
        const btn = document.createElement('div');
        btn.className = 'fb-cluster';
        btn.textContent = c.members.length;
        btn.style.cssText = `left:${c.x}px;top:${c.y}px`;
        btn.addEventListener('click', () => { openClusterKey = key; renderPinLayer(); });
        pinContainer.appendChild(btn);
        clusterElements.push(btn);
      }
    });

    // draft pin
    if (draft && pinPositions['__draft__']?.visible) {
      const pos = pinPositions['__draft__'];
      const dPin = document.createElement('div');
      dPin.className = 'fb-pin fb-pin--draft';
      dPin.style.cssText = `left:${pos.x}px;top:${pos.y}px;background:${TAG_COLOR[draft.tag || 'other']}`;
      pinContainer.appendChild(dPin);
      pinElements['__draft__'] = dPin;
    }
  }

  function renderPinEl(item, x, y) {
    const pin = item.pin;

    const btn = document.createElement('div');
    btn.className = 'fb-pin';
    btn.textContent = item.idx;
    btn.style.cssText = `left:${x}px;top:${y}px;background:${TAG_COLOR[pin.tag || 'other']}`;
    btn.dataset.pinId = pin.id;

    pinElements[pin.id] = btn;

    const ageMs = now - new Date(pin.created_at).getTime();
    const canEdit = pin.email === EMAIL && ageMs < EDIT_WINDOW_MS;

    // popover
    let popoverEl = null;
    let hideTimer = null;
    const cancelHide = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } };
    const scheduleHide = () => { if (pinned) return; cancelHide(); hideTimer = setTimeout(() => { if (!pinned) hidePopover(); }, 120); };

    const showPopover = () => {
      cancelHide();
      if (popoverEl) return;
      openPinId = pin.id;
      btn.style.zIndex = '1';
      popoverEl = document.createElement('div');
      popoverEl.className = 'fb-popover';
      popoverEl.addEventListener('mouseenter', cancelHide);
      popoverEl.addEventListener('mouseleave', e => {
        if (pinned) return;
        if (e.relatedTarget && btn.contains(e.relatedTarget)) return;
        scheduleHide();
      });

      const tagHtml = pin.tag
        ? `<div class="fb-popover__tag" style="background:${TAG_COLOR[pin.tag]}">${TAG_LABEL[pin.tag]}</div>`
        : '';

      const timeStr = new Date(pin.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

      if (editingPinId === pin.id) {
        popoverEl.innerHTML = `${tagHtml}
          <textarea rows="3">${escHtml(pin.comment)}</textarea>
          <div class="fb-popover__save">
            <button class="fb-btn-sm fb-btn-ghost" id="__pop-cancel">Cancel</button>
            <button class="fb-btn-sm fb-btn-primary" id="__pop-save">Save</button>
          </div>`;
        btn.appendChild(popoverEl);
        popoverEl.querySelector('#__pop-cancel').onclick = () => { editingPinId = null; hidePopover(); };
        const saveBtn = popoverEl.querySelector('#__pop-save');
        const ta = popoverEl.querySelector('textarea');
        saveBtn.onclick = async () => {
          const newBody = ta.value.trim();
          if (!newBody) return;
          await updateComment(pin.id, newBody);
        };
      } else {
        const actionsHtml = canEdit ? `
          <div class="fb-popover__actions">
            <span class="fb-popover__timer">${formatRemaining(EDIT_WINDOW_MS - ageMs)} left to edit</span>
            <div class="fb-popover__btns">
              <button class="fb-icon-btn" id="__pop-edit" title="Edit">
                <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              <button class="fb-icon-btn fb-icon-btn--danger" id="__pop-del" title="Delete">
                <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
              </button>
            </div>
          </div>` : '';

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

        // Flip popover left if it would overflow the right edge (accounting for sidebar width)
        const popRect = popoverEl.getBoundingClientRect();
        const sidebarW = sidebarExpanded ? 260 : 32;
        if (popRect.right > window.innerWidth - sidebarW - 8) {
          popoverEl.style.left = 'auto';
          popoverEl.style.right = 'calc(100% + 8px)';
        }
        // Flip up if it would overflow the bottom edge
        if (popRect.bottom > window.innerHeight - 8) {
          popoverEl.style.top = 'auto';
          popoverEl.style.bottom = '-4px';
        }

        if (canEdit) {
          popoverEl.querySelector('#__pop-edit').onclick = e => {
            e.stopPropagation();
            editingPinId = pin.id;
            hidePopover();
            showPopover();
          };
          popoverEl.querySelector('#__pop-del').onclick = async e => {
            e.stopPropagation();
            await deleteComment(pin.id);
          };
        }

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
            reopenPinId = pin.id;
            await loadPins();
            // reopenPinId is consumed by renderPinEl after re-render
          } catch (_) {
            showToast('Failed to post reply.', true);
            replyBtn.disabled = false;
            replyBtn.textContent = 'Reply';
          }
        });
      }
    };

    const hidePopover = () => {
      if (popoverEl) { popoverEl.remove(); popoverEl = null; }
      btn.style.zIndex = '';
      if (openPinId === pin.id) openPinId = null;
      pinned = false;
      if (unpinActive === doHide) unpinActive = null;
    };
    const doHide = hidePopover;

    let pinned = false;

    btn.addEventListener('mouseenter', showPopover);
    btn.addEventListener('mouseleave', e => {
      if (pinned) return;
      if (e.relatedTarget && (btn.contains(e.relatedTarget) || (popoverEl && popoverEl.contains(e.relatedTarget)))) return;
      scheduleHide();
    });
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (pinned) return; // already pinned, let outside-click handler close
      pinned = true;
      if (unpinActive && unpinActive !== doHide) unpinActive();
      unpinActive = doHide;
      showPopover();
    });

    pinContainer.appendChild(btn);

    // If this pin was just replied to, reopen its popover after re-render
    if (reopenPinId === pin.id) {
      reopenPinId = null;
      setTimeout(showPopover, 0);
    }
  }

  /* ── range highlight rendering ── */
  function hslAlpha(hsl, a) { return hsl.replace('hsl(', 'hsla(').replace(')', `,${a})`); }

  function renderRangeLayer() {
    // unwrap previous marks
    document.querySelectorAll('mark.__fb-mark').forEach(m => {
      const parent = m.parentNode; if (!parent) return;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize && parent.normalize();
    });
    rangeLayer.innerHTML = '';
    if (mode === 'view' && commentsHidden) return;

    rangeComments.forEach(c => {
      if (c.page_url && pageKeyOf(c.page_url) !== currentPageKey()) return;
      const anchor = { quote: c.anchor_quote, prefix: c.anchor_prefix, suffix: c.anchor_suffix, start: c.anchor_start, end: c.anchor_end };
      const range = window.FBAnchor && window.FBAnchor.resolveAnchor(anchor, document.body);
      if (!range) { c.__unresolved = true; return; }
      c.__unresolved = false;
      const color = TAG_COLOR[c.tag] || TAG_COLOR.other;
      // Wrap the highlight as one <mark> per intersecting text node. A single
      // surroundContents() throws on any multi-text-node range — which rendered
      // markdown produces constantly (a word next to **bold** / `code` / a link
      // spans two text nodes) — leaving the text un-highlighted AND the pin
      // unable to track it on scroll. Per-node marks never throw.
      const marks = (window.FBAnchor && window.FBAnchor.wrapRange(range, document.body, () => {
        const mark = document.createElement('mark');
        mark.className = '__fb-mark';
        mark.style.cssText = `background:${hslAlpha(color, 0.28)};color:inherit;border-radius:2px;cursor:pointer`;
        mark.dataset.rangeId = c.id;
        return mark;
      })) || [];
      marks.forEach(mark => mark.addEventListener('click', ev => { ev.stopPropagation(); openRangePopover(c, mark); }));
      // Position the pin off the LAST mark (end of the highlighted run); fall back
      // to the raw range if nothing could be wrapped (e.g. quote resolved but every
      // slice was un-wrappable — rare).
      const posTarget = marks.length ? marks[marks.length - 1] : range;
      const pos = window.FBAnchor && window.FBAnchor.markerPos(posTarget);
      if (!pos) return;
      const marker = document.createElement('div');
      marker.className = 'fb-pin';
      marker.textContent = c.order || '';
      marker.style.cssText = `position:fixed;left:${pos.left}px;top:${pos.top}px;background:${color};pointer-events:auto`;
      marker.dataset.rangeMarker = c.id;
      marker.addEventListener('click', ev => { ev.stopPropagation(); openRangePopover(c, marker); });
      rangeLayer.appendChild(marker);
    });
  }

  function repositionRangeMarkers() {
    rangeComments.forEach(c => {
      if (c.__unresolved) return;
      if (c.page_url && pageKeyOf(c.page_url) !== currentPageKey()) return;
      // A highlight may be several <mark>s (one per text node); the pin sits off
      // the END of the run, so track the LAST mark for this range.
      const marks = document.querySelectorAll(`mark.__fb-mark[data-range-id="${c.id}"]`);
      const mark = marks.length ? marks[marks.length - 1] : null;
      const marker = rangeLayer.querySelector(`[data-range-marker="${c.id}"]`);
      if (mark && marker) {
        const pos = window.FBAnchor && window.FBAnchor.markerPos(mark);
        if (pos) { marker.style.left = pos.left + 'px'; marker.style.top = pos.top + 'px'; }
      }
    });
  }

  // The currently-open range popover element (only one open at a time).
  function closeRangePopover() {
    if (openRangePopoverEl) { openRangePopoverEl.remove(); openRangePopoverEl = null; }
  }

  function openRangePopover(c, anchorEl) {
    closeRangePopover();
    // Close any pinned pin popover too, so only one thing is open.
    if (unpinActive) { unpinActive(); unpinActive = null; }

    const ageMs = now - new Date(c.created_at).getTime();
    const canEdit = c.email === EMAIL && ageMs < EDIT_WINDOW_MS;

    const pop = document.createElement('div');
    pop.className = 'fb-popover';
    pop.style.cssText = 'position:fixed;left:0;top:0';
    openRangePopoverEl = pop;

    function renderView() {
      const tagHtml = c.tag
        ? `<div class="fb-popover__tag" style="background:${TAG_COLOR[c.tag]}">${TAG_LABEL[c.tag]}</div>`
        : '';
      const timeStr = new Date(c.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

      const actionsHtml = canEdit ? `
        <div class="fb-popover__actions">
          <span class="fb-popover__timer">${formatRemaining(EDIT_WINDOW_MS - ageMs)} left to edit</span>
          <div class="fb-popover__btns">
            <button class="fb-icon-btn" id="__rpop-edit" title="Edit">
              <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="fb-icon-btn fb-icon-btn--danger" id="__rpop-del" title="Delete">
              <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
            </button>
          </div>
        </div>` : '';

      const repliesHtml = (c.replies || []).map(r => {
        const rDate = new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
        return `<div class="fb-popover__reply">
          <span class="fb-popover__reply-email">${escHtml(r.email)}</span>
          <span class="fb-popover__reply-body">${escHtml(r.comment)}</span>
          <span class="fb-popover__reply-date">· ${rDate}</span>
        </div>`;
      }).join('');
      const repliesBlock = (c.replies && c.replies.length)
        ? `<div class="fb-popover__replies">${repliesHtml}</div>`
        : '';

      const quoteBlock = c.anchor_quote
        ? `<div class="fb-popover__meta" style="font-style:italic;margin-top:0;margin-bottom:6px;color:hsl(220,9%,46%)">“${escHtml(String(c.anchor_quote).slice(0, 80))}${String(c.anchor_quote).length > 80 ? '…' : ''}”</div>`
        : '';

      pop.innerHTML = `${tagHtml}
        ${quoteBlock}
        <div class="fb-popover__body">${escHtml(c.comment)}</div>
        <div class="fb-popover__meta">${escHtml(c.email)} · ${timeStr}</div>
        ${actionsHtml}
        ${repliesBlock}
        <div class="fb-reply-form">
          <textarea class="fb-reply-input" rows="1" placeholder="Reply…"></textarea>
          <button class="fb-reply-btn" disabled>Reply</button>
        </div>`;

      if (canEdit) {
        pop.querySelector('#__rpop-edit').onclick = ev => { ev.stopPropagation(); renderEdit(); position(); };
        pop.querySelector('#__rpop-del').onclick = async ev => {
          ev.stopPropagation();
          closeRangePopover();
          await deleteComment(c.id);
        };
      }

      const replyInput = pop.querySelector('.fb-reply-input');
      const replyBtn = pop.querySelector('.fb-reply-btn');
      replyInput.addEventListener('input', () => { replyBtn.disabled = !replyInput.value.trim(); });
      replyBtn.addEventListener('click', async ev => {
        ev.stopPropagation();
        const text = replyInput.value.trim();
        if (!text) return;
        replyBtn.disabled = true;
        replyBtn.textContent = 'Posting…';
        try {
          await postComment({ type: 'reply', comment: text, parentId: c.id });
          showToast('Reply posted.');
          closeRangePopover();
          await loadPins();
        } catch (_) {
          showToast('Failed to post reply.', true);
          replyBtn.disabled = false;
          replyBtn.textContent = 'Reply';
        }
      });
    }

    function renderEdit() {
      const tagHtml = c.tag
        ? `<div class="fb-popover__tag" style="background:${TAG_COLOR[c.tag]}">${TAG_LABEL[c.tag]}</div>`
        : '';
      pop.innerHTML = `${tagHtml}
        <textarea rows="3">${escHtml(c.comment)}</textarea>
        <div class="fb-popover__save">
          <button class="fb-btn-sm fb-btn-ghost" id="__rpop-cancel">Cancel</button>
          <button class="fb-btn-sm fb-btn-primary" id="__rpop-save">Save</button>
        </div>`;
      pop.querySelector('#__rpop-cancel').onclick = ev => { ev.stopPropagation(); renderView(); position(); };
      const saveBtn = pop.querySelector('#__rpop-save');
      const ta = pop.querySelector('textarea');
      saveBtn.onclick = async ev => {
        ev.stopPropagation();
        const newBody = ta.value.trim();
        if (!newBody) return;
        closeRangePopover();
        await updateComment(c.id, newBody);
      };
    }

    function position() {
      const r = anchorEl.getBoundingClientRect();
      const sidebarW = sidebarExpanded ? 260 : 32;
      pop.style.left = (r.right + 8) + 'px';
      pop.style.top = Math.max(48, r.top) + 'px';
      const pr = pop.getBoundingClientRect();
      if (pr.right > window.innerWidth - sidebarW - 8) {
        pop.style.left = Math.max(8, r.left - pr.width - 8) + 'px';
      }
      if (pr.bottom > window.innerHeight - 8) {
        pop.style.top = Math.max(48, window.innerHeight - pr.height - 8) + 'px';
      }
    }

    pop.addEventListener('click', ev => ev.stopPropagation());
    renderView();
    rangeLayer.appendChild(pop);
    position();
  }

  function spawnRipple(x, y) {
    const el = document.createElement('div');
    el.className = 'fb-click-ripple';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    document.body.appendChild(el);
    setTimeout(() => { try { el.remove(); } catch (_) {} }, 700);
  }

  // Handle a comment-mode click on an HTML prototype. Coordinates are in this
  // (shell) document's viewport space. In framed mode the caller has already
  // translated the iframe-local click point into shell-viewport px. Captures a
  // screenshot (with a marker at the click point) and opens the draft card.
  function handleProtoClick(vx, vy) {
    // A draft is a modal step: while its card is open, a click on the prototype
    // (which is what reached us here — the card itself is our own UI and never
    // routes through this path) means "dismiss and go back to plain comment
    // mode", NOT "start another comment". Without this guard a second click
    // captured a fresh screenshot while the first draft card was still on screen,
    // nesting a screenshot-in-a-screenshot. Closing keeps us in comment mode.
    if (draft || rangeDraft) { closeDraft(); return; }
    spawnRipple(vx, vy);
    const shot = captureScreenshot(vx, vy);
    draft = { selector: null, xPct: null, yPct: null, tag: null, shot };
    rangeDraft = null;
    openDraftCard(null);
    showDraftShotPreview(shot);
  }


  /* ── text-selection → range comment ── */
  document.addEventListener('mouseup', () => {
    if (mode !== 'comment') return;
    if (IS_HTML_PROTO) return; // HTML prototypes use click-to-comment, not text selection
    // A draft is already open (modal step): don't let a fresh selection start a
    // competing range draft. The open card is the only active surface until it's
    // resolved (Post / Cancel / Esc / click-out).
    if (draft || rangeDraft) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const anc = range.commonAncestorContainer;
    const ancEl = anc.nodeType === 1 ? anc : anc.parentElement;
    if (isOwnUi(ancEl)) return;
    const anchor = window.FBAnchor && window.FBAnchor.serializeSelection(range, document.body);
    if (!anchor) return;
    rangeDraft = { anchor, tagSel: null };
    draft = null;
    // A drag-selection is normally followed by a click event we must swallow (so it
    // doesn't also drop an element pin). But a pure drag sometimes fires no click at
    // all — so self-expire the flag on the next tick to avoid eating an unrelated
    // later click. The synthetic click (if any) fires before this timeout.
    suppressNextClick = true;
    setTimeout(() => { suppressNextClick = false; }, 0);
    openDraftCard('“' + anchor.quote.slice(0, 60) + (anchor.quote.length > 60 ? '…' : '') + '”');
    // Keep the browser selection visible so the user sees exactly what they're
    // annotating; it is cleared in closeDraft() (on Post or Cancel), not here.
    // The saved highlight <mark> is rendered by renderRangeLayer once posted.
  });

  document.addEventListener('click', e => {
    if (mode !== 'comment') return;
    // Never intercept clicks on our own UI (toolbar, banners, pins, sidebar,
    // draft card, range/pin popovers + their Delete/Edit buttons, tag pills…).
    // This MUST run before the suppress guard so a selection's trailing state can
    // never swallow a click on the draft card's Post button.
    if (isOwnUi(e.target)) return;
    // A draft/range-draft is a modal step. A click out here (not on our own UI)
    // dismisses it and returns to plain comment mode rather than starting a
    // second comment — mirrors handleProtoClick's guard for the framed path and
    // prevents nesting a new capture on top of the open draft card.
    if (draft || rangeDraft) { e.preventDefault(); e.stopPropagation(); closeDraft(); return; }
    // Swallow the click that ends a text-selection drag (so it doesn't also drop
    // an element pin). Only consumed for document clicks, never the UI clicks above.
    if (suppressNextClick) { suppressNextClick = false; e.preventDefault(); e.stopPropagation(); return; }

    // A text selection (range comment) always wins over dropping an element pin —
    // but only for markdown docs. HTML prototypes ignore text selections entirely.
    if (!IS_HTML_PROTO) {
      const sel = window.getSelection();
      const inLiveSelection = sel && !sel.isCollapsed && sel.rangeCount &&
        !isOwnUi((sel.anchorNode && sel.anchorNode.nodeType === 1 ? sel.anchorNode : (sel.anchorNode && sel.anchorNode.parentElement)));
      if (rangeDraft || inLiveSelection) {
        e.preventDefault(); e.stopPropagation();
        if (!rangeDraft && inLiveSelection) {
          // No draft yet (e.g. selection carried over from view mode without a
          // mouseup in comment mode): build the range draft from the live selection.
          const anchor = window.FBAnchor && window.FBAnchor.serializeSelection(sel.getRangeAt(0), document.body);
          if (anchor) { rangeDraft = { anchor, tagSel: null }; draft = null; openDraftCard('”' + anchor.quote.slice(0, 60) + (anchor.quote.length > 60 ? '…' : '') + '”'); }
        }
        return;
      }
    }

    // Markdown documents annotate by selection only — a bare click never drops a
    // free-floating element pin (which would “float” while scrolling since the
    // rendered doc has no meaningful element to anchor to).
    if (IS_MARKDOWN) { e.preventDefault(); e.stopPropagation(); return; }

    e.preventDefault(); e.stopPropagation();

    if (IS_HTML_PROTO) {
      // Non-framed HTML proto (legacy path): clientX/Y are already in this
      // document's viewport space.
      handleProtoClick(e.clientX, e.clientY);
      return;
    }

    const el = e.target;
    const selector = getCssSelector(el);
    const rect = el.getBoundingClientRect();
    const xPct = rect.width ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 0.5;
    const yPct = rect.height ? Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) : 0.5;

    draft = { selector, xPct, yPct, tag: null };
    rangeDraft = null;
    openDraftCard(selector);
  }, true);

  function openDraftCard(selector) {
    const selectorEl = document.getElementById('__fb-draft-selector');
    selectorEl.textContent = selector || '';
    selectorEl.style.display = selector ? '' : 'none';
    // Reset screenshot preview — will be populated by showDraftShotPreview if applicable.
    const shotWrap = document.getElementById('__fb-draft-shot-wrap');
    shotWrap.className = 'no-shot';
    document.getElementById('__fb-draft-shot-img').src = '';
    document.getElementById('__fb-draft-textarea').value = '';
    document.getElementById('__fb-draft-submit').disabled = true;
    // reset tags
    document.querySelectorAll('.fb-tag-pill').forEach(p => { p.classList.remove('active'); p.style.background = 'none'; p.style.color = TAG_COLOR[p.dataset.tag]; });
    if (draft) draft.tag = null;
    if (rangeDraft) rangeDraft.tagSel = null;
    draftCard.classList.add('visible');
    document.body.classList.add('__fb-draft-open');
    positionDraftCard();
    document.getElementById('__fb-draft-textarea').focus();
  }

  // Show the screenshot thumbnail in the draft card, or a hint to enable screenshots.
  function showDraftShotPreview(shot) {
    const shotWrap = document.getElementById('__fb-draft-shot-wrap');
    const shotImg  = document.getElementById('__fb-draft-shot-img');
    if (!shot || !shot.dataUrl) {
      shotWrap.className = 'no-shot';
      shotImg.src = '';
      return;
    }
    shotImg.onload = () => { draftCard.classList.add('has-shot'); positionDraftCard(); };
    shotImg.src = shot.dataUrl;
    shotWrap.className = '';
  }

  // Place the draft card next to what's being annotated instead of pinned to the
  // top-right corner (far from the user's eyes/selection). Anchor rect: the live
  // text selection for a range comment, else the clicked element for an element
  // pin. Prefer sitting to the RIGHT of the anchor; flip to the LEFT if it would
  // collide with the sidebar; clamp within the toolbar/​viewport so it's never cut
  // off. Falls back to the old top-right slot when there's no usable anchor.
  function positionDraftCard() {
    let rect = null;
    const sel = window.getSelection && window.getSelection();
    if (rangeDraft && sel && sel.rangeCount && !sel.isCollapsed) {
      rect = sel.getRangeAt(0).getBoundingClientRect();
    } else if (draft && draft.selector) {
      try { const el = document.querySelector(draft.selector); if (el) rect = el.getBoundingClientRect(); } catch (_) {}
    }
    const cardW = draftCard.offsetWidth || (draftCard.classList.contains('has-shot') ? 480 : 296);
    const cardH = draftCard.offsetHeight || 260;
    const sidebarW = sidebarExpanded ? 260 : 32;
    const GAP = 12, TOP_MIN = 52, MARGIN = 8;
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      // No anchor — keep the historical top-right placement.
      draftCard.style.left = 'auto';
      draftCard.style.right = (sidebarW + MARGIN) + 'px';
      draftCard.style.top = '60px';
      return;
    }
    const maxRight = window.innerWidth - sidebarW - MARGIN;
    let left = rect.right + GAP;
    if (left + cardW > maxRight) left = rect.left - GAP - cardW; // flip left
    if (left < MARGIN) left = MARGIN;                            // clamp left
    left = Math.min(left, maxRight - cardW);
    let top = rect.top;
    top = Math.max(TOP_MIN, Math.min(top, window.innerHeight - cardH - MARGIN));
    draftCard.style.right = 'auto';
    draftCard.style.left = Math.round(left) + 'px';
    draftCard.style.top = Math.round(top) + 'px';
  }

  document.getElementById('__fb-draft-close').addEventListener('click', closeDraft);

  document.getElementById('__fb-draft-textarea').addEventListener('input', e => {
    document.getElementById('__fb-draft-submit').disabled = !e.target.value.trim();
  });

  document.getElementById('__fb-tag-row').addEventListener('click', e => {
    const pill = e.target.closest('.fb-tag-pill');
    if (!pill || (!draft && !rangeDraft)) return;
    const t = pill.dataset.tag;
    const isActive = pill.classList.contains('active');
    document.querySelectorAll('.fb-tag-pill').forEach(p => { p.classList.remove('active'); p.style.background = 'none'; p.style.color = TAG_COLOR[p.dataset.tag]; });
    if (!isActive) {
      pill.classList.add('active');
      pill.style.background = TAG_COLOR[t];
      pill.style.color = '#fff';
      if (draft) draft.tag = t;
      if (rangeDraft) rangeDraft.tagSel = t;
    } else {
      if (draft) draft.tag = null;
      if (rangeDraft) rangeDraft.tagSel = null;
    }
  });

  document.getElementById('__fb-draft-submit').addEventListener('click', async () => {
    const text = document.getElementById('__fb-draft-textarea').value.trim();
    if (!text) return;
    const btn = document.getElementById('__fb-draft-submit');
    btn.disabled = true;
    btn.textContent = 'Posting…';
    try {
      if (rangeDraft) {
        await postComment({ type: 'range', comment: text, pageUrl: location.href, tag: rangeDraft.tagSel || null, anchor: rangeDraft.anchor, breadcrumb: navHistory });
      } else if (draft) {
        let shot, payload;
        if (IS_HTML_PROTO) {
          // HTML proto: general comment with screenshot, no DOM selector or pin.
          shot = draft.shot;
          payload = {
            type: 'general',
            comment: text,
            pageUrl: currentHref(),
            tag: draft.tag,
          };
        } else {
          // Non-HTML prototype: capture at submit time anchored to the element.
          shot = captureForElement(draft.selector, draft.xPct, draft.yPct);
          payload = {
            type: 'element',
            element: { selector: draft.selector, label: '', tagName: '' },
            comment: text,
            pageUrl: location.href,
            tag: draft.tag,
            xPct: draft.xPct,
            yPct: draft.yPct,
            breadcrumb: navHistory,
          };
        }
        if (shot) payload.screenshot = shot;
        await postComment(payload);
      } else {
        btn.disabled = false;
        btn.textContent = 'Post comment';
        return;
      }
      closeDraft();
      await loadPins();
      showToast('Comment added.');
    } catch (_) {
      showToast('Failed to post comment.', true);
      btn.disabled = false;
      btn.textContent = 'Post comment';
    }
  });

  function closeDraft() {
    draft = null;
    rangeDraft = null;
    draftCard.classList.remove('visible');
    document.body.classList.remove('__fb-draft-open');
    // Restore the submit button to its resting state (it is left on "Posting…"
    // / disabled after a successful post) so the next draft opens clean.
    const submit = document.getElementById('__fb-draft-submit');
    if (submit) { submit.disabled = true; submit.textContent = 'Post comment'; }
    // Reset screenshot preview so it doesn't flash on the next open.
    const shotWrap = document.getElementById('__fb-draft-shot-wrap');
    if (shotWrap) { shotWrap.className = 'no-shot'; document.getElementById('__fb-draft-shot-img').src = ''; }
    draftCard.classList.remove('has-shot');
    // Drop the text selection now that the draft is resolved (posted or cancelled).
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.removeAllRanges && !sel.isCollapsed) sel.removeAllRanges();
  }

  /* ── api helpers ── */
  async function postComment(payload) {
    const resp = await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prototypeId: PROTO_ID, email: EMAIL, version: VERSION, ...payload }),
      credentials: 'include',
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return resp.json();
  }

  async function updateComment(id, comment) {
    const resp = await fetch('/api/comments/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment }),
      credentials: 'include',
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    editingPinId = null;
    showToast('Comment updated.');
    await loadPins();
  }

  async function deleteComment(id) {
    const resp = await fetch('/api/comments/' + id, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    showToast('Comment deleted.');
    await loadPins();
  }

  /* ── toast ── */
  function showToast(msg, isError) {
    toast.textContent = msg;
    toast.style.background = isError ? 'hsl(0,84%,45%)' : 'hsl(142,71%,30%)';
    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), 2500);
  }

  /* ── screenshot capture (opt-in, consented getDisplayMedia) ── */
  // Completely inert unless the reviewer opts in. We ask for the display stream
  // ONCE (from the Enable button's click handler — a user gesture is required),
  // keep the MediaStream alive for the session, and grab a still frame per pin by
  // drawing the live video to a canvas. On decline/stop/unsupported we silently
  // fall back to posting comments with no screenshot field.
  const SHOT_SUPPORTED = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  let captureStream = null;      // the live MediaStream once enabled (null = off)
  let captureVideo = null;       // hidden <video> fed by captureStream
  let shotNoticeShown = false;   // only show the explanatory notice once per session
  let shotPromptShown = false;   // only prompt once when first entering comment mode
  const shotBtn = document.getElementById('__fb-shot-btn');
  const shotLabel = document.getElementById('__fb-shot-label');

  function captureEnabled() { return !!captureStream; }

  function renderShotBtn() {
    if (!SHOT_SUPPORTED) {
      shotBtn.disabled = true;
      shotBtn.title = 'Screenshots not supported in this browser.';
      shotLabel.textContent = 'Screenshots off';
      return;
    }
    const on = captureEnabled();
    shotBtn.classList.toggle('active', on);
    shotLabel.textContent = on ? 'Screenshots on' : 'Enable screenshots';
    shotBtn.title = on
      ? 'Screenshots on — comments capture the shared view. Stop sharing from the browser bar to turn off.'
      : 'Capture a screenshot of the shared view when you place a comment';
  }

  // Tear down the session capture: called when the user stops the share from the
  // browser bar (track 'ended'), or if the stream dies. Leaves commenting intact.
  function teardownCapture() {
    try {
      if (captureStream) captureStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
    } catch (_) {}
    captureStream = null;
    if (captureVideo) { try { captureVideo.srcObject = null; captureVideo.remove(); } catch (_) {} captureVideo = null; }
    renderShotBtn();
  }

  // Must be invoked synchronously from a user gesture (click handler) — do not
  // await anything before calling getDisplayMedia or the gesture is lost.
  async function enableCapture() {
    if (!SHOT_SUPPORTED || captureEnabled()) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 5, displaySurface: 'browser' },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
      });
    } catch (_) {
      // Decline (NotAllowedError) or any failure: gentle toast, stay off, no re-prompt loop.
      showToast('Screenshots not enabled.');
      renderShotBtn();
      return;
    }
    captureStream = stream;
    // When the user stops sharing from the browser bar, the track ends — drop the
    // stream so subsequent pins post without a screenshot. No error surfaced.
    stream.getVideoTracks().forEach(t => { t.onended = teardownCapture; });

    captureVideo = document.createElement('video');
    captureVideo.id = '__fb-shot-video';
    captureVideo.muted = true;
    captureVideo.playsInline = true;
    captureVideo.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:-9999px';
    captureVideo.srcObject = stream;
    document.body.appendChild(captureVideo);
    try { await captureVideo.play(); } catch (_) {}
    renderShotBtn();
    showToast('Screenshots on.');
  }

  // Hide ALL of ProtoLab's own chrome (ids start with "__fb-") for a single frame
  // grab so the capture shows the prototype, not our overlay. Mirrors the intent
  // of the commentsHidden toggle but is exhaustive and synchronous. Returns a
  // restore() that puts every element's inline visibility back. The framed-mode
  // prototype iframe is itself a "__fb-" element but holds the content we WANT in
  // the shot, so it is explicitly preserved.
  function hideOwnChrome() {
    const nodes = document.querySelectorAll(FB_UI_SELECTOR);
    const restores = [];
    nodes.forEach(n => {
      if (n === PROTO_FRAME) return; // never hide the prototype itself
      restores.push([n, n.style.visibility]);
      n.style.visibility = 'hidden';
    });
    return function restore() {
      restores.forEach(([n, v]) => { n.style.visibility = v; });
    };
  }

  // Grab a still frame from the live capture stream, optionally cropped to the
  // prototype iframe (framed mode), with a marker drawn at the click point.
  // `vx`/`vy` are the click anchor in shell-viewport (client) px, or null.
  //
  // Returns the screenshot payload field, or null on any failure / capture-off.
  // NEVER throws — the caller must be able to post the comment regardless.
  //
  // Coordinate mapping (approximate, documented assumption): getDisplayMedia of a
  // tab yields a frame whose intrinsic size (videoWidth/Height) corresponds to the
  // shared surface ≈ the viewport. We scale viewport px by
  // (videoWidth / innerWidth, videoHeight / innerHeight) to land in frame space,
  // then (framed mode) crop that frame to the iframe's on-screen rectangle so the
  // saved image is the prototype alone.
  function captureScreenshot(vx, vy) {
    if (!captureEnabled() || !captureVideo) return null;
    const restore = hideOwnChrome();
    try {
      const vw = captureVideo.videoWidth;
      const vh = captureVideo.videoHeight;
      if (!vw || !vh) return null;
      if (!(window.innerWidth > 0) || !(window.innerHeight > 0)) return null;

      // Viewport px → frame px scale. getDisplayMedia of a tab yields a frame whose
      // intrinsic size corresponds to the shared surface ≈ the viewport.
      const sx = vw / window.innerWidth;
      const sy = vh / window.innerHeight;

      // In framed mode, crop the captured frame to just the prototype iframe's
      // on-screen rectangle so the screenshot is the prototype alone — no toolbar
      // strip, no sidebar, no blank margin. Non-framed capture keeps the full frame.
      let cropX = 0, cropY = 0, cropW = vw, cropH = vh;
      if (IS_FRAMED && PROTO_FRAME) {
        const r = PROTO_FRAME.getBoundingClientRect();
        cropX = Math.max(0, Math.round(r.left * sx));
        cropY = Math.max(0, Math.round(r.top * sy));
        cropW = Math.max(1, Math.min(vw - cropX, Math.round(r.width * sx)));
        cropH = Math.max(1, Math.min(vh - cropY, Math.round(r.height * sy)));
      }

      const canvas = document.createElement('canvas');
      canvas.width = cropW;
      canvas.height = cropH;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      // Draw only the crop region of the source frame onto the (crop-sized) canvas.
      ctx.drawImage(captureVideo, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

      // Marker coordinates, relative to the crop origin.
      let xPct = null, yPct = null;
      if (typeof vx === 'number' && typeof vy === 'number') {
        const fx = vx * sx - cropX;
        const fy = vy * sy - cropY;
        // Outer ring
        ctx.beginPath();
        ctx.arc(fx, fy, 36, 0, 2 * Math.PI);
        ctx.strokeStyle = 'hsl(252,83%,57%)';
        ctx.lineWidth = 4;
        ctx.stroke();
        // Inner filled dot
        ctx.beginPath();
        ctx.arc(fx, fy, 9, 0, 2 * Math.PI);
        ctx.fillStyle = 'hsl(252,83%,57%)';
        ctx.fill();
        // Cross hair lines — long arms reaching toward the ring from each side.
        ctx.strokeStyle = 'hsl(252,83%,57%)';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(fx - 54, fy); ctx.lineTo(fx - 42, fy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(fx + 42, fy); ctx.lineTo(fx + 54, fy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(fx, fy - 54); ctx.lineTo(fx, fy - 42); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(fx, fy + 42); ctx.lineTo(fx, fy + 54); ctx.stroke();
        xPct = Math.max(0, Math.min(1, fx / cropW));
        yPct = Math.max(0, Math.min(1, fy / cropH));
      }

      const dataUrl = canvas.toDataURL('image/png');
      return { dataUrl, w: cropW, h: cropH, xPct, yPct };
    } catch (_) {
      return null;
    } finally {
      restore();
    }
  }

  // Compute the pin's viewport-anchor (client px) from an element selector plus
  // the within-element xPct/yPct, then capture. Returns the screenshot field or
  // null. Used for element pins.
  function captureForElement(selector, elXPct, elYPct) {
    if (!captureEnabled()) return null;
    let vx = null, vy = null;
    try {
      const el = selector ? document.querySelector(selector) : null;
      if (el) {
        const r = el.getBoundingClientRect();
        const ox = typeof elXPct === 'number' ? elXPct : 0.5;
        const oy = typeof elYPct === 'number' ? elYPct : 0.5;
        vx = r.left + r.width * ox;
        vy = r.top + r.height * oy;
      }
    } catch (_) {}
    return captureScreenshot(vx, vy);
  }

  if (!SHOT_SUPPORTED) {
    renderShotBtn();
  } else {
    renderShotBtn();
    // Button click: first time, show the explanatory notice; thereafter the
    // notice's Enable button (still a user gesture) runs getDisplayMedia.
    shotBtn.addEventListener('click', () => {
      if (captureEnabled()) {
        // Already on — let the user turn it off from the toolbar too.
        teardownCapture();
        showToast('Screenshots off.');
        return;
      }
      if (!shotNoticeShown) {
        shotNoticeShown = true;
        shotNotice.classList.add('visible');
        return;
      }
      // Notice already seen earlier this session: enable directly from this gesture.
      enableCapture();
    });
    document.getElementById('__fb-shot-ok').addEventListener('click', () => {
      shotNotice.classList.remove('visible');
      enableCapture(); // still synchronous from this click → gesture preserved
    });
    document.getElementById('__fb-shot-cancel').addEventListener('click', () => {
      shotNotice.classList.remove('visible');
    });

    // Comment-mode screenshot prompt handlers. The Enable button runs
    // enableCapture() synchronously (preserving the user gesture), then enters
    // comment mode. Skip closes the modal and enters comment mode without screenshots.
    // Clicking the backdrop (outside the card) also skips and enters comment mode.
    document.getElementById('__fb-shot-prompt-enable').addEventListener('click', () => {
      shotPromptBackdrop.classList.remove('visible');
      enableCapture(); // synchronous gesture — getDisplayMedia fires immediately
      setMode('comment');
    });
    document.getElementById('__fb-shot-prompt-skip').addEventListener('click', () => {
      shotPromptBackdrop.classList.remove('visible');
      setMode('comment');
    });
    shotPromptBackdrop.addEventListener('click', (e) => {
      if (e.target === shotPromptBackdrop) {
        shotPromptBackdrop.classList.remove('visible');
        setMode('comment');
      }
    });
  }

  /* ── helpers ── */
  // Build the most stable selector we can for `el`. Preference order, most to
  // least stable: an author-provided data-protolab-id, a native id, then a
  // structural path anchored at the nearest id'd / data-protolab-id'd ancestor,
  // falling back to tag + first class + :nth-of-type. The positional fallback
  // can match a different element after dynamic insertion/reordering, which is
  // why the stable anchors are tried first.
  function stableAnchor(node) {
    const pid = node.getAttribute && node.getAttribute('data-protolab-id');
    if (pid) return '[data-protolab-id="' + CSS.escape(pid) + '"]';
    if (node.id) return '#' + CSS.escape(node.id);
    return null;
  }

  // Returns the most distinctive single class from a node's classList, or null.
  // Skips Angular-generated, utility, and very-short classes.
  function pickDistinctiveClass(node) {
    const rawClass = typeof node.className === 'string'
      ? node.className
      : (node.className && node.className.baseVal) || '';
    return rawClass.trim().split(/\s+/).find(c =>
      c.length >= 4 && c.length < 60 &&
      !/^(ng-|cdk-|mat-|p-|v-|data-v-|css-|sc-|_)/.test(c)
    ) || null;
  }

  // Heuristic: is this element an ephemeral overlay (dialog / modal / popover /
  // drawer / tooltip) that may not be in the DOM when the page is at rest?
  function isOverlayRoot(node) {
    const tag = node.tagName && node.tagName.toLowerCase();
    if (tag === 'dialog') return true;
    const rawClass = typeof node.className === 'string'
      ? node.className
      : (node.className && node.className.baseVal) || '';
    return /modal|dialog|overlay|drawer|popover|lightbox|tooltip|flyout|panel--open/i.test(rawClass) ||
      node.getAttribute('role') === 'dialog' ||
      node.getAttribute('aria-modal') === 'true';
  }

  function getCssSelector(el) {
    const self = stableAnchor(el);
    if (self) return self;
    const parts = [];
    let node = el;
    // Track the nearest overlay ancestor so we can anchor to it when no stable
    // id exists — this prevents the selector matching a different element once
    // the overlay is removed from the DOM.
    let overlayAnchor = null;
    while (node && node !== document.body) {
      let part = node.tagName.toLowerCase();
      const rawClass = typeof node.className === 'string' ? node.className : (node.className && node.className.baseVal) || '';
      const first = rawClass.trim().split(/\s+/).find(c => c.length > 0 && c.length < 40);
      if (first) part += '.' + CSS.escape(first);
      const siblings = node.parentElement
        ? Array.from(node.parentElement.children).filter(c => c.tagName === node.tagName)
        : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      parts.unshift(part);
      // If this node's parent has a stable anchor, anchor the path there and stop.
      const parent = node.parentElement;
      if (parent && parent !== document.body) {
        const anchor = stableAnchor(parent);
        if (anchor) {
          parts.unshift(anchor);
          return parts.join(' > ');
        }
        // Record the nearest overlay ancestor we pass through.
        if (!overlayAnchor && isOverlayRoot(parent)) {
          overlayAnchor = parent;
        }
      }
      node = parent;
    }
    // If we're inside an overlay but found no stable anchor, prepend the overlay
    // node as an extra ancestor segment. The selector then only resolves while
    // that overlay element exists in the DOM, preventing false matches on the
    // base page after the overlay is closed/destroyed.
    if (overlayAnchor) {
      let overlayPart = overlayAnchor.tagName.toLowerCase();
      const cls = pickDistinctiveClass(overlayAnchor);
      if (cls) overlayPart += '.' + CSS.escape(cls);
      parts.unshift(overlayPart);
    }
    return parts.join(' > ');
  }

  function formatRemaining(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // close pinned popover on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('.fb-pin') && !e.target.closest('.fb-popover')) {
      if (unpinActive) { unpinActive(); unpinActive = null; }
      openPinId = null;
    }
    if (openRangePopoverEl && !e.target.closest('.fb-popover') && !e.target.closest('mark.__fb-mark') && !e.target.closest('[data-range-marker]')) {
      closeRangePopover();
    }
  });

  /* ── navigation tracking ── */
  let _lastNavUrl = '';
  function recordNav() {
    const url = currentPageKey();
    if (url === _lastNavUrl) return;
    _lastNavUrl = url;
    navHistory.push(url);
    fetch('/api/nav', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prototypeId: PROTO_ID, email: EMAIL || 'local@test.com', pageUrl: url }),
    }).catch(() => {});
    // Clear pins from the previous page immediately; the RAF loop will show
    // pins for the new page once the SPA has rendered its new DOM elements.
    renderPinLayer();
    renderRangeLayer();
    renderSidebar();
  }

  if (!IS_FRAMED) {
    // Non-framed: the prototype shares this document, so patch its history and
    // listen for its navigation events directly. (In framed mode the bridge
    // reports navigation over postMessage and drives recordNav from there.)
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
    recordNav(); // record initial page
  }

  /* ── boot ── */
  const focusId = new URLSearchParams(location.search).get('focus') || '';

  // Framed-mode plumbing: talk to the prototype bridge over postMessage.
  function postToFrame(msg) {
    if (!IS_FRAMED || !PROTO_FRAME || !PROTO_FRAME.contentWindow) return;
    try {
      PROTO_FRAME.contentWindow.postMessage(Object.assign({ __fb: true }, msg), window.location.origin);
    } catch (_) {}
  }

  if (IS_FRAMED) {
    window.addEventListener('message', (e) => {
      if (e.origin !== window.location.origin) return;
      // Only trust messages from our own iframe's window.
      if (!PROTO_FRAME || e.source !== PROTO_FRAME.contentWindow) return;
      const d = e.data;
      if (!d || d.__fb !== true) return;
      if (d.type === 'click') {
        // Prototype click in comment mode. Coordinates are iframe-local; translate
        // to shell-viewport space by adding the iframe's on-screen offset (it sits
        // below the toolbar and flush-left), since the screenshot frame and
        // the ripple/marker geometry are all in shell-viewport px.
        if (mode === 'comment') {
          const r = PROTO_FRAME.getBoundingClientRect();
          handleProtoClick(d.x + r.left, d.y + r.top);
        }
      } else if (d.type === 'ready' || d.type === 'page') {
        if (typeof d.href === 'string') {
          framedHref = d.href;
          recordNav();
        }
        if (d.type === 'ready') {
          // Bridge just (re)loaded — resend current comment-mode state so a
          // navigation inside the iframe doesn't lose the crosshair/intercept.
          postToFrame({ type: 'commentMode', on: mode === 'comment' });
        }
      }
    });
    layoutFrame();
    window.addEventListener('resize', layoutFrame);
  }

  loadPins();
  rafId = requestAnimationFrame(recomputePositions);
  const _storedSidebar = (() => { try { return localStorage.getItem('__fb_sidebar_' + PROTO_ID); } catch (_) { return null; } })();
  if (_storedSidebar !== null) {
    setSidebarExpanded(_storedSidebar === '1');
  } else {
    sidebar.classList.add('collapsed');
    document.body.style.setProperty('--fb-sidebar-w', '32px');
    if (IS_FRAMED) layoutFrame();
    else document.body.style.paddingRight = '32px';
  }
})();
