'use strict';
const ui = require('../lib/ui');
const db = require('../db');
const { can } = require('../lib/acl');
const { buildList } = require('../lib/listview');
const { rp } = require('../lib/money');
const purchase = require('../services/purchase');
const reorder = require('../services/reorder');
const { loadChatter } = require('./_chatter');

async function editorProducts() {
  const rows = await db.query(`SELECT p.id, p.sku, p.name, p.size, p.uom, p.standard_cost AS price, v.code AS vendor_code
    FROM products p LEFT JOIN partners v ON v.id = p.default_vendor_id ORDER BY p.id`);
  return rows.map((r) => ({ ...r, hint: `${rp(r.price)} · vendor ${r.vendor_code}` }));
}

module.exports = (app) => {
  app.get('/purchase/orders', ui.need('purchase.view'), async (req, res) => {
    res.locals.setApp('purchase');
    const rows = await purchase.listOrders();
    const list = buildList(req, rows, {
      search: ['number', 'partner_code', 'partner_name'],
      filters: [
        { key: 'draft', label: 'RFQ', group: 'state', test: (r) => r.state === 'draft' },
        { key: 'purchase', label: 'Purchase Orders', group: 'state', test: (r) => r.state === 'purchase' },
        { key: 'notreceived', label: 'Belum diterima', test: (r) => r.state === 'purchase' && Number(r.qty_received) === 0 },
        { key: 'tobill', label: 'Accepted belum di-bill', test: (r) => Number(r.qty_received) > Number(r.qty_billed) },
      ],
      groupBys: [
        { key: 'state', label: 'Status', value: (r) => purchase.STATE_LABEL[r.state] },
        { key: 'vendor', label: 'Vendor', value: (r) => `${r.partner_code} ${r.partner_name}` },
      ],
      views: ['list', 'kanban'],
    });
    res.render('pages/list_page', {
      title: 'Purchase',
      cp: { crumbs: [{ label: 'Purchase' }, { label: 'RFQ & Purchase Orders' }], list, views: ['list', 'kanban'], actions: can(req.user.role, 'purchase.edit') ? '<a class="btn btn-primary" href="/purchase/orders/new">New RFQ</a>' : '' },
      columns: [
        { label: 'Reference', value: (r) => r.number },
        { label: 'Order Date', value: (r) => r.order_date },
        { label: 'Vendor', value: (r) => `${r.partner_code} ${r.partner_name}` },
        { label: 'Status', html: (r) => ui.badge(r.state, purchase.STATE_LABEL[r.state]) },
        { label: 'Ordered', value: (r) => Number(r.qty_total), cls: 'num' },
        { label: 'Accepted', value: (r) => Number(r.qty_received), cls: 'num' },
        { label: 'Billed', value: (r) => Number(r.qty_billed), cls: 'num' },
        { label: 'Total', value: (r) => r.amount_total, html: (r) => rp(r.amount_total), cls: 'num', sum: true, fmt: 'money' },
      ],
      href: (r) => `/purchase/orders/${r.id}`,
      card: (r) => ({ title: `${r.number} — ${r.partner_name}`, subtitle: `Ordered ${r.qty_total} · Accepted ${r.qty_received}`, left: ui.badge(r.state, purchase.STATE_LABEL[r.state]), right: `<b>${rp(r.amount_total)}</b>` }),
    });
  });

  const vendors = () => db.query('SELECT id, code, name, payment_term_code FROM partners WHERE is_vendor = 1 ORDER BY code');

  app.get('/purchase/orders/new', ui.need('purchase.edit'), async (req, res) => {
    res.locals.setApp('purchase');
    // Prefill dari saran pembelian F-23: ?vendor=ID&p=ID:qty&p=ID:qty
    const pre = [].concat(req.query.p || []).map((x) => String(x).split(':')).filter(([id, qty]) => Number(id) && Number(qty) > 0)
      .map(([id, qty]) => ({ product_id: Number(id), qty: Number(qty) }));
    res.render('pages/po_edit', { title: 'New RFQ', order: null, vendors: await vendors(), products: await editorProducts(), lines: pre, vendorId: Number(req.query.vendor) || null });
  });

  app.get('/purchase/reorder', ui.need('purchase.view'), async (req, res) => {
    res.locals.setApp('purchase');
    const cover = Math.min(30, Math.max(1, Number(req.query.cover) || 7));
    const rows = await reorder.suggestions({ coverDays: cover });
    const list = buildList(req, rows, {
      search: ['sku', 'name', 'vendor_code'],
      filters: [{ key: 'need', label: 'Perlu dipesan', test: (r) => r.suggest > 0 }],
      groupBys: [{ key: 'vendor', label: 'Vendor', value: (r) => `${r.vendor_code} ${r.vendor_name}` }],
      defaultGroupBy: 'vendor',
    });
    const byVendor = {};
    for (const r of rows.filter((x) => x.suggest > 0)) (byVendor[r.vendor_id] = byVendor[r.vendor_id] || { code: r.vendor_code, items: [] }).items.push(`p=${r.id}:${r.suggest}`);
    const links = Object.entries(byVendor).map(([vid, v]) => `<a class="btn btn-sm" href="/purchase/orders/new?vendor=${vid}&${v.items.join('&')}">Buat RFQ ${v.code}</a>`).join(' ');
    res.render('pages/list_page', {
      title: 'Reorder Suggestions',
      cp: { crumbs: [{ label: 'Purchase', href: '/purchase/orders' }, { label: 'Saran Pembelian (F-23, optional)' }], list, actions: can(req.user.role, 'purchase.edit') ? links : '' },
      intro: `Rerata harian = unit terkirim 7 hari terakhir (neto retur) ÷ 7. Saran = rerata × <b>${cover} hari cakupan</b> − Available − barang dalam perjalanan. Ubah cakupan: <a href="?cover=3">3</a> · <a href="?cover=7">7</a> · <a href="?cover=14">14</a> hari. Fitur opsional; tidak menggantikan fitur Must.`,
      columns: [
        { label: 'SKU', value: (r) => r.sku }, { label: 'Product', value: (r) => `${r.name} ${r.size}` },
        { label: 'Terjual 7 hari', value: (r) => r.net, cls: 'num' }, { label: 'Rerata/hari', value: (r) => r.avg, cls: 'num' },
        { label: 'Available', value: (r) => r.available, cls: 'num' }, { label: 'Incoming', value: (r) => r.incoming, cls: 'num' },
        { label: 'Saran beli', value: (r) => r.suggest, cls: 'num', sum: true },
        { label: 'Estimasi biaya', value: (r) => r.suggest * r.standard_cost, html: (r) => rp(r.suggest * r.standard_cost), cls: 'num', sum: true, fmt: 'money' },
      ],
      href: (r) => `/products/${r.id}`,
    });
  });

  app.post('/purchase/orders/new', ui.need('purchase.edit'), async (req, res) => {
    const id = await purchase.createRFQ(ui.ctx(req), { partnerId: Number(req.body.partner_id), lines: ui.parseLines(req.body), note: req.body.note, number: req.body.number });
    ui.flash(req, 'success', 'RFQ dibuat.');
    res.redirect(`/purchase/orders/${id}`);
  });

  app.get('/purchase/orders/:id', ui.need('purchase.view'), async (req, res) => {
    res.locals.setApp('purchase');
    const o = await purchase.getOrder(Number(req.params.id));
    const related = [
      ...o.receipts.map((r) => ({ label: `${r.number} (${ui.stateLabel(r.state)})`, href: `/inventory/pickings/${r.id}` })),
      ...o.bills.map((b) => ({ label: `${b.number || 'Draft Bill'} (${ui.stateLabel(b.state)})`, href: `/accounting/bills/${b.id}` })),
    ];
    res.render('pages/po_form', {
      title: o.number, o,
      chatter: await loadChatter('purchase.order', o.id, { numbers: [o.number, ...o.receipts.map((r) => r.number), ...o.bills.map((b) => b.number)], related }),
    });
  });

  app.get('/purchase/orders/:id/edit', ui.need('purchase.edit'), async (req, res) => {
    res.locals.setApp('purchase');
    const o = await purchase.getOrder(Number(req.params.id));
    res.render('pages/po_edit', {
      title: `Edit ${o.number}`, order: o, vendors: await vendors(), products: await editorProducts(),
      lines: o.lines.map((l) => ({ product_id: l.product_id, qty: l.qty, unit_price: l.unit_price })),
    });
  });

  app.post('/purchase/orders/:id/edit', ui.need('purchase.edit'), async (req, res) => {
    await purchase.updateRFQ(ui.ctx(req), Number(req.params.id), { lines: ui.parseLines(req.body), note: req.body.note, number: req.body.number });
    ui.flash(req, 'success', 'RFQ disimpan.');
    res.redirect(`/purchase/orders/${req.params.id}`);
  });

  app.post('/purchase/orders/:id/confirm', ui.need('purchase.edit'), async (req, res) => {
    const r = await purchase.confirmPO(ui.ctx(req), Number(req.params.id));
    ui.flash(req, 'success', `Purchase Order dikonfirmasi; receipt ${r.receipt.number} dibuat. Stok dan AP belum berubah.`);
    res.redirect(`/purchase/orders/${req.params.id}`);
  });

  app.post('/purchase/orders/:id/cancel', ui.need('purchase.edit'), async (req, res) => {
    await purchase.cancelPO(ui.ctx(req), Number(req.params.id));
    ui.flash(req, 'success', 'Dibatalkan.');
    res.redirect(`/purchase/orders/${req.params.id}`);
  });
};
