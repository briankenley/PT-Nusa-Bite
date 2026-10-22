'use strict';
const { q, q1, getPool } = require('../db');
const { run } = require('../lib/action');
const { requirePerm } = require('../lib/acl');
const { BusinessError, NotFoundError } = require('../lib/errors');
const { nextNumber } = require('../lib/sequence');
const { nowStr, todayStr, addDays } = require('../lib/time');
const { computeLine, rp, toInt } = require('../lib/money');
const audit = require('../lib/audit');
const policies = require('../policies');
const { postEntry } = require('./accounting');
const { lineQuantities } = require('./exposure');

const TYPE_LABEL = { out_invoice: 'Customer Invoice', out_refund: 'Credit Note', in_invoice: 'Vendor Bill' };
const SEQ = { out_invoice: 'invoice.out', out_refund: 'invoice.refund', in_invoice: 'invoice.in' };

async function listInvoices({ moveType } = {}) {
  const params = [];
  let cond = '';
  if (moveType) { cond = 'WHERE i.move_type = ?'; params.push(moveType); }
  return q(getPool(), `SELECT i.*, p.code AS partner_code, p.name AS partner_name, so.number AS so_number, po.number AS po_number, oi.number AS origin_number
    FROM invoices i JOIN partners p ON p.id = i.partner_id LEFT JOIN sale_orders so ON so.id = i.sale_order_id
    LEFT JOIN purchase_orders po ON po.id = i.purchase_order_id LEFT JOIN invoices oi ON oi.id = i.origin_invoice_id
    ${cond} ORDER BY i.id DESC`, params);
}

