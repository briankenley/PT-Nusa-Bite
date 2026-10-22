'use strict';
const ui = require('../lib/ui');
const db = require('../db');
const { can } = require('../lib/acl');
const { buildList } = require('../lib/listview');
const { rp, num } = require('../lib/money');
const products = require('../services/products');
const { loadChatter } = require('./_chatter');

const formData = (b) => ({
  sku: b.sku, name: b.name, size: b.size, color: b.color, uom: b.uom,
  sales_price: b.sales_price, standard_cost: b.standard_cost, default_vendor_id: b.default_vendor_id || null,
});

module.exports = (app) => {
  app.get('/products', ui.need('products.view'), async (req, res) => {
    res.locals.setApp(req.query.app || 'inventory');
    const rows = await products.listProducts();
    const list = buildList(req, rows, {
      search: ['sku', 'name', 'size', 'color', 'vendor_code'],
      filters: [
        { key: 'food', label: 'Makanan (porsi)', group: 'uom', test: (r) => r.uom === 'porsi' },
        { key: 'drink', label: 'Minuman (gelas/kaleng/botol)', group: 'uom', test: (r) => ['gelas', 'kaleng', 'botol'].includes(r.uom) },
        { key: 'cup', label: 'Cup (saus/es krim)', group: 'uom', test: (r) => r.uom === 'cup' },
        { key: 'low', label: 'Available outlet < 15', test: (r) => r.outlet_on_hand < 15 },
      ],
      groupBys: [
        { key: 'vendor', label: 'Default Vendor', value: (r) => `${r.vendor_code} ${r.vendor_name}` },
        { key: 'name', label: 'Product', value: (r) => r.name },
        { key: 'uom', label: 'Unit', value: (r) => r.uom },
      ],
      views: ['list', 'kanban'],
    });
    res.render('pages/list_page', {
      title: 'Products',
      cp: { crumbs: [{ label: 'Products (Variant SKU)' }], list, views: ['list', 'kanban'], actions: can(req.user.role, 'products.edit') ? '<a class="btn btn-primary" href="/products/new">New</a>' : '' },
      columns: [
        { label: 'SKU', value: (r) => r.sku },
        { label: 'Name', value: (r) => r.name },
        { label: 'Size', value: (r) => r.size },
        { label: 'Color', value: (r) => r.color },
        { label: 'Unit', value: (r) => r.uom },
        { label: 'Sales Price', value: (r) => rp(r.sales_price), cls: 'num' },
        { label: 'Cost', value: (r) => rp(r.standard_cost), cls: 'num' },
        { label: 'WH-PKU', value: (r) => r.wh_on_hand, cls: 'num', sum: true },
        { label: 'OUTLET-SUD', value: (r) => r.outlet_on_hand, cls: 'num', sum: true },
        { label: 'Reserved', value: (r) => r.reserved, cls: 'num', sum: true },
        { label: 'Stock Value', value: (r) => r.value, html: (r) => rp(r.value), cls: 'num', sum: true, fmt: 'money' },
      ],
      href: (r) => `/products/${r.id}`,
      card: (r) => ({ title: `${r.sku}`, subtitle: `${r.name} · ${r.size} · ${r.color} · ${r.uom}`, left: rp(r.sales_price), right: `On hand ${num(r.on_hand)}` }),
    });
  });

  const vendors = () => db.query('SELECT id, code, name FROM partners WHERE is_vendor = 1 ORDER BY code');

  app.get('/products/new', ui.need('products.edit'), async (req, res) => {
    res.locals.setApp('inventory');
    res.render('pages/product_form', {
      title: 'New Product', isNew: true, p: { sku: '', name: '', size: '', color: '', uom: 'porsi', sales_price: 0, standard_cost: 0, quants: [], pricelist: [], moves: [] },
      vendors: await vendors(), canEdit: true, canPrice: can(req.user.role, 'products.edit_price'), chatter: null,
    });
  });

  app.post('/products/new', ui.need('products.edit'), async (req, res) => {
    const d = formData(req.body);
    if (!can(req.user.role, 'products.edit_price')) { if (!Number(d.sales_price)) delete d.sales_price; if (!Number(d.standard_cost)) delete d.standard_cost; }
    const id = await products.createProduct(ui.ctx(req), d);
    ui.flash(req, 'success', 'Variant SKU dibuat.');
    res.redirect(`/products/${id}`);
  });

  app.get('/products/:id', ui.need('products.view'), async (req, res) => {
    res.locals.setApp('inventory');
    const p = await products.getProduct(Number(req.params.id));
    res.render('pages/product_form', {
      title: p.sku, isNew: false, p, vendors: await vendors(),
      canEdit: can(req.user.role, 'products.edit'), canPrice: can(req.user.role, 'products.edit_price'),
      chatter: await loadChatter('product', p.id, { numbers: [p.sku], related: [{ label: `Moves (${p.moves.length})`, href: `/inventory/moves?q=${p.sku}` }] }),
    });
  });

  app.post('/products/:id', ui.need('products.edit'), async (req, res) => {
    const d = formData(req.body);
    if (req.body.sales_price === undefined) delete d.sales_price;
    if (req.body.standard_cost === undefined) delete d.standard_cost;
    await products.updateProduct(ui.ctx(req), Number(req.params.id), d);
    ui.flash(req, 'success', 'Produk disimpan.');
    res.redirect(`/products/${req.params.id}`);
  });
};
