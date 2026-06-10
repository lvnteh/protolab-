// tests/admin.test.js
const path = require('path');
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();
process.env.ADMIN_USER = 'admin';

const bcrypt = require('bcryptjs');
process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync('secret', 10);

const hasDb = !!process.env.DATABASE_URL;

jest.resetModules();
const { initDb, closeDb } = require('../src/db');
const request = require('supertest');
const express = require('express');
const session = require('express-session');
const adminRouter = require('../src/routes/admin');

let app;

(hasDb ? describe : describe.skip)('admin routes', () => {
  beforeAll(async () => {
    await initDb();
    app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    app.use('/admin', adminRouter);
  });

  afterAll(async () => {
    await closeDb();
  });

  test('GET /admin/prototypes without auth redirects to login', async () => {
    const res = await request(app).get('/admin/prototypes');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('login');
  });

  test('POST /admin/login with wrong password responds 401', async () => {
    const res = await request(app)
      .post('/admin/login')
      .send('username=admin&password=wrong');
    expect(res.status).toBe(401);
  });

  test('POST /admin/login with correct credentials redirects to /admin/prototypes', async () => {
    const res = await request(app)
      .post('/admin/login')
      .send('username=admin&password=secret');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('prototypes');
  });

  test('GET /admin/prototypes returns 200 when authenticated', async () => {
    const agent = request.agent(app);
    await agent.post('/admin/login').send('username=admin&password=secret');
    const res = await agent.get('/admin/prototypes');
    expect(res.status).toBe(200);
  });
});