async function loadInvoice(conn, id, lock = false) {
  const inv = await q1(conn, `SELECT * FROM invoices WHERE id = ? ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!inv) throw new NotFoundError('Dokumen tagihan tidak ditemukan');
  inv.lines = await q(conn, `SELECT l.*, p.sku, p.name AS product_name, p.uom, t.rate_pct FROM invoice_lines l
    JOIN products p ON p.id = l.product_id JOIN taxes t ON t.code = l.tax_code WHERE l.invoice_id = ? ORDER BY l.seq`, [id]);
  return inv;
}

async function getInvoice(id) {
  const pool = getPool();
  const inv = await loadInvoice(pool, id);
  Object.assign(inv, await q1(pool, `SELECT p.code AS partner_code, p.name AS partner_name, so.number AS so_number, po.number AS po_number,
      oi.number AS origin_number, rp.number AS return_number, je.number AS entry_number, cu.username AS created_by_name, pu.username AS posted_by_name
    FROM invoices i JOIN partners p ON p.id = i.partner_id LEFT JOIN sale_orders so ON so.id = i.sale_order_id
    LEFT JOIN purchase_orders po ON po.id = i.purchase_order_id LEFT JOIN invoices oi ON oi.id = i.origin_invoice_id
    LEFT JOIN pickings rp ON rp.id = i.return_picking_id LEFT JOIN journal_entries je ON je.id = i.journal_entry_id
    LEFT JOIN users cu ON cu.id = i.created_by LEFT JOIN users pu ON pu.id = i.posted_by WHERE i.id = ?`, [id]));
  inv.type_label = TYPE_LABEL[inv.move_type];
  inv.payments = await q(pool, 'SELECT p.*, u.username AS created_by_name FROM payments p LEFT JOIN users u ON u.id = p.created_by WHERE p.invoice_id = ? ORDER BY p.id', [id]);
  inv.reconciliations = await q(pool, `SELECT r.*, CASE r.source_type WHEN 'payment' THEN (SELECT number FROM payments WHERE id = r.source_id)
      ELSE (SELECT number FROM invoices WHERE id = r.source_id) END AS source_number FROM reconciliations r WHERE r.invoice_id = ? ORDER BY r.id`, [id]);
  inv.applied_to = await q(pool, `SELECT r.amount, i.id, i.number FROM reconciliations r JOIN invoices i ON i.id = r.invoice_id
    WHERE r.source_type = 'credit_note' AND r.source_id = ?`, [id]);
  inv.credit_notes = await q(pool, "SELECT id, number, state, amount_total FROM invoices WHERE origin_invoice_id = ? AND move_type = 'out_refund'", [id]);
  if (inv.move_type === 'in_invoice' && inv.purchase_order_id) {
    // Three-way match: PO (ordered) vs Receipt (accepted) vs Bill.
    inv.match = await q(pool, `SELECT l.id, p.sku, l.qty AS ordered, l.qty_received AS accepted, l.qty_rejected AS rejected, l.qty_billed AS billed, l.unit_price
      FROM purchase_order_lines l JOIN products p ON p.id = l.product_id WHERE l.order_id = ? ORDER BY l.seq`, [inv.purchase_order_id]);
  }
  if (inv.move_type === 'out_invoice' && inv.sale_order_id) {
    inv.match = await q(pool, `SELECT l.id, p.sku, l.qty AS ordered, l.qty_delivered AS delivered, l.qty_returned AS returned, l.qty_invoiced AS invoiced
      FROM sale_order_lines l JOIN products p ON p.id = l.product_id WHERE l.order_id = ? ORDER BY l.seq`, [inv.sale_order_id]);
  }
  return inv;
}

async function draftQty(conn, field, lineId, excludeInvoiceId) {
  const r = await q1(conn, `SELECT COALESCE(SUM(il.qty), 0) AS qty FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
    WHERE il.${field} = ? AND i.state = 'draft' AND i.move_type IN ('out_invoice','in_invoice') AND i.id <> ?`, [lineId, excludeInvoiceId || 0]);
  return Number(r.qty);
}

/** SR-02: sisa yang boleh ditagih = Delivery Done (neto retur) − sudah ditagih (neto credit note) − draft lain. */
async function invoiceableQty(conn, soLine, excludeInvoiceId) {
  const { toInvoice } = lineQuantities(soLine);
  return Math.max(0, toInvoice - (await draftQty(conn, 'sale_line_id', soLine.id, excludeInvoiceId)));
}

/** SR-06: sisa yang boleh ditagih vendor = accepted − sudah di-bill − draft lain. */
async function billableQty(conn, poLine, excludeInvoiceId) {
  return Math.max(0, poLine.qty_received - poLine.qty_billed - (await draftQty(conn, 'purchase_line_id', poLine.id, excludeInvoiceId)));
}

async function insertInvoice(conn, ctx, inv, lines) {
  const totals = lines.reduce((t, l) => ({ u: t.u + l.subtotal, t: t.t + l.tax, g: t.g + l.total }), { u: 0, t: 0, g: 0 });
  const [r] = await conn.query(`INSERT INTO invoices (number, move_type, partner_id, sale_order_id, purchase_order_id, origin_invoice_id, return_picking_id, state,
      payment_term_code, amount_untaxed, amount_tax, amount_total, amount_residual, note, created_by, created_at)
    VALUES (NULL, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, 0, ?, ?, ?)`,
  [inv.moveType, inv.partnerId, inv.saleOrderId || null, inv.purchaseOrderId || null, inv.originInvoiceId || null, inv.returnPickingId || null,
    inv.paymentTerm, totals.u, totals.t, totals.g, inv.note || null, ctx.user.id, nowStr()]);
  let seq = 1;
  for (const l of lines) {
    await q(conn, `INSERT INTO invoice_lines (invoice_id, seq, product_id, sale_line_id, purchase_line_id, qty, unit_price, discount_pct, tax_code, subtotal, tax_amount, total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [r.insertId, seq++, l.productId, l.saleLineId || null, l.purchaseLineId || null, l.qty, l.unitPrice, l.discountPct || 0, l.taxCode, l.subtotal, l.tax, l.total]);
  }
  return { id: r.insertId, totals };
}

async function recomputeDraft(conn, invoiceId) {
  const t = await q1(conn, 'SELECT COALESCE(SUM(subtotal),0) u, COALESCE(SUM(tax_amount),0) t, COALESCE(SUM(total),0) g FROM invoice_lines WHERE invoice_id = ?', [invoiceId]);
  await q(conn, 'UPDATE invoices SET amount_untaxed = ?, amount_tax = ?, amount_total = ? WHERE id = ?', [t.u, t.t, t.g, invoiceId]);
  return t;
}

