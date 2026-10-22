'use strict';
const { q, q1, getPool } = require('../db');
const { run } = require('../lib/action');
const { requirePerm, can } = require('../lib/acl');
const { BusinessError, NotFoundError } = require('../lib/errors');
const { nextNumber } = require('../lib/sequence');
const { nowStr, todayStr } = require('../lib/time');
const { computeLine, effectiveDiscountPct, needsDiscountApproval, rp, toInt, toPct } = require('../lib/money');
const audit = require('../lib/audit');
const policies = require('../policies');
const { creditExposure, lineQuantities } = require('./exposure');
const { locationByCode, getTax } = require('./common');
const stock = require('./stock');

const STATE_LABEL = { draft: 'Quotation', sale: 'Sales Order', cancel: 'Cancelled' };

async function listOrders() {
  const rows = await q(getPool(), `SELECT o.*, p.code AS partner_code, p.name AS partner_name, l.code AS location_code,
      (SELECT COALESCE(SUM(ol.qty), 0) FROM sale_order_lines ol WHERE ol.order_id = o.id) AS qty_total,
      (SELECT COALESCE(SUM(ol.qty_delivered), 0) FROM sale_order_lines ol WHERE ol.order_id = o.id) AS qty_delivered,
      (SELECT COALESCE(SUM(ol.qty_invoiced), 0) FROM sale_order_lines ol WHERE ol.order_id = o.id) AS qty_invoiced
    FROM sale_orders o JOIN partners p ON p.id = o.partner_id JOIN locations l ON l.id = o.location_id ORDER BY o.id DESC`);
  return rows.map((r) => ({ ...r, ...orderStatuses(r) }));
}

function orderStatuses(o) {
  const qtyTotal = Number(o.qty_total || 0);
  const delivered = Number(o.qty_delivered || 0);
  const invoiced = Number(o.qty_invoiced || 0);
  let delivery = 'Nothing';
  if (o.state === 'sale') delivery = delivered === 0 ? 'Waiting' : delivered >= qtyTotal ? 'Delivered' : 'Partially delivered';
  let invoice = 'Nothing to invoice';
  if (o.state === 'sale') invoice = invoiced >= qtyTotal ? 'Fully invoiced' : delivered > invoiced ? 'To invoice' : invoiced > 0 ? 'Partially invoiced' : 'Nothing to invoice';
  return { delivery_status: delivery, invoice_status: invoice };
}

