'use strict';
const bcrypt = require('bcryptjs');
const { one } = require('../db');
const audit = require('../lib/audit');

async function login(username, password) {
  const user = await one('SELECT * FROM users WHERE username = ? AND active = 1', [String(username || '').trim().toLowerCase()]);
  const ok = user && (await bcrypt.compare(String(password || ''), user.password_hash));
  const ctx = { user: ok ? { id: user.id, username: user.username, role: user.role } : { id: null, username: String(username || '').slice(0, 40) || 'anonymous', role: 'anonymous' } };
  await audit.logOutside(ctx, { action: ok ? 'LOGIN' : 'LOGIN_FAILED', docType: 'res.users', docId: ok ? user.id : null, result: ok ? 'ok' : 'rejected', message: ok ? 'Login berhasil' : 'Username atau password salah' });
  if (!ok) return null;
  return { id: user.id, username: user.username, role: user.role, name: user.full_name };
}

module.exports = { login };