// ---------------------------------------------------------------- Customer Invoice (SR-01/SR-02, PBJT)

async function _createFromSale(conn, ctx, soId) {
  const so = await q1(conn, 'SELECT * FROM sale_orders WHERE id = ? FOR UPDATE', [soId]);
  if (!so) throw new NotFoundError('Sales Order tidak ditemukan');
  if (so.state !== 'sale') throw new BusinessError(`${so.number} belum Confirmed.`, { rule: 'SR-02', docNumber: so.number });
  const soLines = await q(conn, 'SELECT l.*, t.rate_pct FROM sale_order_lines l JOIN taxes t ON t.code = l.tax_code WHERE l.order_id = ? ORDER BY l.seq FOR UPDATE', [soId]);
  const lines = [];
  for (const l of soLines) {
    const qty = await invoiceableQty(conn, l);
    if (qty <= 0) continue;
    const a = computeLine({ unitPrice: l.unit_price, qty, discountPct: l.discount_pct, taxRatePct: l.rate_pct });
    lines.push({ productId: l.product_id, saleLineId: l.id, qty, unitPrice: l.unit_price, discountPct: l.discount_pct, taxCode: l.tax_code, ...a });
  }
  if (!lines.length) {
    throw new BusinessError(`Tidak ada kuantitas Delivery Order Done yang belum ditagih pada ${so.number}. Invoice hanya memuat kuantitas terkirim (SR-02).`, { rule: 'SR-02', docNumber: so.number });
  }
  const inv = await insertInvoice(conn, ctx, { moveType: 'out_invoice', partnerId: so.partner_id, saleOrderId: so.id, paymentTerm: so.payment_term_code }, lines);
  await audit.log(conn, ctx, { action: 'INVOICE_CREATE', docType: 'account.move', docId: inv.id, docNumber: so.number, message: `Draft invoice ${rp(inv.totals.g)} dari ${so.number}` });
  await audit.note(conn, ctx, 'account.move', inv.id, `Draft Customer Invoice dibuat dari ${so.number} untuk kuantitas Done yang belum ditagih.`);
  await audit.note(conn, ctx, 'sale.order', so.id, `Draft invoice dibuat: ${rp(inv.totals.g)}.`);
  return inv.id;
}

async function createInvoiceFromSale(ctx, soId) {
  return run(ctx, { action: 'INVOICE_CREATE', docType: 'sale.order', docId: soId }, async (conn) => {
    requirePerm(ctx, 'invoicing.edit');
    return _createFromSale(conn, ctx, soId);
  });
}

