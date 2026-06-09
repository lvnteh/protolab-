// src/config.js
module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret',
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH || '',
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  dbPath: process.env.DB_PATH || './data/app.db',
  uploadsPath: process.env.UPLOADS_PATH || './uploads',
};
