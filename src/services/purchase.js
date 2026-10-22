'use strict';
const { q, q1, getPool } = require('../db');
const { run } = require('../lib/action');
const { requirePerm } = require('../lib/acl');
const { BusinessError, NotFoundError } = require('../lib/errors');
const { nextNumber } = require('../lib/sequence');
const { nowStr, todayStr } = require('../lib/time');
const { computeLine, rp, toInt } = require('../lib/money');
const audit = require('../lib/audit');
const policies = require('../policies');
const { locationByCode, getTax } = require('./common');
const stock = require('./stock');

const STATE_LABEL = { draft: 'RFQ', purchase: 'Purchase Order', cancel: 'Cancelled' };

async function listOrders() {
  return q(getPool(), `SELECT o.*, p.code AS partner_code, p.name AS partner_name,
      (SELECT COALESCE(SUM(l.qty), 0) FROM purchase_order_lines l WHERE l.order_id = o.id) AS qty_total,
      (SELECT COALESCE(SUM(l.qty_received), 0) FROM purchase_order_lines l WHERE l.order_id = o.id) AS qty_received,
      (SELECT COALESCE(SUM(l.qty_billed), 0) FROM purchase_order_lines l WHERE l.order_id = o.id) AS qty_billed
    FROM purchase_orders o JOIN partners p ON p.id = o.partner_id ORDER BY o.id DESC`);
}

async function loadOrder(conn, id, lock = false) {
  const o = await q1(conn, `SELECT * FROM purchase_orders WHERE id = ? ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!o) throw new NotFoundError('Purchase Order tidak ditemukan');
  o.lines = await q(conn, `SELECT l.*, p.sku, p.name AS product_name, p.uom, p.standard_cost FROM purchase_order_lines l
    JOIN products p ON p.id = l.product_id WHERE l.order_id = ? ORDER BY l.seq ${lock ? 'FOR UPDATE' : ''}`, [id]);
  return o;
}

async function getOrder(id) {
  const pool = getPool();
  const o = await loadOrder(pool, id);
  Object.assign(o, await q1(pool, `SELECT p.code AS partner_code, p.name AS partner_name, l.code AS dest_code, cu.username AS created_by_name, co.username AS confirmed_by_name
    FROM purchase_orders o JOIN partners p ON p.id = o.partner_id JOIN locations l ON l.id = o.dest_location_id
    LEFT JOIN users cu ON cu.id = o.created_by LEFT JOIN users co ON co.id = o.confirmed_by WHERE o.id = ?`, [id]));
  o.receipts = await q(pool, "SELECT id, number, state FROM pickings WHERE purchase_order_id = ? AND picking_type = 'in' ORDER BY id", [id]);
  o.bills = await q(pool, "SELECT id, number, state, payment_state, amount_total, amount_residual FROM invoices WHERE purchase_order_id = ? ORDER BY id", [id]);
  return o;
}

async function buildLines(conn, partnerId, rawLines) {
  const tax = await getTax(conn, policies.PURCHASE_TAX);
  const out = [];
  for (const raw of rawLines || []) {
    if (!raw || !raw.productId) continue;
    if (raw.qty === '' || raw.qty === undefined) continue;
    const qty = toInt(raw.qty, 0);
    const p = await q1(conn, 'SELECT * FROM products WHERE id = ?', [raw.productId]);
    if (!p) throw new NotFoundError('Produk tidak ditemukan');
    if (qty <= 0) throw new BusinessError(`Kuantitas ${p.sku} harus positif.`, { rule: 'SR-05' });
    let unitPrice = raw.unitPrice === undefined || raw.unitPrice === '' ? null : toInt(raw.unitPrice, -1);
    if (unitPrice === null) {
      const pl = await q1(conn, 'SELECT unit_price FROM vendor_pricelist WHERE vendor_id = ? AND product_id = ? AND min_qty <= ? ORDER BY min_qty DESC LIMIT 1', [partnerId, p.id, qty]);
      unitPrice = pl ? pl.unit_price : p.standard_cost;
    }
    if (unitPrice < 0) throw new BusinessError(`Harga ${p.sku} tidak valid.`, { rule: 'SR-05' });
    out.push({ product: p, qty, unit_price: unitPrice, tax_code: tax.code, ...computeLine({ unitPrice, qty, taxRatePct: tax.rate_pct }) });
  }
  if (!out.length) throw new BusinessError('RFQ harus memiliki minimal satu baris produk.', { rule: 'SR-05' });
  return out;
}

async function writeLines(conn, orderId, lines) {
  await q(conn, 'DELETE FROM purchase_order_lines WHERE order_id = ?', [orderId]);
  let seq = 1;
  for (const l of lines) {
    await q(conn, `INSERT INTO purchase_order_lines (order_id, seq, product_id, qty, unit_price, tax_code, subtotal, tax_amount, total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [orderId, seq++, l.product.id, l.qty, l.unit_price, l.tax_code, l.subtotal, l.tax, l.total]);
  }
  const t = lines.reduce((a, l) => ({ u: a.u + l.subtotal, t: a.t + l.tax, g: a.g + l.total }), { u: 0, t: 0, g: 0 });
  await q(conn, 'UPDATE purchase_orders SET amount_untaxed = ?, amount_tax = ?, amount_total = ? WHERE id = ?', [t.u, t.t, t.g, orderId]);
  return t;
}