/** Ubah kuantitas pada draft invoice/bill. Kuantitas di atas batas ditolak (SR-02 / SR-06). */
async function updateDraftQuantities(ctx, invoiceId, qtys) {
  return run(ctx, { action: 'INVOICE_UPDATE', docType: 'account.move', docId: invoiceId }, async (conn) => {
    const inv = await loadInvoice(conn, invoiceId, true);
    requirePerm(ctx, inv.move_type === 'in_invoice' ? 'accounting.edit' : 'invoicing.edit');
    if (inv.state !== 'draft') throw new BusinessError(`${inv.number} sudah Posted; baris terkunci (SR-08).`, { rule: 'SR-08', docNumber: inv.number });
    if (inv.move_type === 'out_refund') throw new BusinessError('Kuantitas Credit Note mengikuti dokumen retur yang tervalidasi (SR-10).', { rule: 'SR-10' });
    const changes = [];
    for (const l of inv.lines) {
      if (qtys[l.id] === undefined) continue;
      const qty = toInt(qtys[l.id], -1);
      if (qty < 0) throw new BusinessError(`Kuantitas ${l.sku} tidak valid.`, { rule: 'SR-02' });
      if (qty === l.qty) continue;
      if (inv.move_type === 'out_invoice') {
        const sol = await q1(conn, 'SELECT * FROM sale_order_lines WHERE id = ? FOR UPDATE', [l.sale_line_id]);
        const max = await invoiceableQty(conn, sol, inv.id);
        if (qty > max) {
          throw new BusinessError(`Kuantitas ditagih ${l.sku} = ${qty} melebihi kuantitas Delivery Done yang belum ditagih (${max}). Pelanggan tidak boleh ditagih untuk barang yang belum diterima (SR-02).`, {
            rule: 'SR-02', detail: { sku: l.sku, requested: qty, delivered_not_invoiced: max, delivered: sol.qty_delivered, ordered: sol.qty },
          });
        }
      } else {
        const pol = await q1(conn, 'SELECT * FROM purchase_order_lines WHERE id = ? FOR UPDATE', [l.purchase_line_id]);
        const max = await billableQty(conn, pol, inv.id);
        if (qty > max) {
          throw new BusinessError(`Bill ${l.sku} = ${qty} unit melebihi accepted quantity yang belum ditagih (${max}); kuantitas ditolak (${pol.qty_rejected}) tidak diakui sebagai utang (SR-06).`, {
            rule: 'SR-06', detail: { sku: l.sku, requested: qty, ordered: pol.qty, accepted: pol.qty_received, rejected: pol.qty_rejected, billed: pol.qty_billed, billable: max },
          });
        }
      }
      if (qty === 0) {
        await q(conn, 'DELETE FROM invoice_lines WHERE id = ?', [l.id]);
      } else {
        const a = computeLine({ unitPrice: l.unit_price, qty, discountPct: l.discount_pct, taxRatePct: l.rate_pct });
        await q(conn, 'UPDATE invoice_lines SET qty = ?, subtotal = ?, tax_amount = ?, total = ? WHERE id = ?', [qty, a.subtotal, a.tax, a.total, l.id]);
      }
      changes.push(`${l.sku} ${l.qty} → ${qty}`);
    }
    const left = await q1(conn, 'SELECT COUNT(*) c FROM invoice_lines WHERE invoice_id = ?', [inv.id]);
    if (!left.c) throw new BusinessError('Dokumen harus memiliki minimal satu baris.', { rule: 'SR-02' });
    const t = await recomputeDraft(conn, inv.id);
    if (changes.length) {
      await audit.log(conn, ctx, { action: 'INVOICE_UPDATE', docType: 'account.move', docId: inv.id, message: `Kuantitas: ${changes.join(', ')}; total ${rp(t.g)}` });
      await audit.note(conn, ctx, 'account.move', inv.id, `Kuantitas diubah: ${changes.join(', ')}. Total ${rp(t.g)}.`);
    }
    return inv.id;
  });
}

