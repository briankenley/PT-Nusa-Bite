'use strict';
const { q, q1, getPool } = require('../db');

/**
 * KPI operasional (SR-18): penjualan dari invoice Posted, kas dari payment Posted,
 * stok dari move Done. Dokumen Draft / belum diterima ditampilkan terpisah dan TIDAK menambah realisasi.
 */
async function kpis({ from = null, to = null } = {}) {
  const pool = getPool();
  const range = (col) => {
    const parts = [];
    const params = [];
    if (from) { parts.push(`${col} >= ?`); params.push(from); }
    if (to) { parts.push(`${col} <= ?`); params.push(to); }
    return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
  };
  const inv = range('invoice_date');
  const sales = await q1(pool, `SELECT
      COALESCE(SUM(CASE WHEN move_type = 'out_invoice' THEN amount_untaxed END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN move_type = 'out_invoice' THEN amount_tax END), 0) AS pbjt,
      COALESCE(SUM(CASE WHEN move_type = 'out_refund' THEN amount_untaxed END), 0) AS returns,
      COALESCE(SUM(CASE WHEN move_type = 'out_refund' THEN amount_tax END), 0) AS pbjt_returns,
      COUNT(CASE WHEN move_type = 'out_invoice' THEN 1 END) AS invoice_count,
      COALESCE(SUM(CASE WHEN move_type = 'in_invoice' THEN amount_total END), 0) AS bills
    FROM invoices WHERE state = 'posted'${inv.sql}`, inv.params);
  const pay = range('payment_date');
  const cash = await q1(pool, `SELECT
      COALESCE(SUM(CASE WHEN payment_type = 'inbound' THEN amount END), 0) AS collected,
      COALESCE(SUM(CASE WHEN payment_type = 'outbound' THEN amount END), 0) AS paid_out
    FROM payments WHERE state = 'posted'${pay.sql}`, pay.params);
  const je = range('e.entry_date');
  const gl = await q1(pool, `SELECT
      COALESCE(SUM(CASE WHEN l.account_code = '501' THEN l.debit - l.credit END), 0) AS cogs,
      COALESCE(SUM(CASE WHEN l.account_code = '601' THEN l.debit - l.credit END), 0) AS salary
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id AND e.state = 'posted' WHERE e.source_type <> 'opening'${je.sql}`, je.params);
  const balances = await q1(pool, `SELECT
      COALESCE(SUM(CASE WHEN l.account_code = '101' THEN l.debit - l.credit END), 0) AS cash,
      COALESCE(SUM(CASE WHEN l.account_code = '102' THEN l.debit - l.credit END), 0) AS bank,
      COALESCE(SUM(CASE WHEN l.account_code = '110' THEN l.debit - l.credit END), 0) AS ar,
      COALESCE(SUM(CASE WHEN l.account_code = '201' THEN l.credit - l.debit END), 0) AS ap,
      COALESCE(SUM(CASE WHEN l.account_code = '120' THEN l.debit - l.credit END), 0) AS inventory_gl
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id AND e.state = 'posted'`);
  const stockVal = await q1(pool, `SELECT COALESCE(SUM(sq.on_hand), 0) AS units, COALESCE(SUM(sq.on_hand * p.standard_cost), 0) AS value
    FROM stock_quants sq JOIN products p ON p.id = sq.product_id`);
  const mv = range('DATE(m.done_at)');
  const received = await q1(pool, `SELECT COALESCE(SUM(m.qty_done), 0) AS qty, COALESCE(SUM(m.value), 0) AS value FROM stock_moves m
    JOIN pickings pk ON pk.id = m.picking_id WHERE pk.picking_type = 'in' AND m.state = 'done'${mv.sql}`, mv.params);
  const delivered = await q1(pool, `SELECT COALESCE(SUM(m.qty_done), 0) AS qty FROM stock_moves m
    JOIN pickings pk ON pk.id = m.picking_id WHERE pk.picking_type = 'out' AND m.state = 'done'${mv.sql}`, mv.params);
  // Tidak dihitung sebagai realisasi:
  const excluded = {
    draft_quotations: await q1(pool, "SELECT COUNT(*) AS n, COALESCE(SUM(amount_total), 0) AS value FROM sale_orders WHERE state = 'draft'"),
    confirmed_uninvoiced: await q1(pool, `SELECT COUNT(DISTINCT o.id) AS n FROM sale_orders o JOIN sale_order_lines l ON l.order_id = o.id
      WHERE o.state = 'sale' AND l.qty_invoiced < l.qty - l.qty_cancelled`),
    draft_invoices: await q1(pool, "SELECT COUNT(*) AS n, COALESCE(SUM(amount_total), 0) AS value FROM invoices WHERE state = 'draft'"),
    rfq_draft: await q1(pool, "SELECT COUNT(*) AS n, COALESCE(SUM(amount_total), 0) AS value FROM purchase_orders WHERE state = 'draft'"),
    po_not_received: await q1(pool, `SELECT COUNT(*) AS n, COALESCE(SUM(o.amount_total), 0) AS value FROM purchase_orders o WHERE o.state = 'purchase'
      AND NOT EXISTS (SELECT 1 FROM pickings pk WHERE pk.purchase_order_id = o.id AND pk.state = 'done')`),
  };
  const sources = {
    invoices: await q(pool, `SELECT i.id, i.number, i.move_type, i.invoice_date, i.amount_untaxed, i.amount_tax, i.amount_total, p.code AS partner_code
      FROM invoices i JOIN partners p ON p.id = i.partner_id WHERE i.state = 'posted' AND i.move_type IN ('out_invoice','out_refund')${inv.sql.replace(/invoice_date/g, 'i.invoice_date')} ORDER BY i.id`, inv.params),
    payments: await q(pool, `SELECT pay.id, pay.number, pay.payment_type, pay.payment_date, pay.amount, i.number AS invoice_number
      FROM payments pay JOIN invoices i ON i.id = pay.invoice_id WHERE pay.state = 'posted'${pay.sql.replace(/payment_date/g, 'pay.payment_date')} ORDER BY pay.id`, pay.params),
  };
  const n = (v) => Number(v || 0);
  return {
    revenue: n(sales.revenue),
    returns: n(sales.returns),
    net_revenue: n(sales.revenue) - n(sales.returns),
    pbjt: n(sales.pbjt) - n(sales.pbjt_returns),
    invoice_count: n(sales.invoice_count),
    bills: n(sales.bills),
    cash_collected: n(cash.collected),
    paid_out: n(cash.paid_out),
    cogs: n(gl.cogs),
    salary: n(gl.salary),
    gross_margin: n(sales.revenue) - n(sales.returns) - n(gl.cogs),
    received_qty: n(received.qty),
    received_value: n(received.value),
    delivered_qty: n(delivered.qty),
    balances: { cash: n(balances.cash), bank: n(balances.bank), ar: n(balances.ar), ap: n(balances.ap), inventory_gl: n(balances.inventory_gl) },
    stock: { units: n(stockVal.units), value: n(stockVal.value) },
    excluded,
    sources,
  };
}

module.exports = { kpis };
