'use strict';
const mysql = require('mysql2/promise');
const config = require('./config');

let pool = null;

function connectionOptions(extra = {}) {
  const c = config.db;
  let opts;
  if (c.url) {
    const u = new URL(c.url);
    opts = {
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ''),
    };
    if (/ssl-mode=(required|verify)/i.test(u.search)) opts.ssl = {};
  } else {
    opts = { host: c.host, port: c.port, user: c.user, password: c.password, database: c.database };
  }
  if (c.ssl || opts.ssl) {
    opts.ssl = c.sslCa ? { ca: c.sslCa, rejectUnauthorized: true } : { rejectUnauthorized: false };
  }
  return {
    ...opts,
    // Tanggal dikembalikan sebagai string agar tidak bergeser zona waktu.
    dateStrings: true,
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    charset: 'utf8mb4',
    ...extra,
  };
}

function getPool() {
  if (!pool) {
    pool = mysql.createPool(connectionOptions({ connectionLimit: 8, waitForConnections: true }));
  }
  return pool;
}

async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

/** Jalankan fn(conn) dalam satu transaksi; rollback otomatis bila error. */
async function tx(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* koneksi mungkin sudah putus */ }
    throw err;
  } finally {
    conn.release();
  }
}

async function query(sql, params = []) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

/** Helper untuk dipakai di dalam transaksi. */
async function q(conn, sql, params = []) {
  const [rows] = await conn.query(sql, params);
  return rows;
}

async function q1(conn, sql, params = []) {
  const rows = await q(conn, sql, params);
  return rows[0] || null;
}

module.exports = { getPool, closePool, tx, query, one, q, q1, connectionOptions };