async function _postInvoice(conn, ctx, invoiceId) {
  const inv = await loadInvoice(conn, invoiceId, true);
  if (inv.state !== 'draft') {
    throw new BusinessError(`${inv.number || TYPE_LABEL[inv.move_type]} sudah ${inv.state === 'posted' ? 'Posted' : inv.state}; permintaan Post kedua atas peristiwa yang sama ditolak (SR-12).`, {
      rule: 'SR-12', docNumber: inv.number,
    });
  }
  if (!inv.lines.length) throw new BusinessError('Dokumen tanpa baris tidak dapat diposting.', { rule: 'SR-12' });
  const partner = await q1(conn, 'SELECT * FROM partners WHERE id = ?', [inv.partner_id]);
  const date = todayStr();
  const term = await q1(conn, 'SELECT due_days FROM payment_terms WHERE code = ?', [inv.payment_term_code]);
  const number = await nextNumber(conn, SEQ[inv.move_type]);
  let journalLines;
  let journal;
  if (inv.move_type === 'out_invoice') {
    for (const l of inv.lines) {
      const sol = await q1(conn, 'SELECT * FROM sale_order_lines WHERE id = ? FOR UPDATE', [l.sale_line_id]);
      const max = await invoiceableQty(conn, sol, inv.id);
      if (l.qty > max) {
        throw new BusinessError(`${l.sku}: ${l.qty} melebihi kuantitas Done yang belum ditagih (${max}) (SR-02).`, { rule: 'SR-02', docNumber: number });
      }
      await q(conn, 'UPDATE sale_order_lines SET qty_invoiced = qty_invoiced + ? WHERE id = ?', [l.qty, l.sale_line_id]);
    }
    journal = 'INV';
    journalLines = [
      { account: '110', partnerId: partner.id, label: `AR ${partner.code} ${number}`, debit: inv.amount_total },
      { account: '401', label: `Sales revenue ${number}`, credit: inv.amount_untaxed },
      { account: '202', label: `PBJT 10% ${number}`, credit: inv.amount_tax },
    ];
  } else if (inv.move_type === 'in_invoice') {
    for (const l of inv.lines) {
      const pol = await q1(conn, 'SELECT * FROM purchase_order_lines WHERE id = ? FOR UPDATE', [l.purchase_line_id]);
      const max = await billableQty(conn, pol, inv.id);
      if (l.qty > max) {
        throw new BusinessError(`${l.sku}: Bill ${l.qty} melebihi accepted quantity yang belum ditagih (${max}) (SR-06).`, { rule: 'SR-06', docNumber: number });
      }
      await q(conn, 'UPDATE purchase_order_lines SET qty_billed = qty_billed + ? WHERE id = ?', [l.qty, l.purchase_line_id]);
    }
    journal = 'BILL';
    journalLines = [
      { account: '125', label: `GRNI cleared ${number}`, debit: inv.amount_untaxed },
      { account: '201', partnerId: partner.id, label: `AP ${partner.code} ${number}`, credit: inv.amount_total },
    ];
    if (inv.amount_tax) journalLines.push({ account: '202', label: 'Pajak masukan', debit: inv.amount_tax });
  } else {
    for (const l of inv.lines) {
      await q(conn, 'UPDATE sale_order_lines SET qty_credited = qty_credited + ? WHERE id = ?', [l.qty, l.sale_line_id]);
    }
    journal = 'RINV';
    journalLines = [
      { account: '402', label: `Sales returns ${number}`, debit: inv.amount_untaxed },
      { account: '202', label: `Pembalikan PBJT ${number}`, debit: inv.amount_tax },
      { account: '110', partnerId: partner.id, label: `AR ${partner.code} ${number}`, credit: inv.amount_total },
    ];
  }
  const entry = await postEntry(conn, ctx, {
    journal, number, date, ref: `${TYPE_LABEL[inv.move_type]} ${number}`, sourceType: 'account.move', sourceId: inv.id,
    eventKey: `invoice:${inv.id}:post`, lines: journalLines,
  });
  const now = nowStr();
  await q(conn, `UPDATE invoices SET number = ?, state = 'posted', invoice_date = ?, due_date = ?, amount_residual = amount_total, journal_entry_id = ?, posted_by = ?, posted_at = ? WHERE id = ?`,
    [number, date, addDays(date, term ? term.due_days : 0), entry.id, ctx.user.id, now, inv.id]);
  let applied = 0;
  if (inv.move_type === 'out_refund' && inv.origin_invoice_id) {
    // Credit note mengurangi saldo invoice asal (AR adjustment).
    const origin = await q1(conn, 'SELECT * FROM invoices WHERE id = ? FOR UPDATE', [inv.origin_invoice_id]);
    applied = Math.min(origin.amount_residual, inv.amount_total);
    if (applied > 0) {
      await applyToInvoice(conn, origin, applied);
      await q(conn, 'UPDATE invoices SET amount_residual = amount_residual - ? WHERE id = ?', [applied, inv.id]);
      await q(conn, "INSERT INTO reconciliations (invoice_id, source_type, source_id, amount, created_at) VALUES (?, 'credit_note', ?, ?, ?)", [origin.id, inv.id, applied, now]);
      await refreshPaymentState(conn, inv.id);
      await audit.note(conn, ctx, 'account.move', origin.id, `Credit Note ${number} diterapkan ${rp(applied)}; sisa ${rp(origin.amount_residual - applied)}.`);
    }
  }
  const docNumber = number;
  await audit.log(conn, ctx, {
    action: 'INVOICE_POST', docType: 'account.move', docId: inv.id, docNumber,
    message: `${TYPE_LABEL[inv.move_type]} Posted: subtotal ${rp(inv.amount_untaxed)}, pajak ${rp(inv.amount_tax)}, total ${rp(inv.amount_total)}${applied ? `; diterapkan ${rp(applied)}` : ''}`,
    detail: { journal: entry.number },
  });
  await audit.note(conn, ctx, 'account.move', inv.id, `Posted sebagai ${number}. Jurnal seimbang ${rp(entry.total)}.`);
  if (inv.sale_order_id) await audit.note(conn, ctx, 'sale.order', inv.sale_order_id, `${number} Posted (${rp(inv.amount_total)}).`);
  if (inv.purchase_order_id) await audit.note(conn, ctx, 'purchase.order', inv.purchase_order_id, `${number} Posted (${rp(inv.amount_total)}).`);
  return { id: inv.id, number, entry };
}

