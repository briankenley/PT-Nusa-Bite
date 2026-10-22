'use strict';
const { q, getPool } = require('../db');
const { nowStr } = require('./time');

const SYSTEM_CTX = { user: { id: null, username: 'system', role: 'system', name: 'System' } };

function actor(ctx) {
  const u = (ctx && ctx.user) || SYSTEM_CTX.user;
  return { id: u.id || null, username: u.username || 'anonymous', role: u.role || 'anonymous', name: u.name || u.username };
}

function row(ctx, e) {
  const a = actor(ctx);
  return [
    nowStr(), a.id, a.username, a.role, e.action, e.docType || null, e.docId || null, e.docNumber || null,
    e.result || 'ok', e.message ? String(e.message).slice(0, 500) : null, e.detail ? JSON.stringify(e.detail) : null,
  ];
}

const INSERT = `INSERT INTO audit_logs (ts, user_id, username, role, action, doc_type, doc_id, doc_number, result, message, detail)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Catat audit di dalam transaksi berjalan (ikut commit/rollback). */
async function log(conn, ctx, e) {
  await q(conn, INSERT, row(ctx, e));
}

/** Catat audit di luar transaksi; dipakai untuk upaya yang ditolak setelah rollback. */
async function logOutside(ctx, e) {
  try {
    await getPool().query(INSERT, row(ctx, e));
  } catch (err) {
    console.error('Gagal menulis audit log:', err.message);
  }
}

/** Tambah log note / pesan sistem pada chatter dokumen. */
async function note(conn, ctx, docType, docId, body, kind = 'system') {
  const a = actor(ctx);
  await q(conn, 'INSERT INTO messages (doc_type, doc_id, author_id, author_name, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [docType, docId, a.id, a.name || a.username, kind, String(body).slice(0, 1000), nowStr()]);
}

module.exports = { log, logOutside, note, SYSTEM_CTX, actor };