async function createRFQ(ctx, data) {
  return run(ctx, { action: 'RFQ_CREATE', docType: 'purchase.order' }, async (conn) => {
    requirePerm(ctx, 'purchase.edit');
    if (data.number) {
      // Nomor dokumen selalu dari sequence; nilai yang dikirim pengguna tidak dipakai (SR-12).
      const exists = await q1(conn, 'SELECT id FROM purchase_orders WHERE number = ?', [String(data.number).trim()]);
      throw new BusinessError(`Nomor dokumen dibuat otomatis oleh sequence dan tidak dapat diisi manual${exists ? `; ${data.number} sudah dipakai dokumen lain` : ''} (SR-12).`, { rule: 'SR-12', docNumber: String(data.number) });
    }
    const vendor = await q1(conn, 'SELECT * FROM partners WHERE id = ?', [data.partnerId]);
    if (!vendor || !vendor.is_vendor) throw new BusinessError('Pilih vendor yang valid.', { rule: 'SR-05' });
    const dest = await locationByCode(conn, data.destCode || policies.PURCHASE_LOCATION);
    const lines = await buildLines(conn, vendor.id, data.lines);
    const number = await nextNumber(conn, 'purchase.order');
    const now = nowStr();
    const [r] = await conn.query(`INSERT INTO purchase_orders (number, partner_id, state, order_date, dest_location_id, note, created_by, created_at, updated_at)
      VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?)`, [number, vendor.id, todayStr(), dest.id, data.note || null, ctx.user.id, now, now]);
    const t = await writeLines(conn, r.insertId, lines);
    await audit.log(conn, ctx, { action: 'RFQ_CREATE', docType: 'purchase.order', docId: r.insertId, docNumber: number, message: `RFQ ${vendor.code} total ${rp(t.g)}` });
    await audit.note(conn, ctx, 'purchase.order', r.insertId, `RFQ dibuat untuk ${vendor.name}: total ${rp(t.g)}.`);
    return r.insertId;
  });
}

async function updateRFQ(ctx, id, data) {
  return run(ctx, { action: 'RFQ_UPDATE', docType: 'purchase.order', docId: id }, async (conn) => {
    requirePerm(ctx, 'purchase.edit');
    const o = await loadOrder(conn, id, true);
    if (data.number !== undefined && String(data.number).trim() !== o.number) {
      const other = await q1(conn, 'SELECT id FROM purchase_orders WHERE number = ? AND id <> ?', [String(data.number).trim(), id]);
      throw new BusinessError(`Nomor ${o.number} berasal dari sequence dan tidak boleh ditimpa menjadi ${String(data.number).trim()}${other ? ' (nomor tersebut sudah dipakai dokumen lain)' : ''}. Nomor unik dipertahankan (SR-12).`, {
        rule: 'SR-12', docNumber: o.number, detail: { attempted: String(data.number).trim(), conflict: !!other },
      });
    }
    if (o.state !== 'draft') throw new BusinessError(`${o.number} sudah ${STATE_LABEL[o.state]}; baris terkunci (SR-08).`, { rule: 'SR-08', docNumber: o.number });
    const lines = await buildLines(conn, o.partner_id, data.lines);
    const t = await writeLines(conn, id, lines);
    await q(conn, 'UPDATE purchase_orders SET note = ?, updated_at = ? WHERE id = ?', [data.note ?? o.note, nowStr(), id]);
    await audit.log(conn, ctx, { action: 'RFQ_UPDATE', docType: 'purchase.order', docId: id, docNumber: o.number, message: `Baris diubah; total ${rp(t.g)}` });
    await audit.note(conn, ctx, 'purchase.order', id, `Baris RFQ diubah; total ${rp(t.g)}.`);
    return id;
  });
}

