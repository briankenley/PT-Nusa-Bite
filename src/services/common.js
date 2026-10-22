'use strict';
const { q1, q } = require('../db');
const { NotFoundError } = require('../lib/errors');

async function locationByCode(conn, code) {
  const loc = await q1(conn, 'SELECT * FROM locations WHERE code = ?', [code]);
  if (!loc) throw new NotFoundError(`Lokasi ${code} tidak ditemukan`);
  return loc;
}

async function locationById(conn, id) {
  const loc = await q1(conn, 'SELECT * FROM locations WHERE id = ?', [id]);
  if (!loc) throw new NotFoundError('Lokasi tidak ditemukan');
  return loc;
}

async function getTax(conn, code) {
  const tax = await q1(conn, 'SELECT * FROM taxes WHERE code = ?', [code]);
  if (!tax) throw new NotFoundError(`Pajak ${code} tidak ditemukan`);
  return tax;
}

async function getPartner(conn, id) {
  const p = await q1(conn, 'SELECT * FROM partners WHERE id = ?', [id]);
  if (!p) throw new NotFoundError('Kontak tidak ditemukan');
  return p;
}

async function getProduct(conn, id) {
  const p = await q1(conn, 'SELECT * FROM products WHERE id = ?', [id]);
  if (!p) throw new NotFoundError('Produk tidak ditemukan');
  return p;
}

async function getTerm(conn, code) {
  return q1(conn, 'SELECT * FROM payment_terms WHERE code = ?', [code]);
}

async function userNames(conn) {
  const rows = await q(conn, 'SELECT id, username FROM users');
  return Object.fromEntries(rows.map((r) => [r.id, r.username]));
}

module.exports = { locationByCode, locationById, getTax, getPartner, getProduct, getTerm, userNames };
