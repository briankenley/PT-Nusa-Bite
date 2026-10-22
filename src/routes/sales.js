'use strict';
const ui = require('../lib/ui');
const db = require('../db');
const { can } = require('../lib/acl');
const { buildList } = require('../lib/listview');
const { rp } = require('../lib/money');
const policies = require('../policies');
const sales = require('../services/sales');
const { loadChatter } = require('./_chatter');

async function editorProducts(locationCode = policies.SALES_LOCATION) {
  const rows = await db.query(`SELECT p.id, p.sku, p.name, p.size, p.uom, p.sales_price AS price, (sq.on_hand - sq.reserved) AS available
    FROM products p LEFT JOIN stock_quants sq ON sq.product_id = p.id AND sq.location_id = (SELECT id FROM locations WHERE code = ?)
    WHERE p.active = 1 ORDER BY p.id`, [locationCode]);
  return rows.map((r) => ({ ...r, hint: `${rp(r.price)} · Available ${locationCode} ${Number(r.available || 0)}` }));
}

async function customers() {
  return db.query("SELECT id, code, name, credit_limit, payment_term_code FROM partners WHERE is_customer = 1 AND code <> 'WALKIN' ORDER BY code");
}

module.exports = (app) => {
  app.get('/sales/orders', ui.need('sales.view'), async (req, res) => {
    res.locals.setApp('sales');
    const rows = await sales.listOrders();
    const list = buildList(req, rows, {
      search: ['number', 'partner_code', 'partner_name'],
      filters: [
        { key: 'draft', label: 'Quotations', group: 'state', test: (r) => r.state === 'draft' },
        { key: 'sale', label: 'Sales Orders', group: 'state', test: (r) => r.state === 'sale' },
        { key: 'cancel', label: 'Cancelled', group: 'state', test: (r) => r.state === 'cancel' },
        { key: 'toinvoice', label: 'To Invoice', test: (r) => r.invoice_status === 'To invoice' },
        { key: 'counter', label: 'Quick Counter', test: (r) => r.is_counter },
        { key: 'approval', label: 'Menunggu persetujuan diskon', test: (r) => r.discount_approval === 'pending' },
      ],
      groupBys: [
        { key: 'state', label: 'Status', value: (r) => sales.STATE_LABEL[r.state] },
        { key: 'customer', label: 'Customer', value: (r) => `${r.partner_code} ${r.partner_name}` },
        { key: 'delivery', label: 'Delivery Status', value: (r) => r.delivery_status },
        { key: 'invoice', label: 'Invoice Status', value: (r) => r.invoice_status },
      ],
      views: ['list', 'kanban'],
    });
    res.render('pages/list_page', {
      title: 'Quotations & Sales Orders',
      cp: { crumbs: [{ label: 'Sales' }, { label: 'Quotations & Orders' }], list, views: ['list', 'kanban'], actions: can(req.user.role, 'sales.edit') ? '<a class="btn btn-primary" href="/sales/orders/new">New</a>' : '' },
      columns: [
        { label: 'Number', value: (r) => r.number },
        { label: 'Order Date', value: (r) => r.order_date },
        { label: 'Customer', value: (r) => `${r.partner_code} ${r.partner_name}` },
        { label: 'Location', value: (r) => r.location_code },
        { label: 'Status', html: (r) => ui.badge(r.state, sales.STATE_LABEL[r.state]) + (r.discount_approval === 'pending' ? ` ${ui.badge('pending', 'Diskon > 10%')}` : '') },
        { label: 'Delivery', value: (r) => r.delivery_status },
        { label: 'Invoice', value: (r) => r.invoice_status },
        { label: 'Untaxed', value: (r) => r.amount_untaxed, html: (r) => rp(r.amount_untaxed), cls: 'num', sum: true, fmt: 'money' },
        { label: 'PBJT', value: (r) => r.amount_tax, html: (r) => rp(r.amount_tax), cls: 'num', sum: true, fmt: 'money' },
        { label: 'Total', value: (r) => r.amount_total, html: (r) => rp(r.amount_total), cls: 'num', sum: true, fmt: 'money' },
      ],
      href: (r) => `/sales/orders/${r.id}`,
      card: (r) => ({ title: `${r.number} — ${r.partner_name}`, subtitle: `${r.delivery_status} · ${r.invoice_status}`, left: ui.badge(r.state, sales.STATE_LABEL[r.state]), right: `<b>${rp(r.amount_total)}</b>` }),
    });
  });

  app.get('/sales/orders/new', ui.need('sales.edit'), async (req, res) => {
    res.locals.setApp('sales');
    res.render('pages/so_edit', {
      title: 'New Quotation', order: null, customers: await customers(), products: await editorProducts(),
      partnerId: req.query.partner_id || '', opportunityId: req.query.opportunity_id || '', lines: [], locked: false,
      maxDiscount: policies.MAX_SALES_DISCOUNT_PCT,
    });
  });

  app.post('/sales/orders/new', ui.need('sales.edit'), async (req, res) => {
    const id = await sales.createOrder(ui.ctx(req), {
      partnerId: Number(req.body.partner_id), opportunityId: req.body.opportunity_id ? Number(req.body.opportunity_id) : null,
      locationCode: req.body.location_code, note: req.body.note, lines: ui.parseLines(req.body),
    });
    ui.flash(req, 'success', 'Quotation dibuat.');
    res.redirect(`/sales/orders/${id}`);
  });

  app.get('/sales/orders/:id', ui.need('sales.view'), async (req, res) => {
    res.locals.setApp('sales');
    const o = await sales.getOrder(Number(req.params.id));
    const related = [];
    if (o.opportunity_number) related.push({ label: `Lead ${o.lead_number}`, href: `/crm/leads/${o.lead_id}` }, { label: `Opportunity ${o.opportunity_number}`, href: `/crm/opportunities/${o.opportunity_id}` });
    for (const p of o.pickings) related.push({ label: `${p.number} (${ui.stateLabel(p.state)})`, href: `/inventory/pickings/${p.id}` });
    for (const i of o.invoices) related.push({ label: `${i.number || 'Draft ' + (i.move_type === 'out_refund' ? 'Credit Note' : 'Invoice')} (${ui.stateLabel(i.state)})`, href: `/invoicing/invoices/${i.id}` });
    for (const p of o.payments) related.push({ label: `${p.number} ${rp(p.amount)}`, href: '/accounting/payments' });
    const numbers = [o.number, ...o.pickings.map((p) => p.number), ...o.invoices.map((i) => i.number), ...o.payments.map((p) => p.number), ...o.revisions.map((r) => r.number)];
    res.render('pages/so_form', {
      title: o.number, o, maxDiscount: policies.MAX_SALES_DISCOUNT_PCT,
      chatter: await loadChatter('sale.order', o.id, { numbers: [o.number, ...o.revisions.map((r) => r.number)], related }),
      numbers,
    });
  });

  app.get('/sales/orders/:id/edit', ui.need('sales.edit'), async (req, res) => {
    res.locals.setApp('sales');
    const o = await sales.getOrder(Number(req.params.id));
    res.render('pages/so_edit', {
      title: `Edit ${o.number}`, order: o, customers: await customers(), products: await editorProducts(o.location_code),
      partnerId: o.partner_id, opportunityId: o.opportunity_id || '', locked: o.state !== 'draft',
      lines: o.lines.map((l) => ({ product_id: l.product_id, qty: l.qty, unit_price: l.unit_price, discount: Number(l.discount_pct) || '' })),
      maxDiscount: policies.MAX_SALES_DISCOUNT_PCT,
    });
  });

  app.post('/sales/orders/:id/edit', ui.need('sales.edit'), async (req, res) => {
    await sales.updateOrder(ui.ctx(req), Number(req.params.id), { lines: ui.parseLines(req.body), note: req.body.note });
    ui.flash(req, 'success', 'Quotation disimpan.');
    res.redirect(`/sales/orders/${req.params.id}`);
  });

  app.post('/sales/orders/:id/confirm', ui.need('sales.edit'), async (req, res) => {
    const r = await sales.confirmOrder(ui.ctx(req), Number(req.params.id));
    ui.flash(req, 'success', `Sales Order dikonfirmasi; ${r.picking.number} dibuat dan stok direservasi.`);
    res.redirect(`/sales/orders/${req.params.id}`);
  });

  app.post('/sales/orders/:id/approve-discount', ui.need('sales.view'), async (req, res) => {
    await sales.approveDiscount(ui.ctx(req), Number(req.params.id));
    ui.flash(req, 'success', 'Diskon disetujui Owner.');
    res.redirect(`/sales/orders/${req.params.id}`);
  });

  app.post('/sales/orders/:id/cancel', ui.need('sales.edit'), async (req, res) => {
    await sales.cancelOrder(ui.ctx(req), Number(req.params.id));
    ui.flash(req, 'success', 'Pesanan dibatalkan.');
    res.redirect(`/sales/orders/${req.params.id}`);
  });

  app.post('/sales/orders/:id/revision', ui.need('sales.view'), async (req, res) => {
    await sales.requestRevision(ui.ctx(req), Number(req.params.id), {
      lineId: req.body.line_id, newUnitPrice: req.body.new_unit_price, newDiscount: req.body.new_discount, reason: req.body.reason,
    });
    ui.flash(req, 'info', 'Revisi diajukan dan menunggu persetujuan Owner. Harga pada Sales Order belum berubah (SR-08).');
    res.redirect(`/sales/orders/${req.params.id}`);
  });

  app.post('/sales/revisions/:id/:decision', ui.need('sales.view'), async (req, res) => {
    const approve = req.params.decision === 'approve';
    await sales.decideRevision(ui.ctx(req), Number(req.params.id), approve);
    ui.flash(req, 'success', approve ? 'Revisi disetujui dan diterapkan.' : 'Revisi ditolak.');
    res.redirect(ui.back(req));
  });

  app.get('/sales/orders/:id/proforma', ui.need('sales.view'), async (req, res) => {
    res.locals.setApp('sales');
    const o = await sales.getOrder(Number(req.params.id));
    res.render('pages/proforma', { title: `Pro-forma ${o.number}`, o });
  });

  app.get('/sales/revisions', ui.need('sales.view'), async (req, res) => {
    res.locals.setApp('sales');
    const rows = await db.query(`SELECT r.*, o.number AS order_number, p.sku, u.username AS requested_by_name, d.username AS decided_by_name
      FROM sale_revisions r JOIN sale_orders o ON o.id = r.order_id JOIN sale_order_lines l ON l.id = r.line_id JOIN products p ON p.id = l.product_id
      LEFT JOIN users u ON u.id = r.requested_by LEFT JOIN users d ON d.id = r.decided_by ORDER BY r.id DESC`);
    const list = buildList(req, rows, {
      search: ['number', 'order_number', 'sku'],
      filters: [{ key: 'pending', label: 'Menunggu persetujuan', test: (r) => r.state === 'pending' }],
      groupBys: [{ key: 'state', label: 'Status', value: (r) => ui.stateLabel(r.state) }],
    });
    res.render('pages/list_page', {
      title: 'Order Revisions',
      cp: { crumbs: [{ label: 'Sales', href: '/sales/orders' }, { label: 'Order Revisions' }], list },
      intro: 'Harga, pajak, SKU, dan diskon pada dokumen Confirmed dikunci; perubahan hanya lewat dokumen revisi yang disetujui Owner dan tercatat di audit (SR-08).',
      columns: [
        { label: 'Revision', value: (r) => r.number },
        { label: 'Order', html: (r) => `<a href="/sales/orders/${r.order_id}">${r.order_number}</a>` },
        { label: 'SKU', value: (r) => r.sku },
        { label: 'Harga', value: (r) => `${rp(r.old_unit_price)} → ${rp(r.new_unit_price)}` },
        { label: 'Diskon', value: (r) => `${r.old_discount}% → ${r.new_discount}%` },
        { label: 'Alasan', value: (r) => r.reason },
        { label: 'Diajukan', value: (r) => `${r.requested_by_name} ${String(r.requested_at).slice(0, 16)}` },
        { label: 'Status', html: (r) => ui.badge(r.state) + (r.decided_by_name ? ` <span class="small muted">${r.decided_by_name}</span>` : '') },
      ],
      href: (r) => `/sales/orders/${r.order_id}`,
    });
  });
};
