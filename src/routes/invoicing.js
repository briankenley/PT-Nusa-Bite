'use strict';
const ui = require('../lib/ui');
const { can } = require('../lib/acl');
const { AccessError } = require('../lib/errors');
const { buildList } = require('../lib/listview');
const { rp } = require('../lib/money');
const invoicing = require('../services/invoicing');
const { loadChatter } = require('./_chatter');

const PAY_LABEL = { not_paid: 'Not Paid', partial: 'Partially Paid', paid: 'Paid' };

function invoiceList(moveType) {
  return async (req, res) => {
    const isBill = moveType === 'in_invoice';
    res.locals.setApp(isBill ? 'accounting' : req.query.app === 'accounting' ? 'accounting' : 'invoicing');
    const rows = await invoicing.listInvoices({ moveType });
    const list = buildList(req, rows, {
      search: ['number', 'partner_code', 'partner_name', 'so_number', 'po_number', 'origin_number'],
      filters: [
        { key: 'draft', label: 'Draft', group: 'state', test: (r) => r.state === 'draft' },
        { key: 'posted', label: 'Posted', group: 'state', test: (r) => r.state === 'posted' },
        { key: 'unpaid', label: 'Not Paid', group: 'pay', test: (r) => r.state === 'posted' && r.payment_state === 'not_paid' },
        { key: 'partial', label: 'Partially Paid', group: 'pay', test: (r) => r.payment_state === 'partial' },
        { key: 'paid', label: 'Paid', group: 'pay', test: (r) => r.payment_state === 'paid' },
      ],
      groupBys: [
        { key: 'state', label: 'Status', value: (r) => ui.stateLabel(r.state) },
        { key: 'partner', label: isBill ? 'Vendor' : 'Customer', value: (r) => `${r.partner_code} ${r.partner_name}` },
        { key: 'payment', label: 'Payment Status', value: (r) => (r.state === 'posted' ? PAY_LABEL[r.payment_state] : 'Draft') },
      ],
      views: ['list', 'kanban'],
    });
    const base = isBill ? '/accounting/bills' : '/invoicing/invoices';
    res.render('pages/list_page', {
      title: invoicing.TYPE_LABEL[moveType] + 's',
      cp: { crumbs: [{ label: isBill ? 'Accounting' : 'Invoicing' }, { label: `${invoicing.TYPE_LABEL[moveType]}s` }], list, views: ['list', 'kanban'] },
      intro: moveType === 'out_invoice' ? 'Customer Invoice dibuat dari Sales Order dan hanya memuat kuantitas Delivery Order Done yang belum ditagih (SR-02). Buka Sales Order lalu klik <b>Create Invoice</b>.'
        : moveType === 'in_invoice' ? 'Vendor Bill dibuat dari Purchase Order dan dibatasi accepted quantity Receipt (three-way match, SR-06). Buka PO lalu klik <b>Create Bill</b>.'
          : 'Credit Note dibuat otomatis dari Return yang tervalidasi (SR-10), lalu diposting Finance.',
      columns: [
        { label: 'Number', value: (r) => r.number || 'Draft' },
        { label: 'Date', value: (r) => r.invoice_date || '' },
        { label: isBill ? 'Vendor' : 'Customer', value: (r) => `${r.partner_code} ${r.partner_name}` },
        { label: 'Source', value: (r) => r.so_number || r.po_number || '' },
        { label: 'Due Date', value: (r) => r.due_date || '' },
        { label: 'Untaxed', value: (r) => r.amount_untaxed, html: (r) => rp(r.amount_untaxed), cls: 'num', sum: true, fmt: 'money' },
        { label: 'Tax', value: (r) => r.amount_tax, html: (r) => rp(r.amount_tax), cls: 'num', sum: true, fmt: 'money' },
        { label: 'Total', value: (r) => r.amount_total, html: (r) => rp(r.amount_total), cls: 'num', sum: true, fmt: 'money' },
        { label: 'Amount Due', value: (r) => (r.state === 'posted' ? r.amount_residual : 0), html: (r) => (r.state === 'posted' ? rp(r.amount_residual) : ''), cls: 'num', sum: true, fmt: 'money' },
        { label: 'Status', html: (r) => (r.state === 'posted' ? ui.badge(r.payment_state) : ui.badge(r.state)) },
      ],
      href: (r) => `${base}/${r.id}`,
      card: (r) => ({ title: r.number || 'Draft', subtitle: `${r.partner_code} ${r.partner_name} · ${r.so_number || r.po_number || ''}`, left: r.state === 'posted' ? ui.badge(r.payment_state) : ui.badge(r.state), right: `<b>${rp(r.amount_total)}</b>` }),
    });
  };
}