async function loadOrder(conn, id, lock = false) {
  const o = await q1(conn, `SELECT * FROM sale_orders WHERE id = ? ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!o) throw new NotFoundError('Sales Order tidak ditemukan');
  o.lines = await q(conn, `SELECT l.*, p.sku, p.name AS product_name, p.uom, p.standard_cost, t.rate_pct
    FROM sale_order_lines l JOIN products p ON p.id = l.product_id JOIN taxes t ON t.code = l.tax_code
    WHERE l.order_id = ? ORDER BY l.seq ${lock ? 'FOR UPDATE' : ''}`, [id]);
  return o;
}

async function getOrder(id) {
  const pool = getPool();
  const o = await loadOrder(pool, id);
  const extra = await q1(pool, `SELECT p.code AS partner_code, p.name AS partner_name, p.credit_limit, l.code AS location_code, l.name AS location_name,
      op.number AS opportunity_number, ld.number AS lead_number, ld.id AS lead_id,
      cu.username AS created_by_name, co.username AS confirmed_by_name, ap.username AS approved_by_name
    FROM sale_orders o JOIN partners p ON p.id = o.partner_id JOIN locations l ON l.id = o.location_id
    LEFT JOIN crm_opportunities op ON op.id = o.opportunity_id LEFT JOIN crm_leads ld ON ld.id = op.lead_id
    LEFT JOIN users cu ON cu.id = o.created_by LEFT JOIN users co ON co.id = o.confirmed_by LEFT JOIN users ap ON ap.id = o.approved_by
    WHERE o.id = ?`, [id]);
  Object.assign(o, extra);
  for (const l of o.lines) {
    Object.assign(l, lineQuantities(l));
    l.effective_discount = effectiveDiscountPct(l.list_price, l.unit_price, l.discount_pct);
    l.needs_approval = needsDiscountApproval(l.list_price, l.unit_price, l.discount_pct, policies.MAX_SALES_DISCOUNT_PCT);
  }
  Object.assign(o, orderStatuses({
    state: o.state,
    qty_total: o.lines.reduce((s, l) => s + l.qty, 0),
    qty_delivered: o.lines.reduce((s, l) => s + l.qty_delivered, 0),
    qty_invoiced: o.lines.reduce((s, l) => s + l.qty_invoiced, 0),
  }));
  o.pickings = await q(pool, 'SELECT id, number, picking_type, state FROM pickings WHERE sale_order_id = ? ORDER BY id', [id]);
  o.invoices = await q(pool, 'SELECT id, number, move_type, state, payment_state, amount_total, amount_residual FROM invoices WHERE sale_order_id = ? ORDER BY id', [id]);
  o.payments = await q(pool, `SELECT pay.id, pay.number, pay.amount, pay.method, pay.payment_date, i.number AS invoice_number FROM payments pay
    JOIN invoices i ON i.id = pay.invoice_id WHERE i.sale_order_id = ? ORDER BY pay.id`, [id]);
  o.revisions = await q(pool, `SELECT r.*, p.sku, u.username AS requested_by_name, d.username AS decided_by_name FROM sale_revisions r
    JOIN sale_order_lines l ON l.id = r.line_id JOIN products p ON p.id = l.product_id
    LEFT JOIN users u ON u.id = r.requested_by LEFT JOIN users d ON d.id = r.decided_by WHERE r.order_id = ? ORDER BY r.id`, [id]);
  o.exposure = o.state !== 'cancel' ? await creditExposure(pool, o.partner_id, { excludeOrderId: o.id }) : null;
  return o;
}

/** Bangun & validasi baris pesanan: SKU, kuantitas, harga, diskon, PBJT per baris. */
async function buildLines(conn, rawLines) {
  const tax = await getTax(conn, policies.PBJT_TAX);
  const out = [];
  for (const raw of rawLines || []) {
    if (!raw || !raw.productId) continue;
    const qty = toInt(raw.qty, 0);
    if (qty === 0 && (raw.qty === '' || raw.qty === undefined)) continue;
    const p = await q1(conn, 'SELECT * FROM products WHERE id = ? AND active = 1', [raw.productId]);
    if (!p) throw new NotFoundError('Produk tidak ditemukan');
    if (!Number.isInteger(qty) || qty <= 0) throw new BusinessError(`Kuantitas ${p.sku} harus bilangan bulat positif.`, { rule: 'SR-21' });
    const unitPrice = raw.unitPrice === undefined || raw.unitPrice === '' || raw.unitPrice === null ? p.sales_price : toInt(raw.unitPrice, -1);
    if (unitPrice < 0) throw new BusinessError(`Harga ${p.sku} tidak valid.`, { rule: 'SR-08' });
    const discountPct = toPct(raw.discountPct);
    if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) throw new BusinessError(`Diskon ${p.sku} harus 0–100%.`, { rule: 'SR-07' });
    const amounts = computeLine({ unitPrice, qty, discountPct, taxRatePct: tax.rate_pct });
    out.push({ product: p, qty, list_price: p.sales_price, unit_price: unitPrice, discount_pct: discountPct, tax_code: tax.code, ...amounts });
  }
  if (!out.length) throw new BusinessError('Pesanan harus memiliki minimal satu baris produk.', { rule: 'SR-01' });
  return out;
}

function approvalNeeded(lines) {
  return lines.some((l) => needsDiscountApproval(l.list_price, l.unit_price, l.discount_pct, policies.MAX_SALES_DISCOUNT_PCT));
}

async function writeLines(conn, orderId, lines) {
  await q(conn, 'DELETE FROM sale_order_lines WHERE order_id = ?', [orderId]);
  let seq = 1;
  for (const l of lines) {
    await q(conn, `INSERT INTO sale_order_lines (order_id, seq, product_id, qty, list_price, unit_price, discount_pct, tax_code, subtotal, tax_amount, total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orderId, seq++, l.product.id, l.qty, l.list_price, l.unit_price, l.discount_pct, l.tax_code, l.subtotal, l.tax, l.total]);
  }
  const totals = lines.reduce((t, l) => ({ untaxed: t.untaxed + l.subtotal, tax: t.tax + l.tax, total: t.total + l.total }), { untaxed: 0, tax: 0, total: 0 });
  return totals;
}