async function postInvoice(ctx, invoiceId) {
  return run(ctx, { action: 'INVOICE_POST', docType: 'account.move', docId: invoiceId }, async (conn) => {
    const inv = await q1(conn, 'SELECT move_type, number FROM invoices WHERE id = ?', [invoiceId]);
    if (!inv) throw new NotFoundError('Dokumen tidak ditemukan');
    requirePerm(ctx, inv.move_type === 'in_invoice' ? 'accounting.edit' : 'invoicing.edit', inv.number);
    return _postInvoice(conn, ctx, invoiceId);
  });
}

async function applyToInvoice(conn, invoice, amount) {
  await q(conn, 'UPDATE invoices SET amount_residual = amount_residual - ? WHERE id = ?', [amount, invoice.id]);
  await refreshPaymentState(conn, invoice.id);
}

async function refreshPaymentState(conn, invoiceId) {
  await q(conn, `UPDATE invoices SET payment_state = CASE WHEN amount_residual = 0 THEN 'paid' WHEN amount_residual < amount_total THEN 'partial' ELSE 'not_paid' END WHERE id = ?`, [invoiceId]);
}

// ---------------------------------------------------------------- Vendor Bill (SR-05/SR-06)

async function createBillFromPO(ctx, poId) {
  return run(ctx, { action: 'BILL_CREATE', docType: 'purchase.order', docId: poId }, async (conn) => {
    requirePerm(ctx, 'accounting.edit');
    const po = await q1(conn, 'SELECT * FROM purchase_orders WHERE id = ? FOR UPDATE', [poId]);
    if (!po) throw new NotFoundError('Purchase Order tidak ditemukan');
    if (po.state !== 'purchase') throw new BusinessError(`${po.number} belum dikonfirmasi.`, { rule: 'SR-06', docNumber: po.number });
    const partner = await q1(conn, 'SELECT * FROM partners WHERE id = ?', [po.partner_id]);
    const poLines = await q(conn, 'SELECT l.*, t.rate_pct FROM purchase_order_lines l JOIN taxes t ON t.code = l.tax_code WHERE l.order_id = ? ORDER BY l.seq FOR UPDATE', [poId]);
    const lines = [];
    for (const l of poLines) {
      const qty = await billableQty(conn, l);
      if (qty <= 0) continue;
      const a = computeLine({ unitPrice: l.unit_price, qty, taxRatePct: l.rate_pct });
      lines.push({ productId: l.product_id, purchaseLineId: l.id, qty, unitPrice: l.unit_price, taxCode: l.tax_code, ...a });
    }
    if (!lines.length) {
      throw new BusinessError(`Belum ada accepted quantity yang belum ditagih pada ${po.number}. Vendor Bill hanya untuk barang lolos penerimaan (SR-06).`, { rule: 'SR-06', docNumber: po.number });
    }
    const bill = await insertInvoice(conn, ctx, { moveType: 'in_invoice', partnerId: po.partner_id, purchaseOrderId: po.id, paymentTerm: partner.payment_term_code }, lines);
    await audit.log(conn, ctx, { action: 'BILL_CREATE', docType: 'account.move', docId: bill.id, docNumber: po.number, message: `Draft bill ${rp(bill.totals.g)} dari ${po.number}` });
    await audit.note(conn, ctx, 'account.move', bill.id, `Draft Vendor Bill dibuat dari ${po.number} sebesar accepted quantity.`);
    await audit.note(conn, ctx, 'purchase.order', po.id, `Draft bill dibuat: ${rp(bill.totals.g)}.`);
    return bill.id;
  });
}

