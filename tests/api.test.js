// tests/api.test.js
const path = require('path');
const os = require('os');
process.env.DB_PATH = path.join(os.tmpdir(), `test-api-${Date.now()}.db`);

const { initDb, getDb } = require('../src/db');
const { nanoid } = require('nanoid');
const request = require('supertest');
const express = require('express');
const session = require('express-session');
const apiRouter = require('../src/routes/api');

let app, protoId;

beforeAll(() => {
  initDb();
  protoId = nanoid(12);
  getDb().prepare(
    'INSERT INTO prototypes (id, name, filename, share_token, created_at) VALUES (?,?,?,?,?)'
  ).run(protoId, 'Test', 'test.html', nanoid(12), new Date().toISOString());

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

test('POST /api/comments stores a general comment', async () => {
  const res = await request(app).post('/api/comments').send({
    prototypeId: protoId,
    type: 'general',
    comment: 'Looks good!',
    pageUrl: '/p/abc/view',
  });
  expect(res.status).toBe(201);
  const row = getDb().prepare("SELECT * FROM comments WHERE comment = 'Looks good!'").get();
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
  const row = getDb().prepare("SELECT * FROM comments WHERE comment = 'Label is unclear'").get();
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
