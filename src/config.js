// src/config.js
require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret',
  adminUser: process.env.ADMIN_USER || 'admin',
  adminEmail: process.env.ADMIN_EMAIL || '',
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH || '',
  allowedEmailDomains: ['sap.com', 'emarsys.com'],
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  uploadsPath: process.env.UPLOADS_PATH || './uploads',
  databaseUrl: process.env.DATABASE_URL || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  storageBucket: process.env.SUPABASE_STORAGE_BUCKET || 'prototypes',
};
