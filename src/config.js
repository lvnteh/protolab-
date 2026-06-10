// src/config.js
require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret',
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH || '',
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  uploadsPath: process.env.UPLOADS_PATH || './uploads',
  databaseUrl: process.env.DATABASE_URL || '',
};
