// tests/admin.test.js
const path = require('path');
const os = require('os');
process.env.UPLOADS_PATH = os.tmpdir();

const bcrypt = require('bcryptjs');
const hasDb = !!process.env.DATABASE_URL;

jest.resetModules();
const { initDb, closeDb } = require('../src/db');
const { nanoid } = require('nanoid');
const request = require('supertest');
const express = require('express');
const session = require('express-session');
const adminRouter = require('../src/routes/admin');

let app;
// Create a fresh account per run rather than relying on the env-seeded admin,
// whose password hash can be clobbered by a loaded .env file (dotenv override).
const testEmail = `admin-test-${nanoid(8)}@sap.com`.toLowerCase();
const testPassword = 'password123';

(hasDb ? describe : describe.skip)('admin routes', () => {
  beforeAll(async () => {
    await initDb();
    app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    app.use('/admin', adminRouter);
    // Register the account these tests log in with.
    await request(app).post('/admin/signup')
      .send(`email=${testEmail}&password=${testPassword}&confirm=${testPassword}`);
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
      .send(`email=${testEmail}&password=wrong`);
    expect(res.status).toBe(401);
  });

  test('POST /admin/login with correct credentials redirects to /admin/prototypes', async () => {
    const res = await request(app)
      .post('/admin/login')
      .send(`email=${testEmail}&password=${testPassword}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('prototypes');
  });

  test('GET /admin/prototypes returns 200 when authenticated', async () => {
    const agent = request.agent(app);
    await agent.post('/admin/login').send(`email=${testEmail}&password=${testPassword}`);
    const res = await agent.get('/admin/prototypes');
    expect(res.status).toBe(200);
  });

  test('POST /admin/logout destroys the session and redirects to login', async () => {
    const agent = request.agent(app);
    await agent.post('/admin/login').send(`email=${testEmail}&password=${testPassword}`);
    // Sanity: the session is authenticated before logout.
    expect((await agent.get('/admin/prototypes')).status).toBe(200);

    const out = await agent.post('/admin/logout');
    expect(out.status).toBe(302);
    expect(out.headers.location).toContain('login');

    // After logout the same agent (same cookie jar) is no longer authenticated.
    const after = await agent.get('/admin/prototypes');
    expect(after.status).toBe(302);
    expect(after.headers.location).toContain('login');
  });
});
