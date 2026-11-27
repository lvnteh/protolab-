// tests/browser/sandbox-isolation.browser.js
//
// S4 BROWSER REGRESSION for HTML prototype sandboxing. This is a STANDALONE node
// runner, NOT a jest test — Playwright is intentionally not a project dependency
// (the repo policy avoids adding deps), so this script drives a real browser via
// playwright-core + the system Chrome, out-of-band from `npm test`.
//
// What it proves (in a REAL browser, not JSDOM):
//   - the prototype iframe is sandboxed (allow-scripts, no allow-same-origin);
//   - the committed adversarial fixture (tests/fixtures/adversarial-proto.html)
//     CANNOT: read the parent/top DOM, touch app storage/cookies, read an
//     authenticated response, issue an accepted mutation, forge a bridge message
//     the parent acts on, or navigate the top frame — asserted BOTH in-page and
//     against real server state (no comments / nav rows created);
//   - the legitimate same-origin flow still works end to end: comment-mode click
//     inside the sandbox → bridge → shell → CSRF-token same-origin POST → row;
//   - sibling/self-window forged messages and malformed messages are ignored;
//   - reload re-initialises the sandbox and the posted comment persists.
//
// HOW TO RUN (requires a Chrome/Chromium install and the compose test Postgres):
//   npm i -D playwright-core           # or: npm i -g playwright-core
//   PW_CORE=$(node -p "require.resolve('playwright-core')") \
//     node tests/browser/sandbox-isolation.browser.js
//
//   Optional env:
//     PW_CORE      absolute path to playwright-core (default: resolved from cwd)
//     PW_CHANNEL   browser channel (default: "chrome"); e.g. "msedge", "chromium"
//     TEST_DATABASE_URL / DATABASE_URL  (default: localhost:5433 compose Postgres)
//
// Exit code 0 = all checks passed; non-zero = a check failed or the run errored.
const path = require('path');
const fs = require('fs');
const os = require('os');

const WORKTREE = process.env.PROTOLAB_ROOT || path.resolve(__dirname, '..', '..');

// --- env: point at the test DB, local-disk storage, an ephemeral port ---
const UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 's4-uploads-'));
process.env.UPLOADS_PATH = UPLOADS;
process.env.NODE_ENV = 'test';            // dev-auth off for /p
process.env.CSRF_ENABLED = '1';           // hard-enforce the CSRF token + origin guard
process.env.PORT = '0';                   // ephemeral — we read the bound port back
const { testUrl } = require(path.join(WORKTREE, 'tests/test-db'));
process.env.DATABASE_URL = testUrl;
process.env.BASE_URL = 'http://127.0.0.1'; // host-derived origin is used at runtime

