'use strict';
const { q, q1 } = require('../db');
const { computeLine } = require('../lib/money');
const { partnerBalance } = require('./accounting');

/** Kuantitas baris SO yang masih harus ditagih / sudah dikirim tetapi belum ditagih. */
function lineQuantities(l) {
  const netDelivered = l.qty_delivered - l.qty_returned;
  const netInvoiced = l.qty_invoiced - l.qty_credited;
  const openQty = l.qty - l.qty_cancelled - l.qty_returned; // kuantitas pesanan yang masih berlaku
  return {
    netDelivered,
    netInvoiced,
    uninvoiced: Math.max(0, openQty - netInvoiced),
    toInvoice: Math.max(0, netDelivered - netInvoiced),
  };
}

/**
 * Credit exposure (SR-09) = AR terbuka (saldo akun 110 per pelanggan)
 * + nilai Sales Order Confirmed yang belum ditagih, termasuk PBJT.
 */
async function creditExposure(conn, partnerId, { excludeOrderId = null } = {}) {
  const partner = await q1(conn, 'SELECT credit_limit FROM partners WHERE id = ?', [partnerId]);
  const ar = await partnerBalance(conn, '110', partnerId);
  const lines = await q(conn, `SELECT l.*, o.number, t.rate_pct FROM sale_order_lines l
    JOIN sale_orders o ON o.id = l.order_id JOIN taxes t ON t.code = l.tax_code
    WHERE o.partner_id = ? AND o.state = 'sale' AND o.id <> ?`, [partnerId, excludeOrderId || 0]);
  const byOrder = {};
  let uninvoiced = 0;
  for (const l of lines) {
    const { uninvoiced: qty } = lineQuantities(l);
    if (qty <= 0) continue;
    const value = computeLine({ unitPrice: l.unit_price, qty, discountPct: l.discount_pct, taxRatePct: l.rate_pct }).total;
    uninvoiced += value;
    byOrder[l.number] = (byOrder[l.number] || 0) + value;
  }
  return {
    ar,
    uninvoiced,
    orders: Object.entries(byOrder).map(([number, value]) => ({ number, value })),
    exposure: ar + uninvoiced,
    limit: partner ? Number(partner.credit_limit) : 0,
  };
}

module.exports = { creditExposure, lineQuantities };
