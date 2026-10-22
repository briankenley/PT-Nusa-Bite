'use strict';
const { q, q1, getPool } = require('../db');
const { run } = require('../lib/action');
const { requirePerm } = require('../lib/acl');
const { BusinessError, NotFoundError } = require('../lib/errors');
const { nextNumber } = require('../lib/sequence');
const { nowStr, todayStr } = require('../lib/time');
const { rp, toInt } = require('../lib/money');
const audit = require('../lib/audit');
const { postEntry } = require('./accounting');
const { locationByCode } = require('./common');

const SEQ = { out: 'stock.out', in: 'stock.in', int: 'stock.int', ret: 'stock.return' };
const TYPE_LABEL = { out: 'Delivery Order', in: 'Receipt', int: 'Internal Transfer', ret: 'Return' };

/** Ambil quant dan kunci barisnya (FOR UPDATE) agar reservasi tidak balapan antar transaksi. */
async function lockQuant(conn, productId, locationId) {
  let qt = await q1(conn, 'SELECT * FROM stock_quants WHERE product_id = ? AND location_id = ? FOR UPDATE', [productId, locationId]);
  if (!qt) {
    await q(conn, 'INSERT INTO stock_quants (product_id, location_id, on_hand, reserved) VALUES (?, ?, 0, 0)', [productId, locationId]);
    qt = await q1(conn, 'SELECT * FROM stock_quants WHERE product_id = ? AND location_id = ? FOR UPDATE', [productId, locationId]);
  }
  return qt;
}

async function describe(conn, productId, locationId) {
  return q1(conn, 'SELECT p.sku, l.code AS loc FROM products p, locations l WHERE p.id = ? AND l.id = ?', [productId, locationId]);
}

/**
 * Reservasi stok (SR-04): hanya boleh memakai Available = On Hand − Reserved di lokasi yang sama.
 * Reservasi milik dokumen lain tidak pernah dipakai.
 */
async function reserve(conn, { productId, locationId, qty, docNumber }) {
  const qt = await lockQuant(conn, productId, locationId);
  const available = qt.on_hand - qt.reserved;
  if (qty > available) {
    const d = await describe(conn, productId, locationId);
    throw new BusinessError(
      `Stok tidak cukup untuk ${d.sku} di ${d.loc}: On Hand ${qt.on_hand}, Reserved ${qt.reserved}, Available ${available}, diminta ${qty}. `
      + 'Available tidak boleh negatif dan reservasi dokumen lain tidak boleh dipakai (SR-04).',
      { rule: 'SR-04', docNumber, detail: { sku: d.sku, location: d.loc, on_hand: qt.on_hand, reserved: qt.reserved, available, requested: qty } },
    );
  }
  await q(conn, 'UPDATE stock_quants SET reserved = reserved + ? WHERE id = ?', [qty, qt.id]);
}

async function unreserve(conn, productId, locationId, qty) {
  if (qty <= 0) return;
  const qt = await lockQuant(conn, productId, locationId);
  await q(conn, 'UPDATE stock_quants SET reserved = ? WHERE id = ?', [Math.max(0, qt.reserved - qty), qt.id]);
}

async function createPicking(conn, ctx, p) {
  const number = await nextNumber(conn, SEQ[p.type]);
  const now = nowStr();
  const [r] = await conn.query(`INSERT INTO pickings (number, picking_type, state, partner_id, src_location_id, dest_location_id, sale_order_id,
      purchase_order_id, return_of_id, backorder_of_id, scheduled_date, note, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [number, p.type, p.state || 'draft', p.partnerId || null, p.srcId, p.destId, p.saleOrderId || null, p.purchaseOrderId || null,
    p.returnOfId || null, p.backorderOfId || null, todayStr(), p.note || null, ctx.user ? ctx.user.id : null, now]);
  for (const m of p.moves) {
    await q(conn, `INSERT INTO stock_moves (picking_id, product_id, src_location_id, dest_location_id, qty_demand, qty_reserved, qty_sellable, qty_damaged,
        unit_cost, state, sale_line_id, purchase_line_id, origin_move_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [r.insertId, m.productId, p.srcId, p.destId, m.qty, m.reserved || 0, m.sellable || 0, m.damaged || 0, m.unitCost || 0,
      p.state === 'ready' ? 'ready' : 'draft', m.saleLineId || null, m.purchaseLineId || null, m.originMoveId || null, now]);
  }
  return { id: r.insertId, number };
}

