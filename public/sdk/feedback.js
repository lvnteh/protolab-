// public/sdk/feedback.js
(function () {
  const script = document.currentScript;
  if (!script) return;
  const PROTO_ID = script.getAttribute('data-proto-id');
  const EMAIL = decodeURIComponent(script.getAttribute('data-email') || '');

  const TAGS = ['bug', 'copy', 'question', 'idea', 'other'];
  const TAG_LABEL = { bug: 'Bug', copy: 'Copy', question: 'Question', idea: 'Idea', other: 'Other' };
  const TAG_COLOR = {
    bug:      'hsl(0,84%,60%)',
    copy:     'hsl(38,92%,50%)',
    question: 'hsl(217,91%,60%)',
    idea:     'hsl(142,71%,45%)',
    other:    'hsl(252,83%,57%)',
  };
  const CLUSTER_PX = 28;
  const EDIT_WINDOW_MS = 5 * 60 * 1000;

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
    #__fb-toolbar-left { display: flex; align-items: center; gap: 8px; }
    #__fb-toolbar-title { font-weight: 600; font-size: 13px; color: #fff; }
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
    .fb-mode-btn.active-review  { background: #fff; color: hsl(252,83%,57%); box-shadow: 0 1px 3px rgba(0,0,0,.12); }
    .fb-mode-btn.active-explain { background: hsl(38,92%,50%); color: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.08); }

    #__fb-comment-banner {
      position: fixed; top: 44px; left: 0; right: 0; z-index: 2147483646;
      background: hsl(252,83%,45%); color: #fff; text-align: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px; padding: 6px; pointer-events: none; display: none;
    }
    body.__fb-comment-mode #__fb-comment-banner { display: block; }
    body.__fb-comment-mode { cursor: crosshair !important; }
    body.__fb-comment-mode * { cursor: crosshair !important; }

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
      background: #fff; border: 1px solid hsl(220,13%,91%); border-radius: 12px;
      padding: 16px; box-shadow: 0 8px 24px rgba(0,0,0,.12);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px; z-index: 2147483645; display: none;
    }
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

    /* toast */
    #__fb-toast {
      position: fixed; bottom: 24px; right: 16px; z-index: 2147483647;
      background: hsl(142,71%,30%); color: #fff; border-radius: 8px; padding: 10px 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none;
      box-shadow: 0 4px 12px rgba(0,0,0,.15);
    }
    #__fb-toast.visible { opacity: 1; }

    /* ── explain mode ── */
    #__fb-explain-banner {
      position: fixed; top: 44px; left: 0; right: 0; z-index: 2147483646;
      background: hsl(38,92%,50%); color: #fff; text-align: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px; padding: 6px; pointer-events: none; display: none;
    }
    body.__fb-explain-mode #__fb-explain-banner { display: block; }

    #__fb-explains {
      position: fixed; top: 0; left: 0; width: 0; height: 0;
      pointer-events: none; z-index: 2147483638;
    }
    .fb-explain-marker {
      position: absolute; width: 26px; height: 26px; border-radius: 50%;
      background: hsl(38,92%,50%); color: #fff;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; font-weight: 700; font-family: serif;
      box-shadow: 0 1px 4px rgba(0,0,0,.25), 0 0 0 2px #fff;
      cursor: pointer; pointer-events: auto;
      transform: translate(-50%, -50%);
    }
    .fb-explain-marker:hover { transform: translate(-50%,-50%) scale(1.15); }

    .fb-explain-popover {
      position: absolute; left: calc(100% + 8px); top: -4px;
      width: 260px; background: #fff;
      border: 1px solid hsl(220,13%,91%); border-radius: 12px;
      overflow: hidden;
      font-size: 12px; line-height: 1.5;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 4px 16px rgba(0,0,0,.12);
      pointer-events: auto; z-index: 10;
    }
    .fb-explain-popover__head {
      display: flex; align-items: center; gap: 6px;
      background: hsl(38,92%,50%); color: #fff;
      padding: 6px 10px; font-size: 11px; font-weight: 700;
    }
    .fb-explain-popover__body {
      padding: 10px; color: hsl(222,47%,11%);
      white-space: pre-wrap; word-break: break-word;
    }

    #__fb-explain-card {
      position: fixed; right: 16px; top: 60px; width: 296px;
      background: #fff; border: 1px solid hsl(220,13%,91%); border-radius: 12px;
      padding: 16px; box-shadow: 0 8px 24px rgba(0,0,0,.12);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px; z-index: 2147483645; display: none;
    }
    #__fb-explain-card.visible { display: block; }
    .fb-explain-card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .fb-explain-card-title { font-weight: 600; font-size: 13px; color: hsl(222,47%,11%); }
    .fb-explain-card-close { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: none; border-radius: 6px; cursor: pointer; background: none; color: hsl(220,9%,46%); }
    .fb-explain-card-close:hover { background: hsl(220,14%,93%); }
    #__fb-explain-selector { font-size: 11px; color: hsl(220,9%,46%); margin-bottom: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #__fb-explain-textarea {
      width: 100%; resize: vertical; border: 1px solid hsl(220,13%,87%); border-radius: 8px;
      padding: 8px 10px; font-size: 13px; font-family: inherit; outline: none;
      background: #fff; color: hsl(222,47%,11%); line-height: 1.5; min-height: 80px;
    }
    #__fb-explain-textarea:focus { border-color: hsl(38,92%,50%); box-shadow: 0 0 0 3px hsl(38,92%,85%); }
    .fb-explain-foot { margin-top: 10px; display: flex; gap: 6px; justify-content: flex-end; }
    #__fb-explain-delete { background: none; border: 1px solid #e0c0bd; color: #c0392b; border-radius: 6px; padding: 5px 10px; font-size: 12px; font-weight: 600; cursor: pointer; margin-right: auto; }
    #__fb-explain-delete:hover { background: #fdf2f2; }

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
  document.body.style.paddingTop = '44px';

  /* ── toolbar ── */
  const toolbar = document.createElement('div');
  toolbar.id = '__fb-toolbar';
  toolbar.innerHTML = `
    <div id="__fb-toolbar-left">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#fff" width="18" height="18" style="flex-shrink:0"><path d="M13.13 22.19L11.5 18.36C13.07 17.78 14.54 17 15.9 16.09L13.13 22.19M5.64 12.5L1.81 10.87L7.91 8.1C7 9.46 6.22 10.93 5.64 12.5M21.61 2.39C21.61 2.39 16.66 .269 11 5.93C8.81 8.12 7.5 10.53 6.65 12.64C6.37 13.39 6.56 14.21 7.11 14.77L9.24 16.89C9.79 17.45 10.61 17.63 11.36 17.35C13.5 16.53 15.88 15.19 18.07 13C23.73 7.34 21.61 2.39 21.61 2.39M14.54 9.46C13.76 8.68 13.76 7.41 14.54 6.63S16.59 5.85 17.37 6.63C18.14 7.41 18.15 8.68 17.37 9.46C16.59 10.24 15.32 10.24 14.54 9.46M8.88 16.53L7.47 15.12L8.88 16.53M6.24 22L9.88 18.36C9.54 18.27 9.21 18.12 8.91 17.91L4.83 22H6.24M2 22H3.41L8.18 17.24L6.76 15.83L2 20.59V22M2 19.17L6.09 15.09C5.88 14.79 5.73 14.46 5.64 14.12L2 17.76V19.17Z"/></svg>
      <span id="__fb-toolbar-title">ProtoLab</span>
    </div>
    <div id="__fb-mode-switcher">
      <button class="fb-mode-btn active-view" data-mode="view">
        <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        View
      </button>
      <button class="fb-mode-btn" data-mode="comment">
        <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Comment
      </button>
      <button class="fb-mode-btn" data-mode="review">
        <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
        Review
      </button>
      <button class="fb-mode-btn" data-mode="explain">
        <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        Explain
      </button>
    </div>
  `;
  document.body.insertBefore(toolbar, document.body.firstChild);

  const commentBanner = document.createElement('div');
  commentBanner.id = '__fb-comment-banner';
  commentBanner.textContent = 'Click any element to leave a comment · Esc to exit';
  document.body.insertBefore(commentBanner, toolbar.nextSibling);

  const explainBanner = document.createElement('div');
  explainBanner.id = '__fb-explain-banner';
  explainBanner.textContent = 'Hover any element to see its explanation · Click to add or edit · Esc to exit';
  document.body.insertBefore(explainBanner, commentBanner.nextSibling);

  /* ── pin layer ── */
  const pinContainer = document.createElement('div');
  pinContainer.id = '__fb-pins';
  document.body.appendChild(pinContainer);

  /* ── explain layer ── */
  const explainContainer = document.createElement('div');
  explainContainer.id = '__fb-explains';
  document.body.appendChild(explainContainer);

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
    <div class="fb-tag-row" id="__fb-tag-row">
      ${TAGS.map(t => `<button class="fb-tag-pill" data-tag="${t}" style="border-color:${TAG_COLOR[t]};color:${TAG_COLOR[t]}">${TAG_LABEL[t]}</button>`).join('')}
    </div>
    <textarea id="__fb-draft-textarea" rows="4" placeholder="What's your feedback?"></textarea>
    <button id="__fb-draft-submit" disabled>Post comment</button>
  `;
  document.body.appendChild(draftCard);

  /* ── explain edit card ── */
  const explainCard = document.createElement('div');
  explainCard.id = '__fb-explain-card';
  explainCard.innerHTML = `
    <div class="fb-explain-card-header">
      <span class="fb-explain-card-title" id="__fb-explain-card-title">Add explanation</span>
      <button class="fb-explain-card-close" id="__fb-explain-close">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div id="__fb-explain-selector"></div>
    <textarea id="__fb-explain-textarea" rows="5" placeholder="Describe this element: user story, Gherkin, notes…"></textarea>
    <div class="fb-explain-foot">
      <button id="__fb-explain-delete" style="display:none">Delete</button>
      <button class="fb-btn-sm fb-btn-ghost" id="__fb-explain-cancel">Cancel</button>
      <button class="fb-btn-sm fb-btn-primary" id="__fb-explain-save" disabled>Save</button>
    </div>
  `;
  document.body.appendChild(explainCard);

  /* ── toast ── */
  const toast = document.createElement('div');
  toast.id = '__fb-toast';
  document.body.appendChild(toast);

  /* ── helpers ── */
  function currentPageKey() {
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
  let explanations = [];       // [{id,element_selector,x_pct,y_pct,page_url,body}]
  let explainPositions = {};   // {id: {x,y,visible}} — computed each RAF frame
  let explainMarkerEls = {};   // {id: domElement}
  let explainDraft = null;     // {selector, xPct, yPct, existingId|null}
  let now = Date.now();

  setInterval(() => { now = Date.now(); }, 1000);

  /* ── mode switching ── */
  function setMode(m) {
    mode = m;
    document.querySelectorAll('.fb-mode-btn').forEach(btn => {
      const bm = btn.dataset.mode;
      btn.className = 'fb-mode-btn' + (bm === m ? ` active-${m}` : '');
    });
    document.body.classList.toggle('__fb-comment-mode', m === 'comment');
    document.body.classList.toggle('__fb-explain-mode', m === 'explain');
    if (m !== 'comment') closeDraft();
    if (m !== 'explain') closeExplainCard();
    renderPinLayer();
    // explain layer is driven by the RAF loop; clear it immediately when leaving explain mode
    if (m !== 'explain') { explainContainer.innerHTML = ''; explainMarkerEls = {}; }
  }

  toolbar.querySelectorAll('.fb-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (unpinActive) { unpinActive(); unpinActive = null; return; }
      if (draft) { closeDraft(); return; }
      if (explainDraft) { closeExplainCard(); return; }
      if (mode !== 'view') setMode('view');
    }
  });

  /* ── load pins ── */
  async function loadPins() {
    try {
      const resp = await fetch('/api/comments/' + PROTO_ID, { credentials: 'include' });
      if (resp.ok) {
        const all = await resp.json();
        pins = all.filter(c => c.element_selector);
        generalComments = all.filter(c => !c.element_selector && !c.parent_id);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          renderPinLayer();
          renderSidebar();
          if (focusId) focusPin(focusId);
        }));
      }
    } catch (e) {}
  }

  async function loadExplanations() {
    try {
      const resp = await fetch('/api/explanations/' + PROTO_ID, { credentials: 'include' });
      if (resp.ok) {
        explanations = await resp.json();
      }
    } catch (e) {}
  }

  function setSidebarExpanded(expanded) {
    sidebarExpanded = expanded;
    sidebar.classList.toggle('expanded', expanded);
    sidebar.classList.toggle('collapsed', !expanded);
    document.body.style.paddingRight = expanded ? '260px' : '32px';
    try { localStorage.setItem('__fb_sidebar_' + PROTO_ID, expanded ? '1' : '0'); } catch (_) {}
  }

  function renderSidebar() {
    const currentPage = currentPageKey();
    const pagePins = pins.filter(p =>
      !p.page_url || pageKeyOf(p.page_url) === currentPage
    );
    const totalCount = pagePins.length + generalComments.length;

    const stored = (() => { try { return localStorage.getItem('__fb_sidebar_' + PROTO_ID); } catch (_) { return null; } })();
    if (stored === null) {
      setSidebarExpanded(totalCount > 0);
    }

    document.getElementById('__fb-pins-badge').textContent = pagePins.length;
    document.getElementById('__fb-gen-badge').textContent = generalComments.length;
    document.getElementById('__fb-sidebar-badge').textContent = totalCount;

    const pinsList = document.getElementById('__fb-sidebar-pins-list');
    pinsList.innerHTML = '';
    if (pagePins.length === 0) {
      pinsList.innerHTML = '<div class="fb-sidebar-empty">No pins on this page yet.</div>';
    } else {
      pagePins.forEach(p => {
        const row = document.createElement('div');
        row.className = 'fb-sidebar-pin-row';
        const tagHtml = p.tag
          ? `<span class="fb-sidebar-pin-tag" style="background:${TAG_COLOR[p.tag] || TAG_COLOR.other}">${TAG_LABEL[p.tag] || p.tag}</span>`
          : '';
        const repliesHtml = (p.replies && p.replies.length)
          ? `<div class="fb-sidebar-pin-replies">${p.replies.length} repl${p.replies.length === 1 ? 'y' : 'ies'}</div>`
          : '';
        row.innerHTML = `
          <div class="fb-sidebar-pin-row-head">
            <div class="fb-sidebar-pin-dot" style="background:${TAG_COLOR[p.tag] || TAG_COLOR.other}">${p.order}</div>
            <span class="fb-sidebar-pin-email">${escHtml(p.email)}</span>
            ${tagHtml}
          </div>
          <div class="fb-sidebar-pin-body">${escHtml(p.comment)}</div>
          ${repliesHtml}
        `;
        row.addEventListener('click', () => {
          if (mode === 'comment' || mode === 'explain') setMode('view');
          focusPin(p.id);
          setTimeout(() => {
            const pinEl = pinElements[p.id];
            if (pinEl) pinEl.click();
          }, 50);
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
      await postComment({ type: 'general', comment: text });
      input.value = '';
      await loadPins();
    } catch (_) {
      showToast('Failed to post comment.', true);
    }
    submitBtn.disabled = false;
    submitBtn.textContent = 'Post comment';
  });

  function renderExplainLayer() {
    explainContainer.innerHTML = '';
    explainMarkerEls = {};
    if (mode !== 'explain') return;

    explanations.forEach(ex => {
      const pos = explainPositions[ex.id];
      if (!pos?.visible) return;

      const marker = document.createElement('div');
      marker.className = 'fb-explain-marker';
      marker.style.cssText = `left:${pos.x}px;top:${pos.y}px`;
      marker.textContent = 'ℹ';

      let popoverEl = null;

      const showPopover = () => {
        if (popoverEl) return;
        popoverEl = document.createElement('div');
        popoverEl.className = 'fb-explain-popover';
        popoverEl.innerHTML = `
          <div class="fb-explain-popover__head">
            <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            Explanation
          </div>
          <div class="fb-explain-popover__body">${escHtml(ex.body)}</div>
        `;
        popoverEl.addEventListener('mouseleave', e => {
          if (e.relatedTarget && marker.contains(e.relatedTarget)) return;
          hidePopover();
        });
        marker.appendChild(popoverEl);
      };

      const hidePopover = () => {
        if (popoverEl) { popoverEl.remove(); popoverEl = null; }
      };

      marker.addEventListener('mouseenter', showPopover);
      marker.addEventListener('mouseleave', e => {
        if (e.relatedTarget && (marker.contains(e.relatedTarget) || (popoverEl && popoverEl.contains(e.relatedTarget)))) return;
        hidePopover();
      });

      explainContainer.appendChild(marker);
      explainMarkerEls[ex.id] = marker;
    });
  }

  function openExplainCard(selector, xPct, yPct) {
    const existing = explanations.find(e =>
      e.element_selector === selector &&
      (e.page_url ? pageKeyOf(e.page_url) === currentPageKey() : true)
    );
    explainDraft = { selector, xPct, yPct, existingId: existing ? existing.id : null };
    document.getElementById('__fb-explain-card-title').textContent = existing ? 'Edit explanation' : 'Add explanation';
    document.getElementById('__fb-explain-selector').textContent = selector;
    document.getElementById('__fb-explain-textarea').value = existing ? existing.body : '';
    document.getElementById('__fb-explain-save').disabled = !existing;
    document.getElementById('__fb-explain-delete').style.display = existing ? '' : 'none';
    explainCard.classList.add('visible');
    document.getElementById('__fb-explain-textarea').focus();
  }

  function closeExplainCard() {
    explainDraft = null;
    explainCard.classList.remove('visible');
  }

  document.getElementById('__fb-explain-close').addEventListener('click', closeExplainCard);
  document.getElementById('__fb-explain-cancel').addEventListener('click', closeExplainCard);

  document.getElementById('__fb-explain-textarea').addEventListener('input', e => {
    document.getElementById('__fb-explain-save').disabled = !e.target.value.trim();
  });

  document.getElementById('__fb-explain-save').addEventListener('click', async () => {
    if (!explainDraft) return;
    const draft = explainDraft;
    const body = document.getElementById('__fb-explain-textarea').value.trim();
    if (!body) return;
    const saveBtn = document.getElementById('__fb-explain-save');
    saveBtn.disabled = true;
    try {
      if (draft.existingId) {
        await fetch('/api/explanations/' + draft.existingId, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
          credentials: 'include',
        });
        const idx = explanations.findIndex(e => e.id === draft.existingId);
        if (idx !== -1) explanations[idx].body = body;
      } else {
        const resp = await fetch('/api/explanations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prototypeId: PROTO_ID,
            elementSelector: draft.selector,
            xPct: draft.xPct,
            yPct: draft.yPct,
            pageUrl: location.href,
            body,
          }),
          credentials: 'include',
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const { id } = await resp.json();
        explanations.push({
          id, element_selector: draft.selector,
          x_pct: draft.xPct, y_pct: draft.yPct,
          page_url: location.href, body,
        });
      }
      closeExplainCard();
      showToast('Explanation saved.');
      renderExplainLayer();
    } catch (_) {
      showToast('Failed to save.', true);
      saveBtn.disabled = false;
    }
  });

  document.getElementById('__fb-explain-delete').addEventListener('click', async () => {
    if (!explainDraft?.existingId) return;
    const draft = explainDraft;
    try {
      await fetch('/api/explanations/' + draft.existingId, {
        method: 'DELETE', credentials: 'include',
      });
      explanations = explanations.filter(e => e.id !== draft.existingId);
      closeExplainCard();
      showToast('Explanation deleted.');
      renderExplainLayer();
    } catch (_) {
      showToast('Failed to delete.', true);
    }
  });

  function focusPin(id) {
    const pin = pinElements[id];
    if (!pin) { requestAnimationFrame(() => focusPin(id)); return; }
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
  function recomputePositions() {
    const map = {};
    pins.forEach(p => {
      if (!p.element_selector) { map[p.id] = { x: 0, y: 0, visible: false }; return; }
      if (p.page_url && pageKeyOf(p.page_url) !== currentPageKey()) { map[p.id] = { x: 0, y: 0, visible: false }; return; }
      try {
        const el = document.querySelector(p.element_selector);
        if (!el) { map[p.id] = { x: 0, y: 0, visible: false }; return; }
        const r = el.getBoundingClientRect();
        const ox = typeof p.x_pct === 'number' ? p.x_pct : 0.5;
        const oy = typeof p.y_pct === 'number' ? p.y_pct : 0.5;
        map[p.id] = { visible: r.width > 0 || r.height > 0, x: r.left + r.width * ox, y: r.top + r.height * oy };
      } catch (_) { map[p.id] = { x: 0, y: 0, visible: false }; }
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

    if (mode === 'explain') {
      const exMap = {};
      explanations.forEach(ex => {
        if (ex.page_url && pageKeyOf(ex.page_url) !== currentPageKey()) { exMap[ex.id] = { x: 0, y: 0, visible: false }; return; }
        try {
          const el = document.querySelector(ex.element_selector);
          if (!el) { exMap[ex.id] = { x: 0, y: 0, visible: false }; return; }
          const r = el.getBoundingClientRect();
          const ox = typeof ex.x_pct === 'number' ? ex.x_pct : 0.5;
          const oy = typeof ex.y_pct === 'number' ? ex.y_pct : 0.5;
          exMap[ex.id] = { visible: r.width > 0 || r.height > 0, x: r.left + r.width * ox, y: r.top + r.height * oy };
        } catch (_) { exMap[ex.id] = { x: 0, y: 0, visible: false }; }
      });

      const prevExVisible = new Set(Object.keys(explainMarkerEls));
      const nextExVisible = new Set(Object.entries(exMap).filter(([, v]) => v.visible).map(([k]) => k));
      const exVisibilityChanged = prevExVisible.size !== nextExVisible.size ||
        [...nextExVisible].some(id => !prevExVisible.has(id));

      explainPositions = exMap;

      if (exVisibilityChanged) {
        renderExplainLayer();
      } else {
        Object.entries(explainMarkerEls).forEach(([id, el]) => {
          const pos = exMap[id];
          if (!pos) return;
          el.style.left = pos.x + 'px';
          el.style.top = pos.y + 'px';
          el.style.display = pos.visible ? '' : 'none';
        });
      }
    }
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
    if (mode === 'review' || mode === 'explain') return;

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

        // Flip popover left if it would overflow the right edge
        const popRect = popoverEl.getBoundingClientRect();
        if (popRect.right > window.innerWidth - 8) {
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

  /* ── comment mode click ── */
  document.addEventListener('click', e => {
    if (mode !== 'comment') return;
    if (e.target.closest('#__fb-draft-card') || e.target.closest('.fb-pin') || e.target.closest('.fb-cluster') || e.target.closest('#__fb-toolbar')) return;
    e.preventDefault(); e.stopPropagation();

    const el = e.target;
    const selector = getCssSelector(el);
    const rect = el.getBoundingClientRect();
    const xPct = rect.width ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 0.5;
    const yPct = rect.height ? Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) : 0.5;

    draft = { selector, xPct, yPct, tag: null };
    openDraftCard(selector);
  }, true);

  /* ── explain mode click ── */
  document.addEventListener('click', e => {
    if (mode !== 'explain') return;
    if (e.target.closest('#__fb-explain-card') || e.target.closest('.fb-explain-marker') || e.target.closest('#__fb-toolbar')) return;
    e.preventDefault(); e.stopPropagation();

    // Walk up from SVG internals (<path>, <circle>, etc.) to their owning SVG or parent element
    let el = e.target;
    while (el && (el.tagName === 'path' || el.tagName === 'circle' || el.tagName === 'rect' || el.tagName === 'line' || el.tagName === 'polyline' || el.tagName === 'polygon' || el.tagName === 'ellipse' || el.tagName === 'use') && el.parentElement) {
      el = el.parentElement;
    }

    const selector = getCssSelector(el);
    const rect = el.getBoundingClientRect();
    const xPct = rect.width ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 0.5;
    const yPct = rect.height ? Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) : 0.5;

    openExplainCard(selector, xPct, yPct);
  }, true);

  function openDraftCard(selector) {
    document.getElementById('__fb-draft-selector').textContent = selector;
    document.getElementById('__fb-draft-textarea').value = '';
    document.getElementById('__fb-draft-submit').disabled = true;
    // reset tags
    document.querySelectorAll('.fb-tag-pill').forEach(p => { p.classList.remove('active'); p.style.background = 'none'; p.style.color = TAG_COLOR[p.dataset.tag]; });
    if (draft) draft.tag = null;
    draftCard.classList.add('visible');
    document.getElementById('__fb-draft-textarea').focus();
  }

  document.getElementById('__fb-draft-close').addEventListener('click', closeDraft);

  document.getElementById('__fb-draft-textarea').addEventListener('input', e => {
    document.getElementById('__fb-draft-submit').disabled = !e.target.value.trim();
  });

  document.getElementById('__fb-tag-row').addEventListener('click', e => {
    const pill = e.target.closest('.fb-tag-pill');
    if (!pill || !draft) return;
    const t = pill.dataset.tag;
    const isActive = pill.classList.contains('active');
    document.querySelectorAll('.fb-tag-pill').forEach(p => { p.classList.remove('active'); p.style.background = 'none'; p.style.color = TAG_COLOR[p.dataset.tag]; });
    if (!isActive) {
      pill.classList.add('active');
      pill.style.background = TAG_COLOR[t];
      pill.style.color = '#fff';
      draft.tag = t;
    } else {
      draft.tag = null;
    }
  });

  document.getElementById('__fb-draft-submit').addEventListener('click', async () => {
    if (!draft) return;
    const text = document.getElementById('__fb-draft-textarea').value.trim();
    if (!text) return;
    const btn = document.getElementById('__fb-draft-submit');
    btn.disabled = true;
    btn.textContent = 'Posting…';
    try {
      await postComment({
        type: 'element',
        element: { selector: draft.selector, label: '', tagName: '' },
        comment: text,
        pageUrl: location.href,
        tag: draft.tag,
        xPct: draft.xPct,
        yPct: draft.yPct,
        breadcrumb: navHistory,
      });
      closeDraft();
      showToast('Comment posted.');
      await loadPins();
    } catch (_) {
      showToast('Failed to post comment.', true);
      btn.disabled = false;
      btn.textContent = 'Post comment';
    }
  });

  function closeDraft() {
    draft = null;
    draftCard.classList.remove('visible');
  }

  /* ── api helpers ── */
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

  /* ── helpers ── */
  function getCssSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
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
      node = node.parentElement;
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
  });

  /* ── navigation tracking ── */
  (function () {
    let lastUrl = '';

    function recordNav() {
      const url = currentPageKey();
      if (url === lastUrl) return;
      lastUrl = url;
      navHistory.push(url);
      fetch('/api/nav', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prototypeId: PROTO_ID, email: EMAIL || 'local@test.com', pageUrl: url }),
      }).catch(() => {});
      // Clear pins from the previous page immediately; the RAF loop will show
      // pins for the new page once the SPA has rendered its new DOM elements.
      renderPinLayer();
    }

    // Patch history methods to fire a custom event
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

    // Record initial page
    recordNav();
  })();

  /* ── boot ── */
  const focusId = new URLSearchParams(location.search).get('focus') || '';

  loadPins();
  loadExplanations();
  rafId = requestAnimationFrame(recomputePositions);
  const _storedSidebar = (() => { try { return localStorage.getItem('__fb_sidebar_' + PROTO_ID); } catch (_) { return null; } })();
  setSidebarExpanded(_storedSidebar === '1');
})();
