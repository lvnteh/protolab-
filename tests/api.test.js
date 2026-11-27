// tests/api.test.js
const path = require('path');
const os = require('os');

const hasDb = !!process.env.DATABASE_URL;

const { initDb, getDb, closeDb } = require('../src/db');
const { nanoid } = require('nanoid');
const request = require('supertest');
const express = require('express');
const session = require('express-session');
const apiRouter = require('../src/routes/api');

let app, protoId, orgId;

(hasDb ? describe : describe.skip)('api routes', () => {
  beforeAll(async () => {
    await initDb();
    orgId = nanoid(12);
    await getDb().query(
      'INSERT INTO organizations (id, name, created_at) VALUES ($1,$2,$3)',
      [orgId, 'Test Org', new Date().toISOString()]
    );
    protoId = nanoid(12);
    await getDb().query(
      'INSERT INTO prototypes (id, name, filename, share_token, created_at, org_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [protoId, 'Test', 'test.html', nanoid(12), new Date().toISOString(), orgId]
    );

    app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    // Simulate a reviewer's share-link session. delivery.js binds the session to
    // exactly one prototype on /enter; the /api routes now resolve a structured
    // actor and re-check EFFECTIVE reviewer access (Task 6) — an explicit
    // allowlist row OR a current same-org member email. To mirror a reviewer who
    // legitimately entered via a prototype's share link (which requires passing
    // that access check), the stub ensures the session email is on the bound
    // prototype's allowlist before the request runs. Tests that exercise a
    // *different* prototype set `x-test-proto` so the binding matches.
    app.use(async (req, _res, next) => {
      req.session.customerEmail = 'user@example.com';
      req.session.prototypeId = req.get('x-test-proto') || protoId;
      try {
        await getDb().query(
          'INSERT INTO allowlist (prototype_id, email) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [req.session.prototypeId, 'user@example.com']);
      } catch { /* prototype may not exist yet for negative tests; access check will 403 */ }
      next();
    });
    app.use('/api', apiRouter);
  });

  afterAll(async () => {
    await closeDb();
  });

  test('POST /api/comments stores a general comment', async () => {
    const res = await request(app).post('/api/comments').send({
      prototypeId: protoId,
      type: 'general',
      comment: 'Looks good!',
      pageUrl: '/p/abc/view',
    });
    expect(res.status).toBe(201);
    const { rows } = await getDb().query("SELECT * FROM comments WHERE comment = 'Looks good!'");
    const row = rows[0];
    expect(row).toBeTruthy();
    expect(row.type).toBe('general');
  });

  test('POST /api/comments stores an element comment with breadcrumb', async () => {
    const res = await request(app).post('/api/comments').send({
      prototypeId: protoId,
      type: 'element',
      element: { selector: '#btn', label: 'Submit', tagName: 'BUTTON' },
      breadcrumb: ['Home', 'Cart'],
      comment: 'Label is unclear',
      pageUrl: '/p/abc/view',
    });
    expect(res.status).toBe(201);
    const { rows } = await getDb().query("SELECT * FROM comments WHERE comment = 'Label is unclear'");
    const row = rows[0];
    expect(row.element_selector).toBe('#btn');
    expect(JSON.parse(row.breadcrumb)).toEqual(['Home', 'Cart']);
  });

  test('POST /api/comments with empty comment returns 400', async () => {
    const res = await request(app).post('/api/comments').send({
      prototypeId: protoId,
      type: 'general',
      comment: '   ',
    });
    expect(res.status).toBe(400);
  });

  test('POST /api/comments with parentId stores a reply', async () => {
    // create a parent pin first
    const parent = await request(app).post('/api/comments').send({
      prototypeId: protoId,
      type: 'element',
      element: { selector: '#hero', label: 'Hero', tagName: 'DIV' },
      comment: 'Parent pin',
      pageUrl: '/p/abc/view',
    });
    expect(parent.status).toBe(201);
    const parentId = parent.body.id;

    const reply = await request(app).post('/api/comments').send({
      prototypeId: protoId,
      parentId,
      comment: 'A reply',
    });
    expect(reply.status).toBe(201);

    const { rows } = await getDb().query('SELECT * FROM comments WHERE id = $1', [reply.body.id]);
    expect(rows[0].parent_id).toBe(parentId);
    expect(rows[0].type).toBe('reply');
  });

  test('POST /api/comments with unknown parentId returns 404', async () => {
    const res = await request(app).post('/api/comments').send({
      prototypeId: protoId,
      parentId: 'nonexistent-id',
      comment: 'orphan reply',
    });
    expect(res.status).toBe(404);
  });

  test('POST /api/comments cannot reply to a reply', async () => {
    const parent = await request(app).post('/api/comments').send({
      prototypeId: protoId,
      type: 'element',
      element: { selector: '#x', label: 'X', tagName: 'DIV' },
      comment: 'Parent',
      pageUrl: '/p/abc/view',
    });
    const r1 = await request(app).post('/api/comments').send({
      prototypeId: protoId,
      parentId: parent.body.id,
      comment: 'First reply',
    });
    const r2 = await request(app).post('/api/comments').send({
      prototypeId: protoId,
      parentId: r1.body.id,
      comment: 'Nested reply — must fail',
    });
    expect(r2.status).toBe(400);
  });

  test('GET /api/comments/:protoId nests replies under their parent', async () => {
    const pid = 'nest-' + Date.now();
    await getDb().query(
      'INSERT INTO prototypes (id, name, filename, share_token, created_at, org_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [pid, 'NestTest', 'nest.html', 'tok-' + Date.now(), new Date().toISOString(), orgId]
    );

    const p = await request(app).post('/api/comments').set('x-test-proto', pid).send({
      prototypeId: pid,
      type: 'element',
      element: { selector: '#a', label: 'A', tagName: 'DIV' },
      comment: 'Top comment',
      pageUrl: '/p/x/view',
    });

    await request(app).post('/api/comments').set('x-test-proto', pid).send({
      prototypeId: pid,
      parentId: p.body.id,
      comment: 'A reply text',
    });

    const get = await request(app).get('/api/comments/' + pid).set('x-test-proto', pid);
    expect(get.status).toBe(200);
    const pins = get.body;
    expect(pins.length).toBe(1);
    expect(pins[0].replies.length).toBe(1);
    expect(pins[0].replies[0].comment).toBe('A reply text');
    expect(pins[0].replies[0].id).toBeDefined();
    expect(pins.find(pin => pin.comment === 'A reply text')).toBeUndefined();
  });

  test('POST /api/comments rejects parentId from a different prototype', async () => {
    // Create a parent pin on the main protoId
    const parent = await request(app).post('/api/comments').send({
      prototypeId: protoId,
      type: 'element',
      element: { selector: '#z', label: 'Z', tagName: 'DIV' },
      comment: 'Parent on proto A',
      pageUrl: '/p/abc/view',
    });
    expect(parent.status).toBe(201);

    // Create a second prototype
    const otherProtoId = 'other-' + Date.now();
    await getDb().query(
      'INSERT INTO prototypes (id, name, filename, share_token, created_at, org_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [otherProtoId, 'Other Proto', 'other.html', 'tok-' + otherProtoId, new Date().toISOString(), orgId]
    );

    // Attempt to reply using the wrong prototypeId. The reviewer is bound to
    // otherProtoId (via header), so authorization passes for that prototype —
    // but the parent pin lives on protoId, so the parent lookup (scoped to
    // otherProtoId) misses and we get 404. This proves parents can't be
    // borrowed across prototypes even by an authorized reviewer.
    const res = await request(app).post('/api/comments').set('x-test-proto', otherProtoId).send({
      prototypeId: otherProtoId,
      parentId: parent.body.id,
      comment: 'Cross-proto reply',
    });
    expect(res.status).toBe(404);
  });

  // ── Cross-prototype / cross-tenant isolation regression tests ──────────────
  // Before the P0 fix, /api mutation + read routes scoped only by the resource's
  // own id (e.g. WHERE id = $1), so a reviewer viewing prototype A could read,
  // edit, or delete comments/explanations belonging to prototype B (and thus a
  // different tenant) by guessing the 12-char id. These prove the hole is shut.
  describe('cross-prototype isolation', () => {
    let victimProto, victimCommentId, victimExplanationId;

    beforeAll(async () => {
      victimProto = 'victim-' + Date.now();
      await getDb().query(
        'INSERT INTO prototypes (id, name, filename, share_token, created_at, org_id) VALUES ($1,$2,$3,$4,$5,$6)',
        [victimProto, 'Victim', 'victim.html', 'tok-' + victimProto, new Date().toISOString(), orgId]
      );
      // Seed a comment + explanation owned by the victim prototype.
      const c = await request(app).post('/api/comments').set('x-test-proto', victimProto).send({
        prototypeId: victimProto,
        type: 'general',
        comment: 'Victim secret comment',
        pageUrl: '/p/v/view',
      });
      victimCommentId = c.body.id;
      // Explanations are admin-only to create (Task 6 capability matrix), so this
      // reviewer session can no longer POST one — seed it directly in the DB.
      victimExplanationId = nanoid(12);
      await getDb().query(
        `INSERT INTO explanations (id, prototype_id, element_selector, body, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [victimExplanationId, victimProto, '#secret', 'Victim secret explanation', new Date().toISOString(), new Date().toISOString()]);
    });

    // The attacker's session is bound to the DEFAULT protoId (not victimProto).
    test('cannot READ another prototype\'s comments', async () => {
      const res = await request(app).get('/api/comments/' + victimProto); // session → protoId
      expect(res.status).toBe(403);
    });

    test('cannot READ another prototype\'s explanations', async () => {
      const res = await request(app).get('/api/explanations/' + victimProto);
      expect(res.status).toBe(403);
    });

    test('cannot EDIT another prototype\'s comment by id', async () => {
      const res = await request(app).patch('/api/comments/' + victimCommentId).send({ comment: 'hacked' });
      expect(res.status).toBe(403);
      const { rows } = await getDb().query('SELECT comment FROM comments WHERE id = $1', [victimCommentId]);
      expect(rows[0].comment).toBe('Victim secret comment'); // unchanged
    });

    test('cannot DELETE another prototype\'s comment by id', async () => {
      const res = await request(app).delete('/api/comments/' + victimCommentId);
      expect(res.status).toBe(403);
      const { rows } = await getDb().query('SELECT 1 FROM comments WHERE id = $1', [victimCommentId]);
      expect(rows.length).toBe(1); // still there
    });

    test('cannot EDIT another prototype\'s explanation by id', async () => {
      const res = await request(app).patch('/api/explanations/' + victimExplanationId).send({ body: 'hacked' });
      expect(res.status).toBe(403);
      const { rows } = await getDb().query('SELECT body FROM explanations WHERE id = $1', [victimExplanationId]);
      expect(rows[0].body).toBe('Victim secret explanation');
    });

    test('cannot DELETE another prototype\'s explanation by id', async () => {
      const res = await request(app).delete('/api/explanations/' + victimExplanationId);
      expect(res.status).toBe(403);
      const { rows } = await getDb().query('SELECT 1 FROM explanations WHERE id = $1', [victimExplanationId]);
      expect(rows.length).toBe(1);
    });

    test('cannot POST a comment into another prototype', async () => {
      const res = await request(app).post('/api/comments').send({ // session → protoId
        prototypeId: victimProto,
        type: 'general',
        comment: 'injected',
        pageUrl: '/p/v/view',
      });
      expect(res.status).toBe(403);
    });

    test('the OWNING reviewer can still edit/delete their own comment', async () => {
      const own = await request(app).post('/api/comments').set('x-test-proto', victimProto).send({
        prototypeId: victimProto, type: 'general', comment: 'mine', pageUrl: '/p/v/view',
      });
      const patch = await request(app).patch('/api/comments/' + own.body.id)
        .set('x-test-proto', victimProto).send({ comment: 'mine edited' });
      expect(patch.status).toBe(200);
      const del = await request(app).delete('/api/comments/' + own.body.id).set('x-test-proto', victimProto);
      expect(del.status).toBe(200);
    });
  });

  test('POST /api/comments stores a range comment with anchor', async () => {
    const res = await request(app).post('/api/comments').send({
      prototypeId: protoId,
      type: 'range',
      comment: 'This sentence is unclear',
      pageUrl: '/p/abc/view',
      tag: 'copy',
      anchor: { quote: 'unclear sentence', prefix: 'the ', suffix: ' here', start: 42, end: 58 },
    });
    expect(res.status).toBe(201);
    const { rows } = await getDb().query("SELECT * FROM comments WHERE comment = 'This sentence is unclear'");
    const row = rows[0];
    expect(row.type).toBe('range');
    expect(row.anchor_quote).toBe('unclear sentence');
    expect(row.anchor_start).toBe(42);
    expect(row.anchor_end).toBe(58);
    expect(row.tag).toBe('copy');
  });

  test('POST /api/comments range without anchor quote returns 400', async () => {
    const res = await request(app).post('/api/comments').send({
      prototypeId: protoId,
      type: 'range',
      comment: 'no anchor',
      anchor: { quote: '   ' },
    });
    expect(res.status).toBe(400);
  });

  test('GET /api/comments returns anchor fields on range comments', async () => {
    const pid = 'range-' + Date.now();
    await getDb().query(
      'INSERT INTO prototypes (id, name, filename, share_token, created_at, org_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [pid, 'RangeGet', `${pid}.md`, 'tok-' + pid, new Date().toISOString(), orgId]
    );
    await request(app).post('/api/comments').set('x-test-proto', pid).send({
      prototypeId: pid, type: 'range', comment: 'anchored', pageUrl: '/p/x/view',
      anchor: { quote: 'the target', prefix: 'a ', suffix: ' b', start: 1, end: 11 },
    });
    const get = await request(app).get('/api/comments/' + pid).set('x-test-proto', pid);
    expect(get.status).toBe(200);
    const c = get.body.find(x => x.comment === 'anchored');
    expect(c).toBeTruthy();
    expect(c.anchor_quote).toBe('the target');
    expect(c.anchor_start).toBe(1);
    expect(c.type).toBe('range');
  });

  // Requests with no reviewer session and no admin session must be rejected —
  // authorizedForPrototype() returns false when neither credential is present.
  describe('unauthenticated access', () => {
    let noAuthApp;
    beforeAll(() => {
      noAuthApp = express();
      noAuthApp.use(express.json());
      noAuthApp.use(session({ secret: 'test2', resave: false, saveUninitialized: false }));
      noAuthApp.use('/api', apiRouter); // no session-populating middleware
    });

    test('GET comments without a session is 403', async () => {
      const res = await request(noAuthApp).get('/api/comments/' + protoId);
      expect(res.status).toBe(403);
    });

    test('POST comment without a session is 403', async () => {
      const res = await request(noAuthApp).post('/api/comments').send({
        prototypeId: protoId, type: 'general', comment: 'anon', pageUrl: '/p/x/view',
      });
      expect(res.status).toBe(403);
    });
  });

  describe('version-scoped annotations', () => {
    let vp, v1, v2, adminApp;
    beforeAll(async () => {
      vp = nanoid(12);
      await getDb().query(
        'INSERT INTO prototypes (id, name, filename, share_token, created_at, org_id) VALUES ($1,$2,$3,$4,$5,$6)',
        [vp, 'VP', `${vp}.html`, nanoid(12), new Date().toISOString(), orgId]);
      const mk = async (n) => {
        const id = nanoid(12);
        await getDb().query(
          `INSERT INTO prototype_versions (id,prototype_id,version,filename,status,created_at,content_type)
           VALUES ($1,$2,$3,$4,'published',$5,'html')`,
          [id, vp, n, `${id}.html`, new Date().toISOString()]);
        return id;
      };
      v1 = await mk(1); v2 = await mk(2);
      await getDb().query('UPDATE prototypes SET published_version_id = $1 WHERE id = $2', [v2, vp]);
      void v1;

      // Explanations are admin-only to create (Task 6). Build a second app whose
      // session is an ADMIN member of the prototype's org, so these tests can
      // exercise the explanation unique-index behavior with a legitimate actor.
      const adminId = nanoid(12);
      await getDb().query('INSERT INTO users (id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)',
        [adminId, `vpadmin-${adminId}@sap.com`, 'x', new Date().toISOString()]);
      await getDb().query(`INSERT INTO org_memberships (id,org_id,user_id,role,created_at) VALUES ($1,$2,$3,'admin',$4)`,
        [nanoid(12), orgId, adminId, new Date().toISOString()]);
      adminApp = express();
      adminApp.use(express.json());
      adminApp.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
      adminApp.use((req, _res, next) => { req.session.userId = adminId; next(); });
      adminApp.use('/api', apiRouter);
    });

    test('a comment is stamped against the viewed version and only shows there', async () => {
      await request(app).post('/api/comments').set('x-test-proto', vp)
        .send({ prototypeId: vp, type: 'element', comment: 'on v1', element: { selector: '.a' }, version: 1 })
        .expect(201);
      const onV1 = await request(app).get(`/api/comments/${vp}?version=1`).set('x-test-proto', vp).expect(200);
      expect(onV1.body.map(c => c.comment)).toContain('on v1');
      const onV2 = await request(app).get(`/api/comments/${vp}?version=2`).set('x-test-proto', vp).expect(200);
      expect(onV2.body.map(c => c.comment)).not.toContain('on v1');
    });

    test('a reply appears nested in its parent version read (Review Focus #2)', async () => {
      const parent = await request(app).post('/api/comments').set('x-test-proto', vp)
        .send({ prototypeId: vp, type: 'element', comment: 'parent', element: { selector: '.b' }, version: 1 }).expect(201);
      await request(app).post('/api/comments').set('x-test-proto', vp)
        .send({ prototypeId: vp, comment: 'reply', parentId: parent.body.id, version: 1 }).expect(201);
      const onV1 = await request(app).get(`/api/comments/${vp}?version=1`).set('x-test-proto', vp).expect(200);
      const p = onV1.body.find(c => c.comment === 'parent');
      expect(p.replies.map(r => r.comment)).toContain('reply');
    });

    test('a draft ?version is not honored — read falls back to the live version (Review Focus #1)', async () => {
      const dv = nanoid(12);
      await getDb().query(
        `INSERT INTO prototype_versions (id,prototype_id,version,filename,status,created_at,content_type)
         VALUES ($1,$2,3,$3,'draft',$4,'html')`,
        [dv, vp, `${dv}.html`, new Date().toISOString()]);
      // writing while "viewing" the draft stamps the LIVE version (v2), not the draft
      await request(app).post('/api/comments').set('x-test-proto', vp)
        .send({ prototypeId: vp, type: 'element', comment: 'sneaky', element: { selector: '.c' }, version: 3 }).expect(201);
      const onV3 = await request(app).get(`/api/comments/${vp}?version=3`).set('x-test-proto', vp).expect(200);
      expect(onV3.body.map(c => c.comment)).toContain('sneaky'); // ?version=3 fell back to live=v2
      const onV2 = await request(app).get(`/api/comments/${vp}?version=2`).set('x-test-proto', vp).expect(200);
      expect(onV2.body.map(c => c.comment)).toContain('sneaky');
    });

    test('same selector explanation on two versions is OK; same version is 409 (Review Focus #3)', async () => {
      // Explanations are admin-only (Task 6) — drive via the admin-session app.
      await request(adminApp).post('/api/explanations')
        .send({ prototypeId: vp, elementSelector: '.e', pageUrl: '/e', body: 'live one', version: 2 }).expect(201);
      await request(adminApp).post('/api/explanations')
        .send({ prototypeId: vp, elementSelector: '.e', pageUrl: '/e', body: 'dupe', version: 2 }).expect(409);
      await request(adminApp).post('/api/explanations')
        .send({ prototypeId: vp, elementSelector: '.e', pageUrl: '/e', body: 'v1 one', version: 1 }).expect(201);
    });
  });
});
