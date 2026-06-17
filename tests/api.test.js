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

let app, protoId;

(hasDb ? describe : describe.skip)('api routes', () => {
  beforeAll(async () => {
    await initDb();
    protoId = nanoid(12);
    await getDb().query(
      'INSERT INTO prototypes (id, name, filename, share_token, created_at) VALUES ($1,$2,$3,$4,$5)',
      [protoId, 'Test', 'test.html', nanoid(12), new Date().toISOString()]
    );

    app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    app.use((req, _res, next) => {
      req.session.customerEmail = 'user@example.com';
      req.session.prototypeId = protoId;
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
      'INSERT INTO prototypes (id, name, filename, share_token, created_at) VALUES ($1,$2,$3,$4,$5)',
      [pid, 'NestTest', 'nest.html', 'tok-' + Date.now(), new Date().toISOString()]
    );

    const p = await request(app).post('/api/comments').send({
      prototypeId: pid,
      type: 'element',
      element: { selector: '#a', label: 'A', tagName: 'DIV' },
      comment: 'Top comment',
      pageUrl: '/p/x/view',
    });

    await request(app).post('/api/comments').send({
      prototypeId: pid,
      parentId: p.body.id,
      comment: 'A reply text',
    });

    const get = await request(app).get('/api/comments/' + pid);
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
      'INSERT INTO prototypes (id, name, filename, share_token, created_at) VALUES ($1,$2,$3,$4,$5)',
      [otherProtoId, 'Other Proto', 'other.html', 'tok-other', new Date().toISOString()]
    );

    // Attempt to reply using the wrong prototypeId
    const res = await request(app).post('/api/comments').send({
      prototypeId: otherProtoId,
      parentId: parent.body.id,
      comment: 'Cross-proto reply',
    });
    expect(res.status).toBe(404);
  });
});
