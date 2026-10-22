'use strict';
const { q, getPool } = require('../db');
const { todayStr, addDays } = require('../lib/time');

/**
 * F-23 (Optional): saran pembelian berbasis rerata penjualan 7 hari.
 * rerata harian = unit terkirim (Delivery Done, dikurangi retur) 7 hari terakhir ÷ 7
 * target = rerata × hari cakupan; saran = max(0, target − Available perusahaan − barang dalam perjalanan PO).
 * Hanya saran (read-only); keputusan membuat RFQ tetap di tangan pengguna.
 */
async function suggestions({ coverDays = 7, today = todayStr() } = {}) {
  const from = addDays(today, -6);
  const rows = await q(getPool(), `SELECT p.id, p.sku, p.name, p.size, p.uom, p.standard_cost, v.id AS vendor_id, v.code AS vendor_code, v.name AS vendor_name,
      COALESCE((SELECT SUM(m.qty_done) FROM stock_moves m JOIN pickings pk ON pk.id = m.picking_id
        WHERE m.product_id = p.id AND pk.picking_type = 'out' AND m.state = 'done' AND DATE(m.done_at) BETWEEN ? AND ?), 0) AS sold,
      COALESCE((SELECT SUM(m.qty_done) FROM stock_moves m JOIN pickings pk ON pk.id = m.picking_id
        WHERE m.product_id = p.id AND pk.picking_type = 'ret' AND m.state = 'done' AND DATE(m.done_at) BETWEEN ? AND ?), 0) AS returned,
      COALESCE((SELECT SUM(sq.on_hand - sq.reserved) FROM stock_quants sq WHERE sq.product_id = p.id), 0) AS available,
      COALESCE((SELECT SUM(m.qty_demand) FROM stock_moves m JOIN pickings pk ON pk.id = m.picking_id
        WHERE m.product_id = p.id AND pk.picking_type = 'in' AND pk.state IN ('ready','qc')), 0) AS incoming
    FROM products p LEFT JOIN partners v ON v.id = p.default_vendor_id WHERE p.active = 1 ORDER BY p.id`, [from, today, from, today]);
  return rows.map((r) => {
    const net = Number(r.sold) - Number(r.returned);
    const avg = Math.max(0, net) / 7;
    const target = Math.ceil(avg * coverDays);
    const suggest = Math.max(0, target - Number(r.available) - Number(r.incoming));
    return { ...r, net, avg: Math.round(avg * 100) / 100, target, available: Number(r.available), incoming: Number(r.incoming), suggest };
  });
}

module.exports = { suggestions };
