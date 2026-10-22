'use strict';
const ui = require('../lib/ui');
const db = require('../db');
const counter = require('../services/counter');
const sales = require('../services/sales');
const invoicing = require('../services/invoicing');

module.exports = (app) => {
  app.get('/counter', ui.need('counter.use'), async (req, res) => {
    res.locals.setApp('sales');
    const products = await db.query(`SELECT p.id, p.sku, p.name, p.size, p.uom, p.sales_price, sq.on_hand, sq.reserved, (sq.on_hand - sq.reserved) AS available
      FROM products p JOIN stock_quants sq ON sq.product_id = p.id JOIN locations l ON l.id = sq.location_id AND l.code = 'OUTLET-SUD'
      WHERE p.active = 1 ORDER BY p.id`);
    const recent = await db.query(`SELECT o.id, o.number, o.amount_total, o.created_at, i.number AS invoice_number FROM sale_orders o
      LEFT JOIN invoices i ON i.sale_order_id = o.id AND i.move_type = 'out_invoice' WHERE o.is_counter = 1 ORDER BY o.id DESC LIMIT 8`);
    res.render('pages/counter', { title: 'Quick Counter Order', products, recent });
  });

  app.post('/counter/checkout', ui.need('counter.use'), async (req, res) => {
    const lines = ui.parseLines(req.body, { productId: 'product_id', qty: 'qty' });
    const r = await counter.checkout(ui.ctx(req), { lines, method: req.body.method === 'bank' ? 'bank' : 'cash', cashReceived: req.body.cash_received });
    ui.flash(req, 'success', `Pembayaran diterima: ${r.number} → ${r.invoiceNumber} → ${r.paymentNumber}.`);
    res.redirect(`/counter/receipt/${r.orderId}${r.change ? `?change=${r.change}` : ''}`);
  });

  app.get('/counter/receipt/:id', ui.need('counter.use'), async (req, res) => {
    res.locals.setApp('sales');
    const o = await sales.getOrder(Number(req.params.id));
    const inv = o.invoices.find((i) => i.move_type === 'out_invoice');
    const invoice = inv ? await invoicing.getInvoice(inv.id) : null;
    res.render('pages/counter_receipt', { title: `Struk ${invoice ? invoice.number : o.number}`, o, invoice, change: Number(req.query.change || 0) });
  });
};