async function confirmPO(ctx, id) {
  return run(ctx, { action: 'PO_CONFIRM', docType: 'purchase.order', docId: id }, async (conn) => {
    requirePerm(ctx, 'purchase.edit');
    const o = await loadOrder(conn, id, true);
    if (o.state !== 'draft') throw new BusinessError(`${o.number} sudah ${STATE_LABEL[o.state]}; konfirmasi kedua ditolak (SR-12).`, { rule: 'SR-12', docNumber: o.number });
    const vendors = await locationByCode(conn, 'VENDORS');
    const pk = await stock.createPicking(conn, ctx, {
      type: 'in', state: 'ready', partnerId: o.partner_id, srcId: vendors.id, destId: o.dest_location_id, purchaseOrderId: o.id,
      moves: o.lines.map((l) => ({ productId: l.product_id, qty: l.qty, unitCost: l.standard_cost, purchaseLineId: l.id })),
    });
    const now = nowStr();
    await q(conn, "UPDATE purchase_orders SET state = 'purchase', confirmed_by = ?, confirmed_at = ?, updated_at = ? WHERE id = ?", [ctx.user.id, now, now, id]);
    await audit.log(conn, ctx, { action: 'PO_CONFIRM', docType: 'purchase.order', docId: id, docNumber: o.number, message: `Purchase Order ${rp(o.amount_total)}; receipt ${pk.number}. Stok dan AP belum berubah.` });
    await audit.note(conn, ctx, 'purchase.order', id, `Dikonfirmasi menjadi Purchase Order. Receipt ${pk.number} menunggu barang. Stok dan AP belum berubah.`);
    await audit.note(conn, ctx, 'stock.picking', pk.id, `Dibuat dari ${o.number}.`);
    return { id, receipt: pk };
  });
}

async function cancelPO(ctx, id) {
  return run(ctx, { action: 'PO_CANCEL', docType: 'purchase.order', docId: id }, async (conn) => {
    requirePerm(ctx, 'purchase.edit');
    const o = await loadOrder(conn, id, true);
    if (o.state === 'cancel') throw new BusinessError(`${o.number} sudah dibatalkan.`, { rule: 'SR-12', docNumber: o.number });
    if (o.lines.some((l) => l.qty_received > 0 || l.qty_rejected > 0 || l.qty_billed > 0)) {
      throw new BusinessError(`${o.number} sudah memiliki penerimaan/bill.`, { rule: 'SR-19', docNumber: o.number });
    }
    const picks = await q(conn, "SELECT id, state FROM pickings WHERE purchase_order_id = ? AND state NOT IN ('done','cancel') FOR UPDATE", [id]);
    for (const pk of picks) {
      if (pk.state === 'qc') throw new BusinessError('Receipt sedang dalam Quality Check.', { rule: 'SR-19', docNumber: o.number });
      await q(conn, "UPDATE stock_moves SET state = 'cancel' WHERE picking_id = ?", [pk.id]);
      await q(conn, "UPDATE pickings SET state = 'cancel' WHERE id = ?", [pk.id]);
    }
    await q(conn, "UPDATE purchase_orders SET state = 'cancel', updated_at = ? WHERE id = ?", [nowStr(), id]);
    await audit.log(conn, ctx, { action: 'PO_CANCEL', docType: 'purchase.order', docId: id, docNumber: o.number, message: `${o.number} dibatalkan` });
    await audit.note(conn, ctx, 'purchase.order', id, 'Dibatalkan.');
    return id;
  });
}

module.exports = { STATE_LABEL, listOrders, getOrder, loadOrder, createRFQ, updateRFQ, confirmPO, cancelPO };
