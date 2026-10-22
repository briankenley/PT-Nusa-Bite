'use strict';
const { q1, q } = require('../db');

/**
 * Ambil nomor dokumen berikutnya. Baris sequence dikunci (FOR UPDATE) sehingga dua transaksi
 * bersamaan tidak pernah mendapat nomor yang sama; bila transaksi batal, nomor tidak terpakai.
 */
async function nextNumber(conn, code, date = new Date()) {
  const s = await q1(conn, 'SELECT prefix, padding, next_number FROM sequences WHERE code = ? FOR UPDATE', [code]);
  if (!s) throw new Error(`Sequence ${code} tidak ditemukan`);
  await q(conn, 'UPDATE sequences SET next_number = next_number + 1 WHERE code = ?', [code]);
  const prefix = s.prefix.replace('{Y}', String(date.getFullYear()));
  return prefix + String(s.next_number).padStart(s.padding, '0');
}

module.exports = { nextNumber };