// ---------------------------------------------------------------- Credit Note dari retur (SR-10)

async function _createCreditNoteForReturn(conn, ctx, ret) {
  const lines = [];
  let originInvoiceId = null;
  for (const m of ret.moves) {
    if (!m.sale_line_id) continue;
    const sol = await q1(conn, 'SELECT l.*, t.rate_pct FROM sale_order_lines l JOIN taxes t ON t.code = l.tax_code WHERE l.id = ? FOR UPDATE', [m.sale_line_id]);
    const { netDelivered, netInvoiced } = lineQuantities(sol);
    const pending = await q1(conn, `SELECT COALESCE(SUM(il.qty), 0) AS qty FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
      WHERE il.sale_line_id = ? AND i.move_type = 'out_refund' AND i.state = 'draft'`, [sol.id]);
    const creditQty = Math.min(m.qty_demand, netInvoiced - Number(pending.qty) - netDelivered);
    if (creditQty <= 0) continue;
    const a = computeLine({ unitPrice: sol.unit_price, qty: creditQty, discountPct: sol.discount_pct, taxRatePct: sol.rate_pct });
    lines.push({ productId: sol.product_id, saleLineId: sol.id, qty: creditQty, unitPrice: sol.unit_price, discountPct: sol.discount_pct, taxCode: sol.tax_code, ...a });
    if (!originInvoiceId) {
      const origin = await q1(conn, `SELECT i.id FROM invoices i JOIN invoice_lines il ON il.invoice_id = i.id
        WHERE il.sale_line_id = ? AND i.move_type = 'out_invoice' AND i.state = 'posted' ORDER BY i.amount_residual > 0 DESC, i.id DESC LIMIT 1`, [sol.id]);
      originInvoiceId = origin ? origin.id : null;
    }
  }
  if (!lines.length) return null;
  const so = await q1(conn, 'SELECT * FROM sale_orders WHERE id = ?', [ret.sale_order_id]);
  const cn = await insertInvoice(conn, ctx, {
    moveType: 'out_refund', partnerId: ret.partner_id, saleOrderId: ret.sale_order_id, originInvoiceId, returnPickingId: ret.id,
    paymentTerm: so ? so.payment_term_code : 'COD', note: `Retur ${ret.number}`,
  }, lines);
  await audit.note(conn, ctx, 'account.move', cn.id, `Draft Credit Note dibuat dari retur ${ret.number}: ${rp(cn.totals.g)} (harga + PBJT kuantitas sah).`);
  return { id: cn.id, total: cn.totals.g };
}

// ---------------------------------------------------------------- Register Payment (SR-20)

