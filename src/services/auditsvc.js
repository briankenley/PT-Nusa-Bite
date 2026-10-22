'use strict';
const { q, q1, getPool } = require('../db');

async function listLogs({ q: search, result, docType, limit = 300 } = {}) {
  const where = [];
  const params = [];
  if (search) {
    where.push('(a.doc_number LIKE ? OR a.username LIKE ? OR a.action LIKE ? OR a.message LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (result) { where.push('a.result = ?'); params.push(result); }
  if (docType) { where.push('a.doc_type = ?'); params.push(docType); }
  params.push(Number(limit));
  return q(getPool(), `SELECT a.* FROM audit_logs a ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT ?`, params);
}

async function logsFor(docType, docId, numbers = []) {
  const nums = numbers.filter(Boolean);
  const cond = ['(a.doc_type = ? AND a.doc_id = ?)'];
  const params = [docType, docId];
  if (nums.length) { cond.push(`a.doc_number IN (${nums.map(() => '?').join(',')})`); params.push(...nums); }
  return q(getPool(), `SELECT a.* FROM audit_logs a WHERE ${cond.join(' OR ')} ORDER BY a.id`, params);
}

async function messagesFor(docType, docId) {
  return q(getPool(), 'SELECT * FROM messages WHERE doc_type = ? AND doc_id = ? ORDER BY id DESC', [docType, docId]);
}

/**
 * Penelusuran end-to-end (F-22): dari nomor Sales Order ke Lead/Opportunity, Delivery, Invoice,
 * Payment, Return, Credit Note, dan Journal Entry — beserta aktor, waktu, dan aksi.
 */
async function trace(number) {
  const pool = getPool();
  const so = await q1(pool, `SELECT o.*, p.code AS partner_code, p.name AS partner_name FROM sale_orders o JOIN partners p ON p.id = o.partner_id WHERE o.number = ?`, [number]);
  if (!so) return null;
  const docs = [];
  if (so.opportunity_id) {
    const opp = await q1(pool, 'SELECT o.id, o.number, o.stage, l.id AS lead_id, l.number AS lead_number FROM crm_opportunities o JOIN crm_leads l ON l.id = o.lead_id WHERE o.id = ?', [so.opportunity_id]);
    docs.push({ kind: 'Lead', number: opp.lead_number, state: 'converted', href: `/crm/leads/${opp.lead_id}`, docType: 'crm.lead', id: opp.lead_id });
    docs.push({ kind: 'Opportunity', number: opp.number, state: opp.stage, href: `/crm/opportunities/${opp.id}`, docType: 'crm.opportunity', id: opp.id });
  }
  docs.push({ kind: 'Sales Order', number: so.number, state: so.state === 'sale' ? 'Confirmed' : so.state, amount: so.amount_total, href: `/sales/orders/${so.id}`, docType: 'sale.order', id: so.id });
  const picks = await q(pool, 'SELECT id, number, picking_type, state FROM pickings WHERE sale_order_id = ? ORDER BY id', [so.id]);
  for (const pk of picks) docs.push({ kind: pk.picking_type === 'ret' ? 'Return' : 'Delivery Order', number: pk.number, state: pk.state, href: `/inventory/pickings/${pk.id}`, docType: 'stock.picking', id: pk.id });
  const invs = await q(pool, 'SELECT id, number, move_type, state, payment_state, amount_total, amount_residual FROM invoices WHERE sale_order_id = ? ORDER BY id', [so.id]);
  for (const i of invs) {
    docs.push({
      kind: i.move_type === 'out_refund' ? 'Credit Note' : 'Customer Invoice', number: i.number || 'Draft', state: i.state === 'posted' ? `Posted / ${i.payment_state}` : i.state,
      amount: i.amount_total, residual: i.amount_residual, href: `/invoicing/invoices/${i.id}`, docType: 'account.move', id: i.id,
    });
  }
  const pays = await q(pool, 'SELECT pay.id, pay.number, pay.amount, pay.method FROM payments pay JOIN invoices i ON i.id = pay.invoice_id WHERE i.sale_order_id = ? ORDER BY pay.id', [so.id]);
  for (const p of pays) docs.push({ kind: 'Payment', number: p.number, state: 'Posted', amount: p.amount, href: `/accounting/payments#${p.number}`, docType: 'account.payment', id: p.id });
  const ids = { picks: picks.map((p) => p.id), invs: invs.map((i) => i.id), pays: pays.map((p) => p.id) };
  const entries = await q(pool, `SELECT id, number, journal, total_debit, ref FROM journal_entries WHERE state = 'posted' AND (
      (source_type = 'stock.picking' AND source_id IN (?)) OR (source_type = 'account.move' AND source_id IN (?)) OR (source_type = 'account.payment' AND source_id IN (?))) ORDER BY id`,
  [ids.picks.length ? ids.picks : [0], ids.invs.length ? ids.invs : [0], ids.pays.length ? ids.pays : [0]]);
  const numbers = docs.map((d) => d.number).concat(entries.map((e) => e.number)).filter((n) => n && n !== 'Draft');
  const logs = await q(pool, `SELECT * FROM audit_logs WHERE doc_number IN (?) OR (doc_type = 'sale.order' AND doc_id = ?)
      OR (doc_type = 'stock.picking' AND doc_id IN (?)) OR (doc_type = 'account.move' AND doc_id IN (?)) ORDER BY id`,
  [numbers.length ? numbers : [''], so.id, ids.picks.length ? ids.picks : [0], ids.invs.length ? ids.invs : [0]]);
  const residual = invs.filter((i) => i.move_type === 'out_invoice' && i.state === 'posted').reduce((s, i) => s + i.amount_residual, 0);
  return { so, docs, entries, logs, residual };
}

module.exports = { listLogs, logsFor, messagesFor, trace };