const PW_CORE = process.env.PW_CORE || require.resolve('playwright-core', { paths: [WORKTREE, process.cwd()] });
const PW_CHANNEL = process.env.PW_CHANNEL || 'chrome';
const { chromium } = require(PW_CORE);
const crypto = require('crypto');
const nanoid = (n = 12) => crypto.randomBytes(16).toString('hex').slice(0, n);

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  const { initDb, getDb, closeDb } = require(path.join(WORKTREE, 'src/db'));
  await initDb();

  const db = getDb();
  const orgId = nanoid(12), ownerId = nanoid(12), protoId = nanoid(12), token = nanoid(12);
  const now = new Date().toISOString();
  await db.query('INSERT INTO users (id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)',
    [ownerId, `s4-${ownerId}@sap.com`, 'x', now]);
  await db.query('INSERT INTO organizations (id,name,created_at) VALUES ($1,$2,$3)', [orgId, 's4-org', now]);
  const filename = `${protoId}.html`;
  fs.copyFileSync(path.join(WORKTREE, 'tests/fixtures/adversarial-proto.html'), path.join(UPLOADS, filename));
  await db.query(
    'INSERT INTO prototypes (id,name,filename,share_token,created_at,owner_id,org_id,content_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [protoId, 'Adversarial', filename, token, now, ownerId, orgId, 'html']);
  await db.query('INSERT INTO allowlist (prototype_id,email) VALUES ($1,$2)', [protoId, 's4rev@sap.com']);
  await initDb(); // backfill v1

  const app = require(path.join(WORKTREE, 'src/server'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log('app listening at', base);

  const browser = await chromium.launch({ channel: PW_CHANNEL, headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    // --- reviewer entry: email-gate → session bound to this prototype ---
    await page.goto(`${base}/p/${token}`, { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="email"]', 's4rev@sap.com');
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForLoadState('networkidle').catch(() => {});
    check('reviewer reaches shell /view', page.url().includes('/view'), page.url());

    const sandboxAttr = await page.getAttribute('#__fb-proto-frame', 'sandbox');
    check('iframe has sandbox=allow-scripts (no allow-same-origin)',
      sandboxAttr && /allow-scripts/.test(sandboxAttr) && !/allow-same-origin/.test(sandboxAttr),
      `sandbox="${sandboxAttr}"`);

    const frame = page.frames().find(f => f.url().includes('/raw'));
    check('prototype iframe loaded from /raw', !!frame, frame && frame.url());
    await frame.waitForFunction('window.__attackReady === true', null, { timeout: 5000 });
    await page.waitForTimeout(800); // let async fetch attempts settle
    const a = JSON.parse(await frame.evaluate('JSON.stringify(window.__attack)'));

    const heading = await frame.evaluate("document.getElementById('proto-heading') && document.getElementById('proto-heading').textContent");
    check('prototype own script/content runs under sandbox', heading === 'Adversarial Prototype', heading);

    check('parent DOM read is blocked', a.parentDomRead && a.parentDomRead.ok === false, JSON.stringify(a.parentDomRead));
    check('top DOM read is blocked', a.topDomRead && a.topDomRead.ok === false, JSON.stringify(a.topDomRead));
    check('localStorage access is blocked (opaque origin)', a.localStorage && a.localStorage.ok === false, JSON.stringify(a.localStorage));
    const cookieUnreachable = a.cookie && ((a.cookie.ok === true && a.cookie.value === '') || a.cookie.ok === false);
    check('no app cookie reachable from prototype', cookieUnreachable, JSON.stringify(a.cookie));
    const authBlocked = (a.authFetchError !== undefined) || (a.authFetchBody === undefined) || (typeof a.authFetchBody === 'string' && !a.authFetchBody.includes('comment'));
    check('authenticated response not readable by prototype', authBlocked, `err=${a.authFetchError} bodyLen=${a.authFetchBody ? a.authFetchBody.length : 'none'}`);
    const mutStatus = a.mutationStatus;
    check('mutation request rejected or blocked', mutStatus === undefined || mutStatus === 403 || mutStatus === 0, `status=${mutStatus} err=${a.mutationError}`);
    check('top navigation blocked (still on shell)', page.url().includes('/view'), page.url());

    const { rows: cRows } = await db.query('SELECT COUNT(*) n FROM comments WHERE prototype_id=$1', [protoId]);
    check('no comments created by the adversarial fixture', Number(cRows[0].n) === 0, `comments=${cRows[0].n}`);
    const { rows: injRows } = await db.query("SELECT COUNT(*) n FROM comments WHERE comment LIKE '%ATTACK-INJECTED%'");
    check('no ATTACK-INJECTED comment anywhere', Number(injRows[0].n) === 0, `matches=${injRows[0].n}`);

    // Sibling/self-window forged commentMode must not reach the bridge (shell
    // requires e.source===iframe && origin null; a shell-window self-post fails).
    const cursorBeforeForge = await frame.evaluate('document.documentElement.style.cursor');
    await page.evaluate("window.postMessage({ __fb:true, type:'commentMode', on:true }, '*')");
    await page.waitForTimeout(100);
    const cursorAfterForge = await frame.evaluate('document.documentElement.style.cursor');
    check('sibling/self-window forged commentMode does not reach the bridge',
      cursorBeforeForge === cursorAfterForge, `before=${cursorBeforeForge} after=${cursorAfterForge}`);

    // Malformed messages from the iframe (its only legitimate channel) must be inert.
    await frame.evaluate(`
      var junk = [null, 42, 'str', {}, {__fb:true}, {__fb:true,type:'click'}, {__fb:true,type:'click',x:NaN,y:NaN}, {__fb:true,type:'page',href:'javascript:evil()'}, {__fb:true,type:'unknownOp'}];
      junk.forEach(function(m){ try { window.parent.postMessage(m, '*'); } catch(e){} });
    `);
    await page.waitForTimeout(150);
    check('shell survives malformed/forged messages (still on view)', page.url().includes('/view'), page.url());
    const { rows: junkRows } = await db.query('SELECT COUNT(*) n FROM comments WHERE prototype_id=$1', [protoId]);
    check('malformed messages created no server state', Number(junkRows[0].n) === 0, `comments=${junkRows[0].n}`);

    // POSITIVE: legitimate comment via the SDK (comment-mode click → bridge →
    // shell → CSRF same-origin POST). Exercises handleProtoClick + the token path.
    const before = await db.query('SELECT COUNT(*) n FROM comments WHERE prototype_id=$1', [protoId]);
    await page.click('.fb-mode-btn[data-mode="comment"]').catch(() => {});
    await page.waitForTimeout(150);
    if (await page.isVisible('#__fb-shot-prompt-backdrop.visible').catch(() => false)) {
      await page.click('#__fb-shot-prompt-skip').catch(() => {});
      await page.waitForTimeout(150);
    }
    const box = await page.locator('#__fb-proto-frame').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(500);
    const draftVisible = await page.isVisible('#__fb-draft-card.visible').catch(() => false);
    if (draftVisible) {
      await page.fill('#__fb-draft-textarea', 'legit reviewer comment via SDK');
      await page.click('#__fb-draft-submit');
      await page.waitForTimeout(800);
    }
    const after = await db.query('SELECT COUNT(*) n FROM comments WHERE prototype_id=$1', [protoId]);
    check('legit same-origin comment via SDK is accepted',
      Number(after.rows[0].n) === Number(before.rows[0].n) + 1,
      `draftShown=${draftVisible} before=${before.rows[0].n} after=${after.rows[0].n}`);

    // Reload: sandbox + bridge re-initialise, the posted comment persists.
    await page.reload({ waitUntil: 'networkidle' });
    const frame2 = page.frames().find(f => f.url().includes('/raw'));
    check('iframe reloads under sandbox after a full reload', !!frame2, frame2 && frame2.url());
    const sandboxAttr2 = await page.getAttribute('#__fb-proto-frame', 'sandbox');
    check('sandbox attribute intact after reload',
      sandboxAttr2 && /allow-scripts/.test(sandboxAttr2) && !/allow-same-origin/.test(sandboxAttr2), `sandbox="${sandboxAttr2}"`);
    const persisted = await db.query('SELECT COUNT(*) n FROM comments WHERE prototype_id=$1', [protoId]);
    check('posted comment persists across reload', Number(persisted.rows[0].n) >= 1, `comments=${persisted.rows[0].n}`);
  } finally {
    await browser.close();
    await new Promise(r => server.close(r));
    await closeDb();
    try { fs.rmSync(UPLOADS, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('RUNNER ERROR', e); process.exit(3); });