async function _createOrder(conn, ctx, data) {
  const partner = await q1(conn, 'SELECT * FROM partners WHERE id = ?', [data.partnerId]);
  if (!partner || !partner.is_customer) throw new BusinessError('Pilih pelanggan yang valid.', { rule: 'SR-09' });
  const location = await locationByCode(conn, data.locationCode || policies.SALES_LOCATION);
  if (location.usage_type !== 'internal') throw new BusinessError('Lokasi pengiriman harus lokasi internal.', { rule: 'SR-04' });
  const lines = await buildLines(conn, data.lines);
  const number = await nextNumber(conn, 'sale.order');
  const now = nowStr();
  const needs = approvalNeeded(lines);
  const [r] = await conn.query(`INSERT INTO sale_orders (number, partner_id, opportunity_id, location_id, state, is_counter, order_date, payment_term_code,
      discount_approval, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
  [number, partner.id, data.opportunityId || null, location.id, data.isCounter ? 1 : 0, todayStr(), partner.payment_term_code,
    needs ? 'pending' : 'none', data.note || null, ctx.user.id, now, now]);
  const totals = await writeLines(conn, r.insertId, lines);
  await q(conn, 'UPDATE sale_orders SET amount_untaxed = ?, amount_tax = ?, amount_total = ? WHERE id = ?', [totals.untaxed, totals.tax, totals.total, r.insertId]);
  await audit.log(conn, ctx, {
    action: 'QUOTATION_CREATE', docType: 'sale.order', docId: r.insertId, docNumber: number,
    message: `Quotation ${partner.code} total ${rp(totals.total)}${needs ? ' (menunggu persetujuan diskon Owner)' : ''}`,
    detail: { lines: lines.map((l) => ({ sku: l.product.sku, qty: l.qty, price: l.unit_price, disc: l.discount_pct })) },
  });
  await audit.note(conn, ctx, 'sale.order', r.insertId, `Quotation dibuat: subtotal ${rp(totals.untaxed)}, PBJT ${rp(totals.tax)}, total ${rp(totals.total)}.`);
  if (data.opportunityId) {
    await audit.note(conn, ctx, 'crm.opportunity', data.opportunityId, `Quotation ${number} dibuat dari opportunity ini.`);
  }
  return { id: r.insertId, number, totals };
}

async function createOrder(ctx, data) {
  return run(ctx, { action: 'QUOTATION_CREATE', docType: 'sale.order' }, async (conn) => {
    requirePerm(ctx, 'sales.edit');
    return (await _createOrder(conn, ctx, data)).id;
  });
}

/** SR-08: hanya Quotation (Draft) yang boleh diubah. Dokumen Confirmed terkunci. */
async function updateOrder(ctx, id, data) {
  return run(ctx, { action: 'QUOTATION_UPDATE', docType: 'sale.order', docId: id }, async (conn) => {
    requirePerm(ctx, 'sales.edit');
    const o = await loadOrder(conn, id, true);
    if (o.state !== 'draft') {
      throw new BusinessError(`${o.number} berstatus ${STATE_LABEL[o.state]}: harga, pajak, SKU, kuantitas, dan diskon terkunci. Perubahan hanya lewat dokumen Revisi dengan persetujuan Owner (SR-08).`, {
        rule: 'SR-08', docNumber: o.number, detail: { attempted: data.lines ? data.lines.map((l) => ({ productId: l.productId, unitPrice: l.unitPrice, discountPct: l.discountPct })) : null },
      });
    }
    const lines = await buildLines(conn, data.lines);
    const before = o.lines.map((l) => `${l.sku}×${l.qty}@${l.unit_price}-${l.discount_pct}%`).join(', ');
    const totals = await writeLines(conn, id, lines);
    const needs = approvalNeeded(lines);
    // Setiap perubahan baris membatalkan persetujuan diskon sebelumnya.
    await q(conn, `UPDATE sale_orders SET amount_untaxed = ?, amount_tax = ?, amount_total = ?, discount_approval = ?, approved_by = NULL, approved_at = NULL,
      note = ?, updated_at = ? WHERE id = ?`, [totals.untaxed, totals.tax, totals.total, needs ? 'pending' : 'none', data.note ?? o.note, nowStr(), id]);
    const after = lines.map((l) => `${l.product.sku}×${l.qty}@${l.unit_price}-${l.discount_pct}%`).join(', ');
    await audit.log(conn, ctx, { action: 'QUOTATION_UPDATE', docType: 'sale.order', docId: id, docNumber: o.number, message: `Baris diubah; total ${rp(totals.total)}`, detail: { before, after } });
    await audit.note(conn, ctx, 'sale.order', id, `Baris diubah: ${before} → ${after}. Total ${rp(totals.total)}.${needs ? ' Diskon > 10%: perlu persetujuan Owner.' : ''}`);
    return id;
  });
}

async function approveDiscount(ctx, id) {
  return run(ctx, { action: 'DISCOUNT_APPROVE', docType: 'sale.order', docId: id }, async (conn) => {
    requirePerm(ctx, 'sales.approve_discount');
    const o = await loadOrder(conn, id, true);
    if (o.state !== 'draft') throw new BusinessError(`${o.number} bukan Quotation.`, { rule: 'SR-07', docNumber: o.number });
    if (o.discount_approval !== 'pending') throw new BusinessError(`${o.number} tidak memerlukan persetujuan diskon.`, { rule: 'SR-07', docNumber: o.number });
    const now = nowStr();
    await q(conn, "UPDATE sale_orders SET discount_approval = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?", [ctx.user.id, now, now, id]);
    const detail = o.lines.map((l) => `${l.sku} ${effectiveDiscountPct(l.list_price, l.unit_price, l.discount_pct)}%`).join(', ');
    await audit.log(conn, ctx, { action: 'DISCOUNT_APPROVE', docType: 'sale.order', docId: id, docNumber: o.number, message: `Diskon disetujui Owner: ${detail}` });
    await audit.note(conn, ctx, 'sale.order', id, `Owner menyetujui diskon: ${detail}.`);
    return id;
  });
}

/** Konfirmasi Quotation → Sales Order: kontrol diskon (SR-07), kredit (SR-09), stok & reservasi (SR-04). */
async function _confirm(conn, ctx, orderId, { skipCredit = false } = {}) {
  const o = await loadOrder(conn, orderId, true);
  if (o.state !== 'draft') {
    throw new BusinessError(`${o.number} sudah berstatus ${STATE_LABEL[o.state]}; konfirmasi kedua ditolak (SR-12).`, { rule: 'SR-12', docNumber: o.number });
  }
  if (!o.lines.length) throw new BusinessError('Pesanan tanpa baris tidak dapat dikonfirmasi.', { rule: 'SR-01', docNumber: o.number });
  const overLimit = o.lines.filter((l) => needsDiscountApproval(l.list_price, l.unit_price, l.discount_pct, policies.MAX_SALES_DISCOUNT_PCT));
  if (overLimit.length && o.discount_approval !== 'approved') {
    const l = overLimit[0];
    throw new BusinessError(`Diskon efektif ${effectiveDiscountPct(l.list_price, l.unit_price, l.discount_pct)}% pada ${l.sku} melebihi ${policies.MAX_SALES_DISCOUNT_PCT}%; wajib persetujuan Owner sebelum konfirmasi (SR-07).`, {
      rule: 'SR-07', docNumber: o.number,
    });
  }
  const partner = await q1(conn, 'SELECT * FROM partners WHERE id = ? FOR UPDATE', [o.partner_id]);
  if (!skipCredit) {
    const ex = await creditExposure(conn, o.partner_id, { excludeOrderId: o.id });
    const projected = ex.exposure + o.amount_total;
    if (projected > Number(partner.credit_limit)) {
      throw new BusinessError(
        `Credit limit ${partner.code} terlampaui: AR terbuka ${rp(ex.ar)} + SO Confirmed belum ditagih ${rp(ex.uninvoiced)} + pesanan ini ${rp(o.amount_total)} `
        + `= ${rp(projected)} > limit ${rp(partner.credit_limit)}. Konfirmasi diblokir (SR-09).`,
        { rule: 'SR-09', docNumber: o.number, detail: { ar: ex.ar, uninvoiced: ex.uninvoiced, order: o.amount_total, exposure: projected, limit: Number(partner.credit_limit) } },
      );
    }
  }
  // Reservasi per SKU (agregat bila SKU muncul di beberapa baris).
  const perProduct = {};
  for (const l of o.lines) perProduct[l.product_id] = (perProduct[l.product_id] || 0) + l.qty;
  for (const [productId, qty] of Object.entries(perProduct)) {
    await stock.reserve(conn, { productId: Number(productId), locationId: o.location_id, qty, docNumber: o.number });
  }
  const customers = await locationByCode(conn, 'CUSTOMERS');
  const picking = await stock.createPicking(conn, ctx, {
    type: 'out', state: 'ready', partnerId: o.partner_id, srcId: o.location_id, destId: customers.id, saleOrderId: o.id,
    moves: o.lines.map((l) => ({ productId: l.product_id, qty: l.qty, reserved: l.qty, unitCost: l.standard_cost, saleLineId: l.id })),
  });
  const now = nowStr();
  await q(conn, "UPDATE sale_orders SET state = 'sale', confirmed_by = ?, confirmed_at = ?, updated_at = ? WHERE id = ?", [ctx.user.id, now, now, o.id]);
  if (o.opportunity_id) {
    await q(conn, "UPDATE crm_opportunities SET stage = 'won', expected_revenue = GREATEST(expected_revenue, ?), updated_at = ? WHERE id = ?", [o.amount_untaxed, now, o.opportunity_id]);
    await audit.note(conn, ctx, 'crm.opportunity', o.opportunity_id, `Won: ${o.number} dikonfirmasi.`);
  }
  const reserved = o.lines.map((l) => `${l.sku} ${l.qty}`).join(', ');
  await audit.log(conn, ctx, {
    action: 'SO_CONFIRM', docType: 'sale.order', docId: o.id, docNumber: o.number,
    message: `Confirmed total ${rp(o.amount_total)}; reservasi ${reserved}; delivery ${picking.number}`, detail: { picking: picking.number },
  });
  await audit.note(conn, ctx, 'sale.order', o.id, `Dikonfirmasi. Harga, pajak, SKU, dan diskon kini terkunci. Reservasi: ${reserved}. Delivery ${picking.number} dibuat.`);
  await audit.note(conn, ctx, 'stock.picking', picking.id, `Dibuat dari ${o.number}; stok direservasi.`);
  return { order: o, picking };
}

async function confirmOrder(ctx, id) {
  return run(ctx, { action: 'SO_CONFIRM', docType: 'sale.order', docId: id }, async (conn) => {
    requirePerm(ctx, 'sales.edit');
    const r = await _confirm(conn, ctx, id);
    return { id, picking: r.picking };
  });
}

async function cancelOrder(ctx, id) {
  return run(ctx, { action: 'SO_CANCEL', docType: 'sale.order', docId: id }, async (conn) => {
    requirePerm(ctx, 'sales.edit');
    const o = await loadOrder(conn, id, true);
    if (o.state === 'cancel') throw new BusinessError(`${o.number} sudah dibatalkan.`, { rule: 'SR-12', docNumber: o.number });
    if (o.lines.some((l) => l.qty_delivered > 0 || l.qty_invoiced > 0)) {
      throw new BusinessError(`${o.number} sudah memiliki pengiriman/tagihan; batalkan sisa lewat backorder atau buat retur/credit note (SR-02, SR-10).`, { rule: 'SR-10', docNumber: o.number });
    }
    const picks = await q(conn, "SELECT id FROM pickings WHERE sale_order_id = ? AND state NOT IN ('done','cancel') FOR UPDATE", [id]);
    for (const pk of picks) {
      const moves = await q(conn, 'SELECT * FROM stock_moves WHERE picking_id = ? FOR UPDATE', [pk.id]);
      for (const m of moves) {
        if (m.qty_reserved > 0) await stock.unreserve(conn, m.product_id, m.src_location_id, m.qty_reserved);
        await q(conn, "UPDATE stock_moves SET state = 'cancel', qty_reserved = 0 WHERE id = ?", [m.id]);
      }
      await q(conn, "UPDATE pickings SET state = 'cancel' WHERE id = ?", [pk.id]);
    }
    await q(conn, "UPDATE sale_orders SET state = 'cancel', updated_at = ? WHERE id = ?", [nowStr(), id]);
    await audit.log(conn, ctx, { action: 'SO_CANCEL', docType: 'sale.order', docId: id, docNumber: o.number, message: `${o.number} dibatalkan; reservasi dilepas` });
    await audit.note(conn, ctx, 'sale.order', id, 'Dibatalkan; reservasi dilepas.');
    return id;
  });
}

/** SR-08: koreksi harga/diskon setelah Confirmed lewat dokumen revisi yang disetujui Owner. */
async function requestRevision(ctx, orderId, data) {
  return run(ctx, { action: 'REVISION_REQUEST', docType: 'sale.order', docId: orderId }, async (conn) => {
    requirePerm(ctx, 'sales.revision_request');
    const o = await loadOrder(conn, orderId, true);
    if (o.state !== 'sale') throw new BusinessError('Revisi hanya untuk Sales Order Confirmed; Quotation dapat diedit langsung.', { rule: 'SR-08', docNumber: o.number });
    const line = o.lines.find((l) => l.id === Number(data.lineId));
    if (!line) throw new NotFoundError('Baris tidak ditemukan');
    if (line.qty_delivered > 0 || line.qty_invoiced > 0) {
      throw new BusinessError(`Baris ${line.sku} sudah dikirim/ditagih; koreksi nilai harus lewat retur/credit note agar rekonsiliasi tetap sah (SR-08, SR-10).`, { rule: 'SR-08', docNumber: o.number });
    }
    const newPrice = data.newUnitPrice === '' || data.newUnitPrice === undefined ? line.unit_price : toInt(data.newUnitPrice, -1);
    const newDisc = data.newDiscount === '' || data.newDiscount === undefined ? Number(line.discount_pct) : toPct(data.newDiscount);
    if (newPrice < 0 || !Number.isFinite(newDisc) || newDisc < 0 || newDisc > 100) throw new BusinessError('Harga/diskon revisi tidak valid.', { rule: 'SR-08', docNumber: o.number });
    const reason = String(data.reason || '').trim();
    if (!reason) throw new BusinessError('Alasan revisi wajib diisi untuk jejak audit (SR-08).', { rule: 'SR-08', docNumber: o.number });
    if (newPrice === line.unit_price && newDisc === Number(line.discount_pct)) throw new BusinessError('Tidak ada perubahan yang diajukan.', { rule: 'SR-08', docNumber: o.number });
    const number = await nextNumber(conn, 'sale.revision');
    const [r] = await conn.query(`INSERT INTO sale_revisions (number, order_id, line_id, old_unit_price, new_unit_price, old_discount, new_discount, reason, state, requested_by, requested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`, [number, o.id, line.id, line.unit_price, newPrice, line.discount_pct, newDisc, reason, ctx.user.id, nowStr()]);
    const msg = `${number}: ${line.sku} harga ${rp(line.unit_price)} → ${rp(newPrice)}, diskon ${line.discount_pct}% → ${newDisc}% (menunggu persetujuan Owner; SO belum berubah)`;
    await audit.log(conn, ctx, { action: 'REVISION_REQUEST', docType: 'sale.order', docId: o.id, docNumber: o.number, message: msg, detail: { revision: number, reason } });
    await audit.note(conn, ctx, 'sale.order', o.id, `Revisi diajukan — ${msg}. Alasan: ${reason}.`);
    return r.insertId;
  });
}

async function decideRevision(ctx, revisionId, approve) {
  return run(ctx, { action: approve ? 'REVISION_APPROVE' : 'REVISION_REJECT', docType: 'sale.revision', docId: revisionId }, async (conn) => {
    requirePerm(ctx, 'sales.revision_approve');
    const rev = await q1(conn, 'SELECT * FROM sale_revisions WHERE id = ? FOR UPDATE', [revisionId]);
    if (!rev) throw new NotFoundError('Revisi tidak ditemukan');
    if (rev.state !== 'pending') throw new BusinessError(`${rev.number} sudah ${rev.state}.`, { rule: 'SR-12', docNumber: rev.number });
    const o = await loadOrder(conn, rev.order_id, true);
    const line = o.lines.find((l) => l.id === rev.line_id);
    const now = nowStr();
    if (!approve) {
      await q(conn, "UPDATE sale_revisions SET state = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?", [ctx.user.id, now, rev.id]);
      await audit.log(conn, ctx, { action: 'REVISION_REJECT', docType: 'sale.order', docId: o.id, docNumber: o.number, message: `${rev.number} ditolak Owner` });
      await audit.note(conn, ctx, 'sale.order', o.id, `${rev.number} ditolak Owner; harga dan diskon tetap.`);
      return rev.id;
    }
    if (line.qty_delivered > 0 || line.qty_invoiced > 0) throw new BusinessError('Baris sudah dikirim/ditagih; revisi tidak dapat diterapkan.', { rule: 'SR-08', docNumber: o.number });
    const amounts = computeLine({ unitPrice: rev.new_unit_price, qty: line.qty, discountPct: rev.new_discount, taxRatePct: line.rate_pct });
    const newTotal = o.amount_total - line.total + amounts.total;
    const partner = await q1(conn, 'SELECT * FROM partners WHERE id = ?', [o.partner_id]);
    const ex = await creditExposure(conn, o.partner_id, { excludeOrderId: o.id });
    if (!o.is_counter && ex.exposure + newTotal > Number(partner.credit_limit)) {
      throw new BusinessError(`Revisi membuat exposure ${rp(ex.exposure + newTotal)} melebihi credit limit ${rp(partner.credit_limit)} (SR-09).`, { rule: 'SR-09', docNumber: o.number });
    }
    await q(conn, 'UPDATE sale_order_lines SET unit_price = ?, discount_pct = ?, subtotal = ?, tax_amount = ?, total = ? WHERE id = ?',
      [rev.new_unit_price, rev.new_discount, amounts.subtotal, amounts.tax, amounts.total, line.id]);
    const totals = await q1(conn, 'SELECT SUM(subtotal) u, SUM(tax_amount) t, SUM(total) g FROM sale_order_lines WHERE order_id = ?', [o.id]);
    await q(conn, 'UPDATE sale_orders SET amount_untaxed = ?, amount_tax = ?, amount_total = ?, updated_at = ? WHERE id = ?', [totals.u, totals.t, totals.g, now, o.id]);
    await q(conn, "UPDATE sale_revisions SET state = 'applied', decided_by = ?, decided_at = ? WHERE id = ?", [ctx.user.id, now, rev.id]);
    const msg = `${rev.number} diterapkan: ${line.sku} ${rp(rev.old_unit_price)}/${rev.old_discount}% → ${rp(rev.new_unit_price)}/${rev.new_discount}%; total ${rp(o.amount_total)} → ${rp(totals.g)}`;
    await audit.log(conn, ctx, { action: 'REVISION_APPROVE', docType: 'sale.order', docId: o.id, docNumber: o.number, message: msg, detail: { old: { price: rev.old_unit_price, disc: rev.old_discount }, new: { price: rev.new_unit_price, disc: rev.new_discount } } });
    await audit.note(conn, ctx, 'sale.order', o.id, msg);
    return rev.id;
  });
}

module.exports = {
  STATE_LABEL, listOrders, getOrder, loadOrder, buildLines, _createOrder, createOrder, updateOrder, approveDiscount,
  _confirm, confirmOrder, cancelOrder, requestRevision, decideRevision, can,
};
