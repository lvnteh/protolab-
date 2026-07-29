// src/config.js
require('dotenv').config();

// In production a real SESSION_SECRET is mandatory: signing session cookies with
// a predictable secret would let anyone forge admin sessions. Outside production
// we fall back to a clearly dev-only secret so local/test runs work without setup.
function resolveSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be set in production (refusing to start with a default secret).');
  }
  return 'dev-only-insecure-secret';
}

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  sessionSecret: resolveSessionSecret(),
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
