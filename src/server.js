// src/server.js
const express = require('express');
const path = require('path');
const session = require('express-session');
const { initDb } = require('./db');
const config = require('./config');
const deliveryRouter = require('./routes/delivery');
const apiRouter = require('./routes/api');
const adminRouter = require('./routes/admin');

const app = express();

initDb();

const fs = require('fs');
fs.mkdirSync(config.uploadsPath, { recursive: true });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 },
}));

app.use('/sdk', express.static(path.join(__dirname, '../public/sdk')));
app.use('/p', deliveryRouter);
app.use('/api', apiRouter);
app.use('/admin', adminRouter);

app.get('/', (_req, res) => res.redirect('/admin/prototypes'));

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`Proto Share running on http://localhost:${config.port}`);
  });
}

module.exports = app;
