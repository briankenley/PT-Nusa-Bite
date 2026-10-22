'use strict';
const { q1 } = require('../db');
const { run } = require('../lib/action');
const { requirePerm } = require('../lib/acl');
const { BusinessError } = require('../lib/errors');
const { rp, toInt } = require('../lib/money');
const audit = require('../lib/audit');
const policies = require('../policies');
const sales = require('./sales');
const stock = require('./stock');
const invoicing = require('./invoicing');

/**
 * Quick Counter Order (SR-14): pesanan kasir yang dibayar menghasilkan Sales Order, Delivery Done,
 * Customer Invoice (struk) dengan PBJT 10%, pembayaran, jurnal, dan pengurangan stok
 * dalam SATU transaksi database. Bila satu langkah gagal (mis. stok kurang, SR-04), semuanya dibatalkan.
 * Ini alur ringkas di modul Sales, bukan aplikasi Point of Sale.
 */
async function checkout(ctx, { lines, method = 'cash', cashReceived }) {
  return run(ctx, { action: 'COUNTER_CHECKOUT', docType: 'sale.order' }, async (conn) => {
    requirePerm(ctx, 'counter.use');
    const walkin = await q1(conn, "SELECT id FROM partners WHERE code = 'WALKIN'");
    const clean = (lines || []).filter((l) => l.productId && toInt(l.qty, 0) > 0).map((l) => ({ productId: l.productId, qty: l.qty }));
    if (!clean.length) throw new BusinessError('Pilih minimal satu produk dengan kuantitas > 0.', { rule: 'SR-14' });
    const order = await sales._createOrder(conn, ctx, {
      partnerId: walkin.id, locationCode: policies.SALES_LOCATION, lines: clean, isCounter: true, note: 'Quick Counter Order',
    });
    if (cashReceived !== undefined && cashReceived !== '' && toInt(cashReceived, 0) < order.totals.total) {
      throw new BusinessError(`Uang diterima ${rp(toInt(cashReceived, 0))} kurang dari total ${rp(order.totals.total)}.`, { rule: 'SR-14', docNumber: order.number });
    }
    // SR-04 berlaku penuh (keputusan D-02): stok outlet harus tersedia; tidak ada pengecualian < Rp100.000.
    const { picking } = await sales._confirm(conn, ctx, order.id, { skipCredit: true });
    const delivery = await stock._validateDelivery(conn, ctx, picking.id, {});
    const invoiceId = await invoicing._createFromSale(conn, ctx, order.id);
    const posted = await invoicing._postInvoice(conn, ctx, invoiceId);
    const payment = await invoicing._registerPayment(conn, ctx, invoiceId, { amount: order.totals.total, method, memo: 'Quick Counter' });
    const change = cashReceived !== undefined && cashReceived !== '' ? toInt(cashReceived, 0) - order.totals.total : 0;
    await audit.log(conn, ctx, {
      action: 'COUNTER_CHECKOUT', docType: 'sale.order', docId: order.id, docNumber: order.number,
      message: `Quick Counter ${rp(order.totals.total)} (${method}): ${picking.number} Done, ${posted.number} Posted, ${payment.number}`,
      detail: { delivery: picking.number, invoice: posted.number, payment: payment.number, cogs: delivery.cogsTotal },
    });
    await audit.note(conn, ctx, 'sale.order', order.id, `Quick Counter Order dibayar ${method === 'cash' ? 'tunai' : 'bank'} ${rp(order.totals.total)}; struk ${posted.number}.`);
    return { orderId: order.id, number: order.number, invoiceId, invoiceNumber: posted.number, paymentNumber: payment.number, total: order.totals.total, change };
  });
}

module.exports = { checkout };
