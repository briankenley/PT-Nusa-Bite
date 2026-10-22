'use strict';
const ui = require('../lib/ui');
const db = require('../db');
const { buildList } = require('../lib/listview');
const { rp, num } = require('../lib/money');
const stock = require('../services/stock');
const { loadChatter } = require('./_chatter');

const STATES = {
  out: [['ready', 'Ready'], ['done', 'Done']],
  in: [['ready', 'Ready'], ['qc', 'Quality Check'], ['done', 'Done']],
  int: [['draft', 'Draft'], ['ready', 'Ready'], ['done', 'Done']],
  ret: [['draft', 'Draft (Inspection)'], ['done', 'Done']],
};
const TITLES = { out: 'Delivery Orders', in: 'Receipts', int: 'Internal Transfers', ret: 'Returns' };

module.exports = (app) => {
  app.get('/inventory', ui.need('inventory.view'), async (req, res) => {
    res.locals.setApp('inventory');
    const counts = await db.query("SELECT picking_type, state, COUNT(*) AS n FROM pickings GROUP BY picking_type, state");
    const c = (t, s) => Number((counts.find((r) => r.picking_type === t && r.state === s) || {}).n || 0);
    const st = await stock.stockOverview();
    res.render('pages/inventory_overview', {
      title: 'Inventory Overview',
      cards: [
        { title: 'Receipts', sub: 'WH-PKU · Vendor → Gudang', todo: c('in', 'ready') + c('in', 'qc'), done: c('in', 'done'), href: '/inventory/pickings?type=in' },
        { title: 'Delivery Orders', sub: 'Outlet/Gudang → Customer', todo: c('out', 'ready'), done: c('out', 'done'), href: '/inventory/pickings?type=out' },
        { title: 'Internal Transfers', sub: 'WH-PKU ⇄ OUTLET-SUD', todo: c('int', 'draft') + c('int', 'ready'), done: c('int', 'done'), href: '/inventory/pickings?type=int' },
        { title: 'Returns', sub: 'Customer → Lokasi asal', todo: c('ret', 'draft'), done: c('ret', 'done'), href: '/inventory/pickings?type=ret' },
      ],
      totals: st.totals,
    });
  });

  app.get('/inventory/pickings', ui.need('inventory.view'), async (req, res) => {
    res.locals.setApp('inventory');
    const type = STATES[req.query.type] ? req.query.type : null;
    const rows = await stock.listPickings({ type });
    const list = buildList(req, rows, {
      keep: type ? { type } : {},
      search: ['number', 'partner_code', 'partner_name', 'so_number', 'po_number'],
      filters: [
        { key: 'todo', label: 'To Do (Ready / QC / Draft)', group: 'state', test: (r) => ['ready', 'qc', 'draft'].includes(r.state) },
        { key: 'done', label: 'Done', group: 'state', test: (r) => r.state === 'done' },
        { key: 'backorder', label: 'Backorders', test: (r) => !!r.backorder_of_id },
      ],
      groupBys: [
        { key: 'state', label: 'Status', value: (r) => ui.stateLabel(r.state) },
        { key: 'type', label: 'Operation Type', value: (r) => stock.TYPE_LABEL[r.picking_type] },
        { key: 'src', label: 'Source Location', value: (r) => r.src_code },
      ],
      views: ['list', 'kanban'],
    });
    const actions = req.user && res.locals.perms['inventory.operate'] && (type === 'int' || !type) ? '<a class="btn btn-primary" href="/inventory/transfers/new">New Internal Transfer</a>' : '';
    res.render('pages/list_page', {
      title: type ? TITLES[type] : 'Transfers',
      cp: { crumbs: [{ label: 'Inventory', href: '/inventory' }, { label: type ? TITLES[type] : 'All Transfers' }], list, views: ['list', 'kanban'], keep: type ? { type } : {}, actions },
      columns: [
        { label: 'Reference', value: (r) => r.number },
        { label: 'Type', value: (r) => stock.TYPE_LABEL[r.picking_type] },
        { label: 'From', value: (r) => r.src_code },
        { label: 'To', value: (r) => r.dest_code },
        { label: 'Contact', value: (r) => (r.partner_code ? `${r.partner_code} ${r.partner_name}` : '') },
        { label: 'Source Document', value: (r) => r.so_number || r.po_number || r.return_of_number || '' },
        { label: 'Backorder of', value: (r) => r.backorder_of_number || '' },
        { label: 'Qty', value: (r) => Number(r.qty_total), cls: 'num', sum: true },
        { label: 'Status', html: (r) => ui.badge(r.state) },
      ],
      href: (r) => `/inventory/pickings/${r.id}`,
      card: (r) => ({ title: r.number, subtitle: `${r.src_code} → ${r.dest_code} · ${r.so_number || r.po_number || ''}`, left: ui.badge(r.state), right: `${num(r.qty_total)} unit` }),
    });
  });

  app.get('/inventory/pickings/:id', ui.need('inventory.view'), async (req, res) => {
    res.locals.setApp('inventory');
    const pk = await stock.getPicking(Number(req.params.id));
    const related = [];
    if (pk.sale_order_id) related.push({ label: `Sales Order ${pk.so_number}`, href: `/sales/orders/${pk.sale_order_id}` });
    if (pk.purchase_order_id) related.push({ label: `Purchase Order ${pk.po_number}`, href: `/purchase/orders/${pk.purchase_order_id}` });
    if (pk.backorder_of_id) related.push({ label: `Backorder of ${pk.backorder_of_number}`, href: `/inventory/pickings/${pk.backorder_of_id}` });
    if (pk.return_of_id) related.push({ label: `Return of ${pk.return_of_number}`, href: `/inventory/pickings/${pk.return_of_id}` });
    for (const b of pk.backorders) related.push({ label: `Backorder ${b.number} (${ui.stateLabel(b.state)})`, href: `/inventory/pickings/${b.id}` });
    for (const r of pk.returns) related.push({ label: `Return ${r.number} (${ui.stateLabel(r.state)})`, href: `/inventory/pickings/${r.id}` });
    for (const e of pk.entries) related.push({ label: `Journal ${e.number} ${rp(e.total_debit)}`, href: `/accounting/entries/${e.id}` });
    for (const cn of pk.credit_notes) related.push({ label: `Credit Note ${cn.number || 'Draft'} ${rp(cn.amount_total)}`, href: `/invoicing/invoices/${cn.id}` });
    res.render('pages/picking_form', {
      title: pk.number, pk, stages: STATES[pk.picking_type],
      chatter: await loadChatter('stock.picking', pk.id, { numbers: [pk.number, ...pk.entries.map((e) => e.number)], related }),
    });
  });

  app.post('/inventory/pickings/:id/validate', ui.need('inventory.view'), async (req, res) => {
    const id = Number(req.params.id);
    const pk = await stock.getPicking(id);
    if (pk.picking_type === 'out') {
      const r = await stock.validateDelivery(ui.ctx(req), id, { done: ui.idMap(req.body.done), backorder: req.body.backorder !== 'no' });
      ui.flash(req, 'success', `${r.number} Done; COGS ${rp(r.cogsTotal)} diposting${r.backorder ? `; backorder ${r.backorder.number} dibuat` : ''}.`);
    } else if (pk.picking_type === 'in') {
      await stock.validateReceipt(ui.ctx(req), id);
      ui.flash(req, 'success', `${pk.number} Done; stok bertambah sebesar accepted quantity.`);
    } else if (pk.picking_type === 'int') {
      await stock.validateTransfer(ui.ctx(req), id);
      ui.flash(req, 'success', `${pk.number} Done; nilai stok perusahaan tidak berubah.`);
    } else {
      const r = await stock.validateReturn(ui.ctx(req), id);
      ui.flash(req, 'success', `${pk.number} Done${r.creditNote ? `; Credit Note draft ${rp(r.creditNote.total)} siap diposting Finance` : ''}.`);
    }
    res.redirect(`/inventory/pickings/${id}`);
  });

  app.post('/inventory/pickings/:id/qc', ui.need('inventory.view'), async (req, res) => {
    await stock.saveQualityCheck(ui.ctx(req), Number(req.params.id), ui.idMap(req.body.qc));
    ui.flash(req, 'success', 'Quality Check disimpan. Klik Validate untuk menambah stok sebesar accepted.');
    res.redirect(`/inventory/pickings/${req.params.id}`);
  });

  app.post('/inventory/pickings/:id/todo', ui.need('inventory.view'), async (req, res) => {
    await stock.confirmTransfer(ui.ctx(req), Number(req.params.id));
    ui.flash(req, 'success', 'Stok lokasi asal direservasi.');
    res.redirect(`/inventory/pickings/${req.params.id}`);
  });

  app.post('/inventory/pickings/:id/cancel', ui.need('inventory.view'), async (req, res) => {
    await stock.cancelPicking(ui.ctx(req), Number(req.params.id));
    ui.flash(req, 'success', 'Dokumen dibatalkan; reservasi dilepas.');
    res.redirect(`/inventory/pickings/${req.params.id}`);
  });

  app.get('/inventory/pickings/:id/return', ui.need('inventory.operate'), async (req, res) => {
    res.locals.setApp('inventory');
    const pk = await stock.getPicking(Number(req.params.id));
    res.render('pages/return_new', { title: `Return ${pk.number}`, pk });
  });

  app.post('/inventory/pickings/:id/return', ui.need('inventory.view'), async (req, res) => {
    const retId = await stock.createReturn(ui.ctx(req), Number(req.params.id), { ...ui.idMap(req.body.ret), note: req.body.note });
    ui.flash(req, 'success', 'Return Inspection dibuat. Validasi untuk mengembalikan stok dan membalik COGS.');
    res.redirect(`/inventory/pickings/${retId}`);
  });

  app.get('/inventory/transfers/new', ui.need('inventory.operate'), async (req, res) => {
    res.locals.setApp('inventory');
    const products = await db.query(`SELECT p.id, p.sku, p.name, p.size, p.uom, p.standard_cost AS price,
        SUM(CASE WHEN l.code = 'WH-PKU' THEN sq.on_hand - sq.reserved END) AS wh, SUM(CASE WHEN l.code = 'OUTLET-SUD' THEN sq.on_hand - sq.reserved END) AS outlet
      FROM products p JOIN stock_quants sq ON sq.product_id = p.id JOIN locations l ON l.id = sq.location_id GROUP BY p.id ORDER BY p.id`);
    res.render('pages/transfer_new', { title: 'New Internal Transfer', products: products.map((p) => ({ ...p, hint: `Avail WH ${p.wh} · Outlet ${p.outlet}` })) });
  });

  app.post('/inventory/transfers/new', ui.need('inventory.operate'), async (req, res) => {
    const id = await stock.createTransfer(ui.ctx(req), { srcCode: req.body.src, destCode: req.body.dest, lines: ui.parseLines(req.body, { productId: 'product_id', qty: 'qty' }), note: req.body.note });
    if (req.body.then === 'todo') {
      await stock.confirmTransfer(ui.ctx(req), id);
    }
    ui.flash(req, 'success', 'Internal Transfer dibuat.');
    res.redirect(`/inventory/pickings/${id}`);
  });

  app.get('/inventory/stock', ui.need('inventory.view'), async (req, res) => {
    res.locals.setApp('inventory');
    const st = await stock.stockOverview();
    const list = buildList(req, st.rows, {
      search: ['sku', 'name', 'location_code'],
      filters: [
        { key: 'wh', label: 'WH-PKU', group: 'loc', test: (r) => r.location_code === 'WH-PKU' },
        { key: 'outlet', label: 'OUTLET-SUD', group: 'loc', test: (r) => r.location_code === 'OUTLET-SUD' },
        { key: 'reserved', label: 'Ada reservasi', test: (r) => r.reserved > 0 },
      ],
      groupBys: [
        { key: 'location', label: 'Location', value: (r) => r.location_code },
        { key: 'product', label: 'Product', value: (r) => `${r.sku} ${r.name}` },
      ],
    });
    res.render('pages/list_page', {
      title: 'Stock',
      cp: { crumbs: [{ label: 'Inventory', href: '/inventory' }, { label: 'Stock & Valuation' }], list, actions: res.locals.perms['inventory.operate'] ? '<a class="btn btn-primary" href="/inventory/transfers/new">New Internal Transfer</a>' : '' },
      intro: `Available = On Hand − Reserved per SKU dan lokasi (SR-04). Total perusahaan: <b>${num(st.totals.on_hand)} unit</b>, valuasi standard cost <b>${rp(st.totals.value)}</b>.`,
      columns: [
        { label: 'SKU', value: (r) => r.sku },
        { label: 'Product', value: (r) => `${r.name} ${r.size}` },
        { label: 'Location', value: (r) => r.location_code },
        { label: 'On Hand', value: (r) => r.on_hand, cls: 'num', sum: true },
        { label: 'Reserved', value: (r) => r.reserved, cls: 'num', sum: true },
        { label: 'Available', value: (r) => Number(r.available), cls: 'num', sum: true },
        { label: 'Standard Value', value: (r) => r.value, html: (r) => rp(r.value), cls: 'num', sum: true, fmt: 'money' },
      ],
      href: (r) => `/products/${r.product_id}`,
    });
  });

  app.get('/inventory/moves', ui.need('inventory.view'), async (req, res) => {
    res.locals.setApp('inventory');
    const rows = await db.query(`SELECT m.*, p.sku, p.name, s.code AS src_code, d.code AS dest_code, pk.number AS picking_number, pk.picking_type
      FROM stock_moves m JOIN products p ON p.id = m.product_id JOIN locations s ON s.id = m.src_location_id JOIN locations d ON d.id = m.dest_location_id
      LEFT JOIN pickings pk ON pk.id = m.picking_id WHERE m.state = 'done' ORDER BY m.done_at DESC, m.id DESC`);
    const list = buildList(req, rows, {
      search: ['sku', 'picking_number', 'ref', 'src_code', 'dest_code'],
      filters: [
        { key: 'noopening', label: 'Tanpa opening stock', test: (r) => r.ref !== 'Opening stock (baseline)' },
        { key: 'out', label: 'Delivery', group: 't', test: (r) => r.picking_type === 'out' },
        { key: 'in', label: 'Receipt', group: 't', test: (r) => r.picking_type === 'in' },
        { key: 'int', label: 'Internal', group: 't', test: (r) => r.picking_type === 'int' },
        { key: 'ret', label: 'Return', group: 't', test: (r) => r.picking_type === 'ret' },
      ],
      groupBys: [{ key: 'product', label: 'Product', value: (r) => r.sku }, { key: 'ref', label: 'Reference', value: (r) => r.picking_number || r.ref }],
      defaultFilters: ['noopening'],
    });
    res.render('pages/list_page', {
      title: 'Moves History',
      cp: { crumbs: [{ label: 'Inventory', href: '/inventory' }, { label: 'Moves History (Done)' }], list },
      columns: [
        { label: 'Date', value: (r) => String(r.done_at || '').slice(0, 16) },
        { label: 'Reference', value: (r) => r.picking_number || r.ref || '' },
        { label: 'SKU', value: (r) => r.sku },
        { label: 'From', value: (r) => r.src_code },
        { label: 'To', value: (r) => (r.picking_type === 'ret' && r.qty_damaged ? `${r.dest_code} (rusak ${r.qty_damaged} → DAMAGED)` : r.dest_code) },
        { label: 'Qty Done', value: (r) => r.qty_done, cls: 'num' },
        { label: 'Accepted/Rejected', value: (r) => (r.qty_received ? `${r.qty_accepted}/${r.qty_rejected}` : ''), cls: 'num' },
        { label: 'Unit Cost', value: (r) => rp(r.unit_cost), cls: 'num' },
        { label: 'Value', value: (r) => r.value, html: (r) => rp(r.value), cls: 'num', sum: true, fmt: 'money' },
      ],
      href: (r) => (r.picking_id ? `/inventory/pickings/${r.picking_id}` : null),
    });
  });

  app.get('/inventory/locations', ui.need('inventory.view'), async (req, res) => {
    res.locals.setApp('inventory');
    const rows = await db.query('SELECT * FROM locations ORDER BY id');
    const list = buildList(req, rows, { search: ['code', 'name'], groupBys: [{ key: 'usage', label: 'Usage', value: (r) => r.usage_type }] });
    res.render('pages/list_page', {
      title: 'Locations',
      cp: { crumbs: [{ label: 'Inventory', href: '/inventory' }, { label: 'Locations' }], list },
      columns: [{ label: 'Code', value: (r) => r.code }, { label: 'Name', value: (r) => r.name }, { label: 'Type', value: (r) => r.loc_type }, { label: 'Usage', value: (r) => r.usage_type }, { label: 'City', value: (r) => r.city || '' }],
      href: null,
    });
  });
};