async function _registerPayment(conn, ctx, invoiceId, { amount, method = 'bank', date, memo } = {}) {
  const inv = await q1(conn, 'SELECT * FROM invoices WHERE id = ? FOR UPDATE', [invoiceId]);
  if (!inv) throw new NotFoundError('Dokumen tidak ditemukan');
  if (inv.state !== 'posted') throw new BusinessError('Pembayaran hanya untuk dokumen Posted.', { rule: 'SR-20', docNumber: inv.number });
  if (inv.move_type === 'out_refund') throw new BusinessError('Refund tunai atas credit note berada di luar lingkup simulasi.', { rule: 'SR-20', docNumber: inv.number });
  const amt = toInt(amount, 0);
  if (amt <= 0) throw new BusinessError('Jumlah pembayaran harus lebih dari nol.', { rule: 'SR-20', docNumber: inv.number });
  if (!['bank', 'cash'].includes(method)) throw new BusinessError('Metode pembayaran tidak dikenal.', { rule: 'SR-20' });
  if (amt > inv.amount_residual && !policies.ALLOW_OVERPAYMENT) {
    throw new BusinessError(`Pembayaran ${rp(amt)} melebihi sisa tagihan ${inv.number} ${rp(inv.amount_residual)}. Overpayment tidak boleh terjadi tanpa pencatatan terpisah (SR-20).`, {
      rule: 'SR-20', docNumber: inv.number, detail: { amount: amt, residual: inv.amount_residual, excess: amt - inv.amount_residual },
    });
  }
  const partner = await q1(conn, 'SELECT * FROM partners WHERE id = ?', [inv.partner_id]);
  const journal = method === 'cash' ? 'CSH' : 'BNK';
  const cashAccount = method === 'cash' ? '101' : '102';
  const number = await nextNumber(conn, `journal.${journal}`);
  const inbound = inv.move_type === 'out_invoice';
  const lines = inbound
    ? [{ account: cashAccount, label: `Penerimaan ${inv.number}`, debit: amt }, { account: '110', partnerId: partner.id, label: `Pelunasan AR ${inv.number}`, credit: amt }]
    : [{ account: '201', partnerId: partner.id, label: `Pembayaran AP ${inv.number}`, debit: amt }, { account: cashAccount, label: `Pembayaran ${inv.number}`, credit: amt }];
  const entry = await postEntry(conn, ctx, {
    journal, number, date: date || todayStr(), ref: `${inbound ? 'Customer' : 'Vendor'} Payment ${inv.number}`, sourceType: 'account.payment', sourceId: null,
    eventKey: `payment:${number}`, lines,
  });
  const now = nowStr();
  const [r] = await conn.query(`INSERT INTO payments (number, payment_type, partner_id, invoice_id, amount, method, payment_date, state, journal_entry_id, memo, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?)`,
  [number, inbound ? 'inbound' : 'outbound', partner.id, inv.id, amt, method, date || todayStr(), entry.id, memo || null, ctx.user.id, now]);
  await q(conn, 'UPDATE journal_entries SET source_id = ? WHERE id = ?', [r.insertId, entry.id]);
  await applyToInvoice(conn, inv, amt);
  await q(conn, "INSERT INTO reconciliations (invoice_id, source_type, source_id, amount, created_at) VALUES (?, 'payment', ?, ?, ?)", [inv.id, r.insertId, amt, now]);
  const residual = inv.amount_residual - amt;
  await audit.log(conn, ctx, {
    action: 'PAYMENT_POST', docType: 'account.payment', docId: r.insertId, docNumber: number,
    message: `${inbound ? 'Customer' : 'Vendor'} payment ${rp(amt)} (${method}) untuk ${inv.number}; sisa ${rp(residual)}`, detail: { invoice: inv.number },
  });
  await audit.note(conn, ctx, 'account.move', inv.id, `Pembayaran ${number} ${rp(amt)} via ${method}. Sisa ${rp(residual)}.`);
  if (inv.sale_order_id) await audit.note(conn, ctx, 'sale.order', inv.sale_order_id, `Pembayaran ${number} ${rp(amt)} atas ${inv.number}.`);
  return { id: r.insertId, number, residual };
}

async function registerPayment(ctx, invoiceId, data) {
  return run(ctx, { action: 'PAYMENT_POST', docType: 'account.move', docId: invoiceId }, async (conn) => {
    requirePerm(ctx, 'accounting.edit');
    return _registerPayment(conn, ctx, invoiceId, data);
  });
}

async function listPayments() {
  return q(getPool(), `SELECT pay.*, p.code AS partner_code, p.name AS partner_name, i.number AS invoice_number, i.move_type, u.username AS created_by_name
    FROM payments pay JOIN partners p ON p.id = pay.partner_id JOIN invoices i ON i.id = pay.invoice_id
    LEFT JOIN users u ON u.id = pay.created_by ORDER BY pay.id DESC`);
}

module.exports = {
  TYPE_LABEL, listInvoices, loadInvoice, getInvoice, invoiceableQty, billableQty,
  _createFromSale, createInvoiceFromSale, updateDraftQuantities, _postInvoice, postInvoice,
  createBillFromPO, _createCreditNoteForReturn, _registerPayment, registerPayment, listPayments,
};