async function showInvoice(req, res) {
  const inv = await invoicing.getInvoice(Number(req.params.id));
  if (inv.move_type === 'in_invoice' && !can(req.user.role, 'accounting.view')) throw new AccessError('Vendor Bill hanya untuk Finance/Owner (SR-13).');
  res.locals.setApp(inv.move_type === 'in_invoice' ? 'accounting' : 'invoicing');
  const related = [];
  if (inv.sale_order_id) related.push({ label: `Sales Order ${inv.so_number}`, href: `/sales/orders/${inv.sale_order_id}` });
  if (inv.purchase_order_id) related.push({ label: `Purchase Order ${inv.po_number}`, href: `/purchase/orders/${inv.purchase_order_id}` });
  if (inv.origin_invoice_id) related.push({ label: `Invoice asal ${inv.origin_number}`, href: `/invoicing/invoices/${inv.origin_invoice_id}` });
  if (inv.return_picking_id) related.push({ label: `Return ${inv.return_number}`, href: `/inventory/pickings/${inv.return_picking_id}` });
  if (inv.journal_entry_id) related.push({ label: `Journal ${inv.entry_number}`, href: `/accounting/entries/${inv.journal_entry_id}` });
  for (const p of inv.payments) related.push({ label: `Payment ${p.number} ${rp(p.amount)}`, href: `/accounting/entries/${p.journal_entry_id}` });
  for (const c of inv.credit_notes) related.push({ label: `Credit Note ${c.number || 'Draft'}`, href: `/invoicing/invoices/${c.id}` });
  res.render('pages/invoice_form', {
    title: inv.number || `Draft ${inv.type_label}`, inv, payLabel: PAY_LABEL,
    canEdit: can(req.user.role, inv.move_type === 'in_invoice' ? 'accounting.edit' : 'invoicing.edit'),
    canPay: can(req.user.role, 'accounting.edit'),
    chatter: await loadChatter('account.move', inv.id, { numbers: [inv.number, inv.entry_number, ...inv.payments.map((p) => p.number)].filter(Boolean), related }),
  });
}

module.exports = (app) => {
  app.get('/invoicing/invoices', ui.need('invoicing.view'), invoiceList('out_invoice'));
  app.get('/invoicing/credit-notes', ui.need('invoicing.view'), invoiceList('out_refund'));
  app.get('/accounting/bills', ui.need('accounting.view'), invoiceList('in_invoice'));
  app.get('/invoicing/invoices/:id', ui.need('invoicing.view'), showInvoice);
  app.get('/accounting/bills/:id', ui.need('accounting.view'), showInvoice);

  app.post('/invoicing/from-sale/:soId', ui.need('invoicing.view'), async (req, res) => {
    const id = await invoicing.createInvoiceFromSale(ui.ctx(req), Number(req.params.soId));
    ui.flash(req, 'success', 'Draft Customer Invoice dibuat dari kuantitas Done yang belum ditagih.');
    res.redirect(`/invoicing/invoices/${id}`);
  });

  app.post('/accounting/bills/from-po/:poId', ui.need('accounting.view'), async (req, res) => {
    const id = await invoicing.createBillFromPO(ui.ctx(req), Number(req.params.poId));
    ui.flash(req, 'success', 'Draft Vendor Bill dibuat sebesar accepted quantity.');
    res.redirect(`/accounting/bills/${id}`);
  });

  app.post('/invoicing/invoices/:id/qty', ui.need('invoicing.view'), async (req, res) => {
    await invoicing.updateDraftQuantities(ui.ctx(req), Number(req.params.id), ui.idMap(req.body.qty));
    ui.flash(req, 'success', 'Kuantitas draft disimpan.');
    res.redirect(ui.back(req));
  });

  app.post('/invoicing/invoices/:id/post', ui.need('invoicing.view'), async (req, res) => {
    const r = await invoicing.postInvoice(ui.ctx(req), Number(req.params.id));
    ui.flash(req, 'success', `${r.number} Posted; jurnal ${r.entry.number} seimbang.`);
    res.redirect(ui.back(req));
  });

  app.post('/invoicing/invoices/:id/pay', ui.need('invoicing.view'), async (req, res) => {
    const r = await invoicing.registerPayment(ui.ctx(req), Number(req.params.id), {
      amount: req.body.amount, method: req.body.method, date: req.body.date || undefined, memo: req.body.memo,
    });
    ui.flash(req, 'success', `Payment ${r.number} Posted; sisa tagihan ${rp(r.residual)}.`);
    res.redirect(ui.back(req));
  });
};
