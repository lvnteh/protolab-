// tests/delivery.test.js
const path = require('path');
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();
process.env.BASE_URL = 'http://localhost:3000';

const hasDb = !!process.env.DATABASE_URL;

const { initDb, getDb, closeDb } = require('../src/db');
const { nanoid } = require('nanoid');
const fs = require('fs');
const request = require('supertest');
const express = require('express');
const session = require('express-session');
const deliveryRouter = require('../src/routes/delivery');

let app, protoId, shareToken;

(hasDb ? describe : describe.skip)('delivery routes', () => {
  beforeAll(async () => {
    await initDb();
    protoId = nanoid(12);
    shareToken = nanoid(12);

    const htmlPath = path.join(os.tmpdir(), `${protoId}.html`);
    fs.writeFileSync(htmlPath, '<!DOCTYPE html><html><head></head><body><h1>Test</h1></body></html>');

    await getDb().query(
      'INSERT INTO prototypes (id, name, filename, share_token, created_at) VALUES ($1,$2,$3,$4,$5)',
      [protoId, 'Test Proto', `${protoId}.html`, shareToken, new Date().toISOString()]
    );
    await getDb().query(
      'INSERT INTO allowlist (prototype_id, email) VALUES ($1,$2)',
      [protoId, 'allowed@example.com']
    );

    app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    app.use('/p', deliveryRouter);
  });

  afterAll(async () => {
    await closeDb();
  });

  test('GET /p/:token renders the prototype', async () => {
    const res = await request(app).get(`/p/${shareToken}`);
    expect(res.status).toBe(200);
  });

  test('GET /p/:token with unknown token responds 404', async () => {
    const res = await request(app).get('/p/unknowntoken123');
    expect(res.status).toBe(404);
  });
});
