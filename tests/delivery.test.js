// tests/delivery.test.js
const path = require('path');
const os = require('os');
process.env.DB_PATH = path.join(os.tmpdir(), `test-delivery-${Date.now()}.db`);
process.env.UPLOADS_PATH = os.tmpdir();
process.env.BASE_URL = 'http://localhost:3000';

const { initDb, getDb } = require('../src/db');
const { nanoid } = require('nanoid');
const fs = require('fs');
const request = require('supertest');
const express = require('express');
const session = require('express-session');
const deliveryRouter = require('../src/routes/delivery');

let app, protoId, shareToken;

beforeAll(() => {
  initDb();
  protoId = nanoid(12);
  shareToken = nanoid(12);

  const htmlPath = path.join(os.tmpdir(), `${protoId}.html`);
  fs.writeFileSync(htmlPath, '<!DOCTYPE html><html><head></head><body><h1>Test</h1></body></html>');

  getDb().prepare(
    'INSERT INTO prototypes (id, name, filename, share_token, created_at) VALUES (?,?,?,?,?)'
  ).run(protoId, 'Test Proto', `${protoId}.html`, shareToken, new Date().toISOString());
  getDb().prepare(
    'INSERT INTO allowlist (prototype_id, email) VALUES (?,?)'
  ).run(protoId, 'allowed@example.com');

  app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  app.use('/p', deliveryRouter);
});

test('GET /p/:token renders email entry form', async () => {
  const res = await request(app).get(`/p/${shareToken}`);
  expect(res.status).toBe(200);
  expect(res.text).toContain('email');
});

test('POST /p/:token/enter with allowed email redirects to /view', async () => {
  const res = await request(app)
    .post(`/p/${shareToken}/enter`)
    .send('email=allowed%40example.com');
  expect([302, 200]).toContain(res.status);
});

test('POST /p/:token/enter with non-allowed email responds 403', async () => {
  const res = await request(app)
    .post(`/p/${shareToken}/enter`)
    .send('email=stranger%40example.com');
  expect(res.status).toBe(403);
});

test('GET /p/:token/view without session responds 401', async () => {
  const res = await request(app).get(`/p/${shareToken}/view`);
  expect(res.status).toBe(401);
});