async function loadPicking(conn, id, lock = false) {
  const pk = await q1(conn, `SELECT * FROM pickings WHERE id = ? ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!pk) throw new NotFoundError('Dokumen gudang tidak ditemukan');
  pk.moves = await q(conn, `SELECT m.*, p.sku, p.name AS product_name, p.uom, p.standard_cost FROM stock_moves m
    JOIN products p ON p.id = m.product_id WHERE m.picking_id = ? ORDER BY m.id ${lock ? 'FOR UPDATE' : ''}`, [id]);
  return pk;
}

async function listPickings({ type } = {}) {
  const params = [];
  let cond = '';
  if (type) { cond = 'WHERE pk.picking_type = ?'; params.push(type); }
  return q(getPool(), `SELECT pk.*, pr.code AS partner_code, pr.name AS partner_name, s.code AS src_code, d.code AS dest_code,
      so.number AS so_number, po.number AS po_number, rt.number AS return_of_number, bo.number AS backorder_of_number,
      (SELECT COALESCE(SUM(m.qty_demand), 0) FROM stock_moves m WHERE m.picking_id = pk.id) AS qty_total
    FROM pickings pk LEFT JOIN partners pr ON pr.id = pk.partner_id
    JOIN locations s ON s.id = pk.src_location_id JOIN locations d ON d.id = pk.dest_location_id
    LEFT JOIN sale_orders so ON so.id = pk.sale_order_id LEFT JOIN purchase_orders po ON po.id = pk.purchase_order_id
    LEFT JOIN pickings rt ON rt.id = pk.return_of_id LEFT JOIN pickings bo ON bo.id = pk.backorder_of_id
    ${cond} ORDER BY pk.id DESC`, params);
}

async function getPicking(id) {
  const pool = getPool();
  const pk = await loadPicking(pool, id);
  const extra = await q1(pool, `SELECT pr.code AS partner_code, pr.name AS partner_name, s.code AS src_code, s.name AS src_name,
      d.code AS dest_code, d.name AS dest_name, so.number AS so_number, po.number AS po_number, rt.number AS return_of_number,
      bo.number AS backorder_of_number, u.username AS done_by_name
    FROM pickings pk LEFT JOIN partners pr ON pr.id = pk.partner_id
    JOIN locations s ON s.id = pk.src_location_id JOIN locations d ON d.id = pk.dest_location_id
    LEFT JOIN sale_orders so ON so.id = pk.sale_order_id LEFT JOIN purchase_orders po ON po.id = pk.purchase_order_id
    LEFT JOIN pickings rt ON rt.id = pk.return_of_id LEFT JOIN pickings bo ON bo.id = pk.backorder_of_id
    LEFT JOIN users u ON u.id = pk.done_by WHERE pk.id = ?`, [id]);
  Object.assign(pk, extra);
  pk.type_label = TYPE_LABEL[pk.picking_type];
  pk.backorders = await q(pool, 'SELECT id, number, state FROM pickings WHERE backorder_of_id = ?', [id]);
  pk.returns = await q(pool, 'SELECT id, number, state FROM pickings WHERE return_of_id = ?', [id]);
  pk.entries = await q(pool, "SELECT id, number, total_debit FROM journal_entries WHERE source_type = 'stock.picking' AND source_id = ?", [id]);
  pk.credit_notes = await q(pool, "SELECT id, number, state, amount_total FROM invoices WHERE return_picking_id = ?", [id]);
  if (pk.picking_type === 'in') {
    for (const m of pk.moves) {
      const pol = m.purchase_line_id ? await q1(pool, 'SELECT unit_price, qty, qty_received, qty_rejected FROM purchase_order_lines WHERE id = ?', [m.purchase_line_id]) : null;
      m.po_price = pol ? pol.unit_price : m.unit_cost;
    }
  }
  if (pk.picking_type === 'out' && pk.state === 'done') {
    for (const m of pk.moves) m.returnable = m.qty_done - (await returnedQty(pool, m.id));
  }
  return pk;
}

async function returnedQty(conn, originMoveId, excludePickingId = 0) {
  const r = await q1(conn, `SELECT COALESCE(SUM(m.qty_demand), 0) AS qty FROM stock_moves m JOIN pickings pk ON pk.id = m.picking_id
    WHERE m.origin_move_id = ? AND pk.picking_type = 'ret' AND pk.state <> 'cancel' AND pk.id <> ?`, [originMoveId, excludePickingId]);
  return Number(r.qty);
}

/**
 * Validasi Delivery Order. Hanya unit yang benar-benar dikirim yang menjadi Done (SR-02),
 * sisanya menjadi backorder yang tetap tereservasi. COGS diakui saat stok keluar (standard cost).
 */
async function _validateDelivery(conn, ctx, pickingId, { done = null, backorder = true } = {}) {
  const pk = await loadPicking(conn, pickingId, true);
  if (pk.picking_type !== 'out') throw new BusinessError('Dokumen ini bukan Delivery Order.', { rule: 'SR-02' });
  if (pk.state === 'done') throw new BusinessError(`${pk.number} sudah Done; validasi kedua ditolak (SR-12).`, { rule: 'SR-12', docNumber: pk.number });
  if (pk.state !== 'ready') throw new BusinessError(`${pk.number} berstatus ${pk.state}, tidak dapat divalidasi.`, { rule: 'SR-04', docNumber: pk.number });
  const so = pk.sale_order_id ? await q1(conn, 'SELECT * FROM sale_orders WHERE id = ?', [pk.sale_order_id]) : null;
  const now = nowStr();
  const plan = [];
  for (const m of pk.moves) {
    const want = done && done[m.id] !== undefined ? toInt(done[m.id], -1) : m.qty_demand;
    if (!Number.isInteger(want) || want < 0) throw new BusinessError(`Kuantitas Done ${m.sku} tidak valid.`, { rule: 'SR-02', docNumber: pk.number });
    if (want > m.qty_reserved) {
      throw new BusinessError(`Kuantitas Done ${m.sku} (${want}) melebihi kuantitas tereservasi/permintaan (${m.qty_reserved}) (SR-04).`, {
        rule: 'SR-04', docNumber: pk.number, detail: { sku: m.sku, done: want, reserved: m.qty_reserved },
      });
    }
    plan.push({ m, qty: want });
  }
  const totalDone = plan.reduce((s, p) => s + p.qty, 0);
  if (totalDone <= 0) throw new BusinessError('Isi kuantitas Done minimal satu unit.', { rule: 'SR-02', docNumber: pk.number });

  let backorderPick = null;
  const cogsLines = [];
  let cogsTotal = 0;
  for (const { m, qty } of plan) {
    const remaining = m.qty_demand - qty;
    if (qty > 0) {
      const qt = await lockQuant(conn, m.product_id, m.src_location_id);
      await q(conn, 'UPDATE stock_quants SET on_hand = on_hand - ?, reserved = reserved - ? WHERE id = ?', [qty, qty, qt.id]);
      const value = qty * m.standard_cost;
      await q(conn, `UPDATE stock_moves SET qty_demand = ?, qty_done = ?, qty_reserved = 0, unit_cost = ?, value = ?, state = 'done', done_at = ? WHERE id = ?`,
        [qty, qty, m.standard_cost, value, now, m.id]);
      if (m.sale_line_id) await q(conn, 'UPDATE sale_order_lines SET qty_delivered = qty_delivered + ? WHERE id = ?', [qty, m.sale_line_id]);
      cogsTotal += value;
      cogsLines.push({ account: '501', label: `COGS ${m.sku} × ${qty}`, debit: value });
      cogsLines.push({ account: '120', label: `Inventory ${m.sku} × ${qty}`, credit: value });
    }
    if (remaining > 0) {
      if (backorder) {
        if (!backorderPick) {
          backorderPick = await createPicking(conn, ctx, {
            type: 'out', state: 'ready', partnerId: pk.partner_id, srcId: pk.src_location_id, destId: pk.dest_location_id,
            saleOrderId: pk.sale_order_id, backorderOfId: pk.id, moves: [],
          });
        }
        if (qty > 0) {
          await q(conn, `INSERT INTO stock_moves (picking_id, product_id, src_location_id, dest_location_id, qty_demand, qty_reserved, unit_cost, state, sale_line_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`, [backorderPick.id, m.product_id, m.src_location_id, m.dest_location_id, remaining, remaining, m.standard_cost, m.sale_line_id, now]);
        } else {
          await q(conn, 'UPDATE stock_moves SET picking_id = ? WHERE id = ?', [backorderPick.id, m.id]);
        }
      } else {
        await unreserve(conn, m.product_id, m.src_location_id, remaining);
        if (qty === 0) await q(conn, "UPDATE stock_moves SET state = 'cancel', qty_reserved = 0 WHERE id = ?", [m.id]);
        if (m.sale_line_id) await q(conn, 'UPDATE sale_order_lines SET qty_cancelled = qty_cancelled + ? WHERE id = ?', [remaining, m.sale_line_id]);
      }
    }
  }
  await q(conn, "UPDATE pickings SET state = 'done', done_by = ?, done_at = ? WHERE id = ?", [ctx.user.id, now, pk.id]);
  const entry = await postEntry(conn, ctx, {
    journal: 'STJ', ref: `${pk.number}${so ? ` (${so.number})` : ''} — COGS standard cost`, sourceType: 'stock.picking', sourceId: pk.id,
    eventKey: `picking:${pk.id}:done`, lines: cogsLines,
  });
  const summary = plan.filter((p) => p.qty > 0).map((p) => `${p.m.sku} ${p.qty}`).join(', ');
  await audit.log(conn, ctx, {
    action: 'DELIVERY_VALIDATE', docType: 'stock.picking', docId: pk.id, docNumber: pk.number,
    message: `Done: ${summary}; COGS ${rp(cogsTotal)}${backorderPick ? `; backorder ${backorderPick.number}` : ''}`,
    detail: { journal: entry.number, backorder: backorderPick ? backorderPick.number : null },
  });
  await audit.note(conn, ctx, 'stock.picking', pk.id, `Divalidasi (Done): ${summary}. Jurnal ${entry.number} COGS ${rp(cogsTotal)}.${backorderPick ? ` Sisa dibuat backorder ${backorderPick.number}.` : ''}`);
  if (so) await audit.note(conn, ctx, 'sale.order', so.id, `${pk.number} Done: ${summary}.${backorderPick ? ` Backorder ${backorderPick.number}.` : ''}`);
  return { pickingId: pk.id, number: pk.number, backorder: backorderPick, entry, cogsTotal };
}

async function validateDelivery(ctx, pickingId, opts = {}) {
  return run(ctx, { action: 'DELIVERY_VALIDATE', docType: 'stock.picking', docId: pickingId }, async (conn) => {
    requirePerm(ctx, 'inventory.operate');
    return _validateDelivery(conn, ctx, pickingId, opts);
  });
}

/** Batalkan dokumen yang belum Done (misal backorder); reservasi dilepas. */
async function cancelPicking(ctx, pickingId) {
  return run(ctx, { action: 'PICKING_CANCEL', docType: 'stock.picking', docId: pickingId }, async (conn) => {
    requirePerm(ctx, 'inventory.operate');
    const pk = await loadPicking(conn, pickingId, true);
    if (pk.state === 'done' || pk.state === 'cancel') {
      throw new BusinessError(`${pk.number} berstatus ${pk.state} dan tidak dapat dibatalkan.`, { rule: 'SR-12', docNumber: pk.number });
    }
    if (pk.picking_type === 'in' && pk.state === 'qc') {
      throw new BusinessError('Receipt yang sudah melalui Quality Check harus divalidasi atau dikoreksi QC-nya.', { rule: 'SR-19', docNumber: pk.number });
    }
    for (const m of pk.moves) {
      if (m.qty_reserved > 0) await unreserve(conn, m.product_id, m.src_location_id, m.qty_reserved);
      if (pk.picking_type === 'out' && m.sale_line_id) {
        await q(conn, 'UPDATE sale_order_lines SET qty_cancelled = qty_cancelled + ? WHERE id = ?', [m.qty_demand, m.sale_line_id]);
      }
      await q(conn, "UPDATE stock_moves SET state = 'cancel', qty_reserved = 0 WHERE id = ?", [m.id]);
    }
    await q(conn, "UPDATE pickings SET state = 'cancel' WHERE id = ?", [pk.id]);
    await audit.log(conn, ctx, { action: 'PICKING_CANCEL', docType: 'stock.picking', docId: pk.id, docNumber: pk.number, message: `${pk.number} dibatalkan; reservasi dilepas` });
    await audit.note(conn, ctx, 'stock.picking', pk.id, 'Dibatalkan; reservasi dilepas.');
    return pk.id;
  });
}

// ---------------------------------------------------------------- Internal Transfer (SR-11)

async function createTransfer(ctx, { srcCode, destCode, lines, note }) {
  return run(ctx, { action: 'TRANSFER_CREATE', docType: 'stock.picking' }, async (conn) => {
    requirePerm(ctx, 'inventory.operate');
    const src = await locationByCode(conn, srcCode);
    const dest = await locationByCode(conn, destCode);
    if (src.usage_type !== 'internal' || dest.usage_type !== 'internal') throw new BusinessError('Internal Transfer hanya antar lokasi internal.', { rule: 'SR-11' });
    if (src.id === dest.id) throw new BusinessError('Lokasi asal dan tujuan tidak boleh sama.', { rule: 'SR-11' });
    const moves = [];
    for (const l of lines || []) {
      const qty = toInt(l.qty, 0);
      if (!l.productId || qty === 0) continue;
      if (qty < 0) throw new BusinessError('Kuantitas transfer harus positif.', { rule: 'SR-11' });
      const p = await q1(conn, 'SELECT * FROM products WHERE id = ?', [l.productId]);
      if (!p) throw new NotFoundError('Produk tidak ditemukan');
      moves.push({ productId: p.id, qty, unitCost: p.standard_cost });
    }
    if (!moves.length) throw new BusinessError('Isi minimal satu baris produk.', { rule: 'SR-11' });
    const pk = await createPicking(conn, ctx, { type: 'int', state: 'draft', srcId: src.id, destId: dest.id, moves, note });
    await audit.log(conn, ctx, { action: 'TRANSFER_CREATE', docType: 'stock.picking', docId: pk.id, docNumber: pk.number, message: `${src.code} → ${dest.code}` });
    await audit.note(conn, ctx, 'stock.picking', pk.id, `Internal Transfer dibuat ${src.code} → ${dest.code}.`);
    return pk.id;
  });
}

async function confirmTransfer(ctx, pickingId) {
  return run(ctx, { action: 'TRANSFER_CONFIRM', docType: 'stock.picking', docId: pickingId }, async (conn) => {
    requirePerm(ctx, 'inventory.operate');
    const pk = await loadPicking(conn, pickingId, true);
    if (pk.picking_type !== 'int') throw new BusinessError('Bukan Internal Transfer.', { rule: 'SR-11' });
    if (pk.state !== 'draft') throw new BusinessError(`${pk.number} sudah ${pk.state}.`, { rule: 'SR-12', docNumber: pk.number });
    for (const m of pk.moves) {
      await reserve(conn, { productId: m.product_id, locationId: pk.src_location_id, qty: m.qty_demand, docNumber: pk.number });
      await q(conn, "UPDATE stock_moves SET qty_reserved = qty_demand, state = 'ready' WHERE id = ?", [m.id]);
    }
    await q(conn, "UPDATE pickings SET state = 'ready' WHERE id = ?", [pk.id]);
    await audit.log(conn, ctx, { action: 'TRANSFER_CONFIRM', docType: 'stock.picking', docId: pk.id, docNumber: pk.number, message: 'Stok asal direservasi' });
    await audit.note(conn, ctx, 'stock.picking', pk.id, 'Mark as To Do: stok di lokasi asal direservasi.');
    return pk.id;
  });
}

async function validateTransfer(ctx, pickingId) {
  return run(ctx, { action: 'TRANSFER_VALIDATE', docType: 'stock.picking', docId: pickingId }, async (conn) => {
    requirePerm(ctx, 'inventory.operate');
    const pk = await loadPicking(conn, pickingId, true);
    if (pk.picking_type !== 'int') throw new BusinessError('Bukan Internal Transfer.', { rule: 'SR-11' });
    if (pk.state === 'done') throw new BusinessError(`${pk.number} sudah Done; validasi kedua ditolak (SR-12).`, { rule: 'SR-12', docNumber: pk.number });
    if (pk.state !== 'ready') throw new BusinessError(`Klik "Mark as To Do" dahulu agar stok asal direservasi (SR-04).`, { rule: 'SR-04', docNumber: pk.number });
    const now = nowStr();
    const parts = [];
    for (const m of pk.moves) {
      const srcQ = await lockQuant(conn, m.product_id, pk.src_location_id);
      const destQ = await lockQuant(conn, m.product_id, pk.dest_location_id);
      await q(conn, 'UPDATE stock_quants SET on_hand = on_hand - ?, reserved = reserved - ? WHERE id = ?', [m.qty_demand, m.qty_reserved, srcQ.id]);
      await q(conn, 'UPDATE stock_quants SET on_hand = on_hand + ? WHERE id = ?', [m.qty_demand, destQ.id]);
      await q(conn, "UPDATE stock_moves SET qty_done = qty_demand, qty_reserved = 0, value = qty_demand * ?, unit_cost = ?, state = 'done', done_at = ? WHERE id = ?",
        [m.standard_cost, m.standard_cost, now, m.id]);
      parts.push(`${m.sku} ${m.qty_demand}`);
    }
    await q(conn, "UPDATE pickings SET state = 'done', done_by = ?, done_at = ? WHERE id = ?", [ctx.user.id, now, pk.id]);
    await audit.log(conn, ctx, { action: 'TRANSFER_VALIDATE', docType: 'stock.picking', docId: pk.id, docNumber: pk.number, message: `Done: ${parts.join(', ')}; tanpa jurnal (nilai stok perusahaan tetap)` });
    await audit.note(conn, ctx, 'stock.picking', pk.id, `Done: ${parts.join(', ')}. Tidak ada jurnal karena jumlah dan nilai stok perusahaan tidak berubah (SR-11).`);
    return pk.id;
  });
}

// ---------------------------------------------------------------- Receipt + Quality Check (SR-19)

async function saveQualityCheck(ctx, pickingId, input) {
  return run(ctx, { action: 'RECEIPT_QC', docType: 'stock.picking', docId: pickingId }, async (conn) => {
    requirePerm(ctx, 'inventory.operate');
    const pk = await loadPicking(conn, pickingId, true);
    if (pk.picking_type !== 'in') throw new BusinessError('Bukan Receipt.', { rule: 'SR-19' });
    if (pk.state === 'done') {
      throw new BusinessError(`${pk.number} sudah Done; kuantitas received/accepted/rejected terkunci dan stok tidak dapat ditambah ulang (SR-19, SR-12).`, { rule: 'SR-19', docNumber: pk.number });
    }
    if (pk.state === 'cancel') throw new BusinessError(`${pk.number} dibatalkan.`, { rule: 'SR-19', docNumber: pk.number });
    let anyReceived = 0;
    const parts = [];
    for (const m of pk.moves) {
      const v = input[m.id] || {};
      const received = toInt(v.received, 0);
      const accepted = toInt(v.accepted, 0);
      const rejected = toInt(v.rejected, 0);
      if ([received, accepted, rejected].some((n) => n < 0)) throw new BusinessError('Kuantitas tidak boleh negatif.', { rule: 'SR-19', docNumber: pk.number });
      if (accepted + rejected !== received) {
        throw new BusinessError(`${m.sku}: Accepted (${accepted}) + Rejected (${rejected}) = ${accepted + rejected} ≠ Received (${received}). Hanya accepted yang menambah stok; unit rejected tidak boleh ikut dihitung (SR-19).`, {
          rule: 'SR-19', docNumber: pk.number, detail: { sku: m.sku, received, accepted, rejected },
        });
      }
      if (received > m.qty_demand) {
        throw new BusinessError(`${m.sku}: Received (${received}) melebihi sisa kuantitas PO (${m.qty_demand}) (SR-19).`, { rule: 'SR-19', docNumber: pk.number });
      }
      await q(conn, 'UPDATE stock_moves SET qty_received = ?, qty_accepted = ?, qty_rejected = ? WHERE id = ?', [received, accepted, rejected, m.id]);
      anyReceived += received;
      parts.push(`${m.sku} received ${received} / accepted ${accepted} / rejected ${rejected}`);
    }
    if (anyReceived <= 0) throw new BusinessError('Isi kuantitas Received minimal satu unit.', { rule: 'SR-19', docNumber: pk.number });
    await q(conn, "UPDATE pickings SET state = 'qc' WHERE id = ?", [pk.id]);
    await audit.log(conn, ctx, { action: 'RECEIPT_QC', docType: 'stock.picking', docId: pk.id, docNumber: pk.number, message: parts.join('; ') });
    await audit.note(conn, ctx, 'stock.picking', pk.id, `Quality Check: ${parts.join('; ')}.`);
    return pk.id;
  });
}

async function validateReceipt(ctx, pickingId) {
  return run(ctx, { action: 'RECEIPT_VALIDATE', docType: 'stock.picking', docId: pickingId }, async (conn) => {
    requirePerm(ctx, 'inventory.operate');
    const pk = await loadPicking(conn, pickingId, true);
    if (pk.picking_type !== 'in') throw new BusinessError('Bukan Receipt.', { rule: 'SR-19' });
    if (pk.state === 'done') throw new BusinessError(`${pk.number} sudah Done; validasi kedua ditolak (SR-12).`, { rule: 'SR-12', docNumber: pk.number });
    if (pk.state !== 'qc') throw new BusinessError('Lakukan Quality Check (received / accepted / rejected) sebelum validasi (SR-19).', { rule: 'SR-19', docNumber: pk.number });
    const po = await q1(conn, 'SELECT * FROM purchase_orders WHERE id = ?', [pk.purchase_order_id]);
    const rejectLoc = await locationByCode(conn, 'QC-REJECT');
    const now = nowStr();
    const lines = [];
    let valueTotal = 0;
    let backorderPick = null;
    const parts = [];
    for (const m of pk.moves) {
      const pol = await q1(conn, 'SELECT * FROM purchase_order_lines WHERE id = ? FOR UPDATE', [m.purchase_line_id]);
      const accepted = m.qty_accepted;
      const rejected = m.qty_rejected;
      const notArrived = m.qty_demand - m.qty_received;
      if (accepted > 0) {
        const qt = await lockQuant(conn, m.product_id, pk.dest_location_id);
        await q(conn, 'UPDATE stock_quants SET on_hand = on_hand + ? WHERE id = ?', [accepted, qt.id]);
        const stdValue = accepted * m.standard_cost;
        const poValue = accepted * pol.unit_price;
        valueTotal += stdValue;
        lines.push({ account: '120', label: `Inventory ${m.sku} × ${accepted} @ standard cost`, debit: stdValue });
        lines.push({ account: '125', label: `GRNI ${m.sku} × ${accepted} @ ${rp(pol.unit_price)}`, credit: poValue });
        if (poValue > stdValue) lines.push({ account: '701', label: `Purchase price variance ${m.sku}`, debit: poValue - stdValue });
        if (stdValue > poValue) lines.push({ account: '701', label: `Purchase price variance ${m.sku}`, credit: stdValue - poValue });
      }
      if (rejected > 0) {
        // Jejak barang ditolak: tidak masuk stok dan tidak menjadi kewajiban pembelian.
        await q(conn, `INSERT INTO stock_moves (picking_id, product_id, src_location_id, dest_location_id, qty_demand, qty_done, unit_cost, value, state, purchase_line_id, ref, created_at, done_at)
          VALUES (NULL, ?, ?, ?, ?, ?, 0, 0, 'done', ?, ?, ?, ?)`,
        [m.product_id, pk.src_location_id, rejectLoc.id, rejected, rejected, m.purchase_line_id, `QC rejected ${pk.number}`, now, now]);
      }
      await q(conn, "UPDATE stock_moves SET qty_demand = qty_received, qty_done = qty_accepted, unit_cost = ?, value = qty_accepted * ?, state = 'done', done_at = ? WHERE id = ?",
        [m.standard_cost, m.standard_cost, now, m.id]);
      await q(conn, 'UPDATE purchase_order_lines SET qty_received = qty_received + ?, qty_rejected = qty_rejected + ? WHERE id = ?', [accepted, rejected, pol.id]);
      if (notArrived > 0) {
        if (!backorderPick) {
          backorderPick = await createPicking(conn, ctx, {
            type: 'in', state: 'ready', partnerId: pk.partner_id, srcId: pk.src_location_id, destId: pk.dest_location_id,
            purchaseOrderId: pk.purchase_order_id, backorderOfId: pk.id, moves: [],
          });
        }
        await q(conn, `INSERT INTO stock_moves (picking_id, product_id, src_location_id, dest_location_id, qty_demand, unit_cost, state, purchase_line_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?)`, [backorderPick.id, m.product_id, pk.src_location_id, pk.dest_location_id, notArrived, m.standard_cost, m.purchase_line_id, now]);
      }
      parts.push(`${m.sku} accepted ${accepted}, rejected ${rejected}`);
    }
    await q(conn, "UPDATE pickings SET state = 'done', done_by = ?, done_at = ? WHERE id = ?", [ctx.user.id, now, pk.id]);
    let entry = null;
    if (lines.length) {
      entry = await postEntry(conn, ctx, {
        journal: 'STJ', ref: `${pk.number} (${po ? po.number : ''}) — accepted receipt`, sourceType: 'stock.picking', sourceId: pk.id,
        eventKey: `picking:${pk.id}:done`, lines,
      });
    }
    await audit.log(conn, ctx, {
      action: 'RECEIPT_VALIDATE', docType: 'stock.picking', docId: pk.id, docNumber: pk.number,
      message: `${parts.join('; ')}; valuasi +${rp(valueTotal)}`, detail: { journal: entry ? entry.number : null, backorder: backorderPick ? backorderPick.number : null },
    });
    await audit.note(conn, ctx, 'stock.picking', pk.id, `Done: ${parts.join('; ')}. Stok bertambah hanya sebesar accepted; valuasi +${rp(valueTotal)}${entry ? ` (${entry.number})` : ''}.${backorderPick ? ` Sisa belum datang: ${backorderPick.number}.` : ''}`);
    if (po) await audit.note(conn, ctx, 'purchase.order', po.id, `${pk.number} Done: ${parts.join('; ')}.`);
    return { pickingId: pk.id, entry, backorder: backorderPick };
  });
}

// ---------------------------------------------------------------- Return (SR-10)

async function createReturn(ctx, deliveryId, input) {
  return run(ctx, { action: 'RETURN_CREATE', docType: 'stock.picking', docId: deliveryId }, async (conn) => {
    requirePerm(ctx, 'inventory.operate');
    const pk = await loadPicking(conn, deliveryId, true);
    if (pk.picking_type !== 'out' || pk.state !== 'done') {
      throw new BusinessError('Retur hanya dapat dibuat dari Delivery Order yang sudah Done (SR-10).', { rule: 'SR-10', docNumber: pk.number });
    }
    const moves = [];
    for (const m of pk.moves) {
      if (m.state !== 'done') continue;
      const v = input[m.id] || {};
      const qty = toInt(v.qty, 0);
      if (qty === 0) continue;
      const sellable = v.sellable === undefined || v.sellable === '' ? qty : toInt(v.sellable, 0);
      const damaged = v.damaged === undefined || v.damaged === '' ? qty - sellable : toInt(v.damaged, 0);
      const already = await returnedQty(conn, m.id);
      const returnable = m.qty_done - already;
      if (qty < 0 || sellable < 0 || damaged < 0) throw new BusinessError('Kuantitas retur tidak boleh negatif.', { rule: 'SR-10', docNumber: pk.number });
      if (qty > returnable) {
        throw new BusinessError(`Retur ${qty} ${m.sku} ditolak: dari ${m.qty_done} unit terkirim di ${pk.number}, ${already} sudah diretur sehingga maksimal ${returnable} unit lagi (SR-10).`, {
          rule: 'SR-10', docNumber: pk.number, detail: { sku: m.sku, delivered: m.qty_done, already_returned: already, requested: qty, returnable },
        });
      }
      if (sellable + damaged !== qty) {
        throw new BusinessError(`${m.sku}: layak jual (${sellable}) + rusak (${damaged}) harus sama dengan kuantitas retur (${qty}).`, { rule: 'SR-10', docNumber: pk.number });
      }
      moves.push({ productId: m.product_id, qty, sellable, damaged, unitCost: m.unit_cost, saleLineId: m.sale_line_id, originMoveId: m.id });
    }
    if (!moves.length) throw new BusinessError('Isi kuantitas retur minimal satu unit.', { rule: 'SR-10', docNumber: pk.number });
    const ret = await createPicking(conn, ctx, {
      type: 'ret', state: 'draft', partnerId: pk.partner_id, srcId: pk.dest_location_id, destId: pk.src_location_id,
      saleOrderId: pk.sale_order_id, returnOfId: pk.id, moves, note: input.note,
    });
    await audit.log(conn, ctx, { action: 'RETURN_CREATE', docType: 'stock.picking', docId: ret.id, docNumber: ret.number, message: `Return Inspection dari ${pk.number}` });
    await audit.note(conn, ctx, 'stock.picking', ret.id, `Return Inspection dibuat dari ${pk.number}: ${moves.map((m) => `${m.qty} (layak jual ${m.sellable}, rusak ${m.damaged})`).join(', ')}.`);
    await audit.note(conn, ctx, 'stock.picking', pk.id, `Retur ${ret.number} dibuat.`);
    return ret.id;
  });
}

/**
 * Validasi retur: stok layak jual kembali ke lokasi asal, COGS dibalik pada standard cost,
 * lalu Credit Note (Draft) dibuat untuk kuantitas sah yang sudah ditagih.
 */
async function validateReturn(ctx, returnId) {
  return run(ctx, { action: 'RETURN_VALIDATE', docType: 'stock.picking', docId: returnId }, async (conn) => {
    requirePerm(ctx, 'inventory.operate');
    const ret = await loadPicking(conn, returnId, true);
    if (ret.picking_type !== 'ret') throw new BusinessError('Bukan dokumen retur.', { rule: 'SR-10' });
    if (ret.state === 'done') throw new BusinessError(`${ret.number} sudah Done; validasi kedua ditolak (SR-12).`, { rule: 'SR-12', docNumber: ret.number });
    if (ret.state !== 'draft') throw new BusinessError(`${ret.number} berstatus ${ret.state}.`, { rule: 'SR-10', docNumber: ret.number });
    const now = nowStr();
    const lines = [];
    const parts = [];
    for (const m of ret.moves) {
      const origin = await q1(conn, 'SELECT * FROM stock_moves WHERE id = ? FOR UPDATE', [m.origin_move_id]);
      const already = await returnedQty(conn, origin.id, ret.id);
      if (m.qty_demand > origin.qty_done - already) {
        throw new BusinessError(`Retur ${m.qty_demand} ${m.sku} melebihi sisa yang dapat diretur (${origin.qty_done - already}) (SR-10).`, { rule: 'SR-10', docNumber: ret.number });
      }
      if (m.qty_sellable > 0) {
        const qt = await lockQuant(conn, m.product_id, ret.dest_location_id);
        await q(conn, 'UPDATE stock_quants SET on_hand = on_hand + ? WHERE id = ?', [m.qty_sellable, qt.id]);
      }
      const cost = origin.unit_cost;
      await q(conn, "UPDATE stock_moves SET qty_done = qty_demand, unit_cost = ?, value = ?, state = 'done', done_at = ? WHERE id = ?", [cost, m.qty_sellable * cost, now, m.id]);
      if (m.sale_line_id) await q(conn, 'UPDATE sale_order_lines SET qty_returned = qty_returned + ? WHERE id = ?', [m.qty_demand, m.sale_line_id]);
      if (m.qty_sellable > 0) lines.push({ account: '120', label: `Retur layak jual ${m.sku} × ${m.qty_sellable}`, debit: m.qty_sellable * cost });
      if (m.qty_damaged > 0) lines.push({ account: '602', label: `Retur rusak ${m.sku} × ${m.qty_damaged}`, debit: m.qty_damaged * cost });
      lines.push({ account: '501', label: `Pembalikan COGS ${m.sku} × ${m.qty_demand}`, credit: m.qty_demand * cost });
      parts.push(`${m.sku} ${m.qty_demand} (layak jual ${m.qty_sellable}, rusak ${m.qty_damaged})`);
    }
    await q(conn, "UPDATE pickings SET state = 'done', done_by = ?, done_at = ? WHERE id = ?", [ctx.user.id, now, ret.id]);
    const entry = await postEntry(conn, ctx, {
      journal: 'STJ', ref: `${ret.number} — return stock move & COGS reversal`, sourceType: 'stock.picking', sourceId: ret.id,
      eventKey: `picking:${ret.id}:done`, lines,
    });
    // Credit Note draft untuk kuantitas sah yang sudah ditagih (diposting Finance).
    const invoicing = require('./invoicing');
    const creditNote = await invoicing._createCreditNoteForReturn(conn, ctx, ret);
    await audit.log(conn, ctx, {
      action: 'RETURN_VALIDATE', docType: 'stock.picking', docId: ret.id, docNumber: ret.number,
      message: `${parts.join('; ')}; jurnal ${entry.number}${creditNote ? `; credit note draft ${rp(creditNote.total)}` : ''}`,
    });
    await audit.note(conn, ctx, 'stock.picking', ret.id, `Done: ${parts.join('; ')}. COGS dibalik (${entry.number}).${creditNote ? ` Credit Note draft ${rp(creditNote.total)} dibuat untuk diposting Finance.` : ' Barang belum ditagih sehingga tidak perlu Credit Note.'}`);
    if (ret.sale_order_id) await audit.note(conn, ctx, 'sale.order', ret.sale_order_id, `Retur ${ret.number} Done: ${parts.join('; ')}.`);
    return { returnId: ret.id, entry, creditNote };
  });
}

// ---------------------------------------------------------------- Laporan stok

async function stockOverview() {
  const rows = await q(getPool(), `SELECT p.id AS product_id, p.sku, p.name, p.size, p.uom, p.standard_cost, l.code AS location_code, l.name AS location_name,
      sq.on_hand, sq.reserved, (sq.on_hand - sq.reserved) AS available, sq.on_hand * p.standard_cost AS value
    FROM stock_quants sq JOIN products p ON p.id = sq.product_id JOIN locations l ON l.id = sq.location_id
    WHERE l.usage_type = 'internal' ORDER BY p.id, l.id`);
  const totals = rows.reduce((t, r) => ({ on_hand: t.on_hand + r.on_hand, reserved: t.reserved + r.reserved, value: t.value + Number(r.value) }), { on_hand: 0, reserved: 0, value: 0 });
  return { rows: rows.map((r) => ({ ...r, value: Number(r.value) })), totals };
}

module.exports = {
  TYPE_LABEL, lockQuant, reserve, unreserve, createPicking, loadPicking, listPickings, getPicking, returnedQty,
  _validateDelivery, validateDelivery, cancelPicking, createTransfer, confirmTransfer, validateTransfer,
  saveQualityCheck, validateReceipt, createReturn, validateReturn, stockOverview,
};
