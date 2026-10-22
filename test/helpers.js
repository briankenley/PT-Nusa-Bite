'use strict';
// Tes memakai database terpisah agar data aplikasi tidak tersentuh.
process.env.DB_NAME = process.env.TEST_DB_NAME || 'nusabite_test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || '';

const assert = require('node:assert/strict');
const { resetBaseline } = require('../src/seed');
const db = require('../src/db');
const { accountBalance, partnerBalance } = require('../src/services/accounting');

async function fresh() {
  await resetBaseline();
}

async function ctx(role) {
  const u = await db.one('SELECT * FROM users WHERE role = ?', [role]);
  return { user: { id: u.id, username: u.username, role: u.role, name: u.full_name } };
}

async function id(table, col, value) {
  const r = await db.one(`SELECT id FROM ${table} WHERE ${col} = ?`, [value]);
  assert.ok(r, `${table}.${col} = ${value} tidak ditemukan`);
  return r.id;
}

const partnerId = (code) => id('partners', 'code', code);
const productId = (sku) => id('products', 'sku', sku);

async function quant(sku, loc) {
  const r = await db.one(`SELECT sq.on_hand, sq.reserved, sq.on_hand - sq.reserved AS available FROM stock_quants sq
    JOIN products p ON p.id = sq.product_id JOIN locations l ON l.id = sq.location_id WHERE p.sku = ? AND l.code = ?`, [sku, loc]);
  return { onHand: r.on_hand, reserved: r.reserved, available: Number(r.available) };
}

async function balance(code) {
  return accountBalance(db.getPool(), code);
}

async function arOf(code) {
  return partnerBalance(db.getPool(), '110', await partnerId(code));
}

async function totalStock() {
  const r = await db.one('SELECT SUM(sq.on_hand) AS units, SUM(sq.on_hand * p.standard_cost) AS value FROM stock_quants sq JOIN products p ON p.id = sq.product_id');
  return { units: Number(r.units), value: Number(r.value) };
}

/** Pastikan promise ditolak dengan aturan SR tertentu dan kembalikan error-nya. */
async function rejects(promise, rule) {
  let caught = null;
  try { await promise; } catch (e) { caught = e; }
  assert.ok(caught, `Seharusnya ditolak (${rule}) tetapi berhasil`);
  assert.equal(caught.rule, rule, `Aturan berbeda: ${caught.message}`);
  return caught;
}

async function lastAudit(action) {
  return db.one('SELECT * FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1', [action]);
}

async function trialBalanced() {
  const r = await db.one("SELECT SUM(l.debit) d, SUM(l.credit) c FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id AND e.state = 'posted'");
  return Number(r.d) === Number(r.c);
}

module.exports = { assert, db, fresh, ctx, id, partnerId, productId, quant, balance, arOf, totalStock, rejects, lastAudit, trialBalanced };
