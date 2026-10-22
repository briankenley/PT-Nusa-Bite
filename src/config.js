'use strict';

// Semua waktu aplikasi memakai WIB (Pekanbaru, UTC+7, tanpa DST).
process.env.TZ = 'Asia/Jakarta';

function loadDotEnv() {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
loadDotEnv();

const env = process.env;

module.exports = {
  port: Number(env.PORT || 3000),
  db: {
    url: env.DATABASE_URL || '',
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER || 'nusabite',
    password: env.DB_PASSWORD || 'nusabite',
    database: env.DB_NAME || 'nusabite',
    ssl: env.DB_SSL === 'true',
    sslCa: (env.DB_SSL_CA || '').replace(/\\n/g, '\n'),
  },
  sessionSecret: env.SESSION_SECRET || 'dev-only-secret-change-me',
  demoPassword: env.DEMO_PASSWORD || 'demo1234',
  allowReset: env.ALLOW_RESET !== 'false',
  isProduction: env.NODE_ENV === 'production',
};
