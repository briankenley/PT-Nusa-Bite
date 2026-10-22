'use strict';
// Prasyarat berantai sesuai handout ("After T-xx"): setiap tes memulai dari baseline lalu menjalankan prasyaratnya.
const h = require('./helpers');
const sales = require('../src/services/sales');
const stock = require('../src/services/stock');
const purchase = require('../src/services/purchase');
const invoicing = require('../src/services/invoicing');

async function T09() {
  const s = await h.ctx('sales');
  const soId = await sales.createOrder(s, {
    partnerId: await h.partnerId('C03'),
    lines: [{ productId: await h.productId('BRG-REG'), qty: 3 }, { productId: await h.productId('FRY-SML'), qty: 2 }],
  });
  const res = await sales.confirmOrder(s, soId);
  return { soId, pickingId: res.picking.id };
}

async function T11() {
  const r = await T09();
  await stock.validateDelivery(await h.ctx('warehouse'), r.pickingId);
  return r;
}

async function T19() {
  const r = await T11();
  const f = await h.ctx('finance');
  const invoiceId = await invoicing.createInvoiceFromSale(f, r.soId);
  await invoicing.postInvoice(f, invoiceId);
  return { ...r, invoiceId };
}

async function T23() {
  const r = await T19();
  await invoicing.registerPayment(await h.ctx('finance'), r.invoiceId, { amount: 60000, method: 'bank' });
  return r;
}

async function T27() {
  const r = await T23();
  const w = await h.ctx('warehouse');
  const pk = await stock.getPicking(r.pickingId);
  const brg = pk.moves.find((m) => m.sku === 'BRG-REG');
  const retId = await stock.createReturn(w, r.pickingId, { [brg.id]: { qty: 1, sellable: 1, damaged: 0 } });
  const res = await stock.validateReturn(w, retId);
  await invoicing.postInvoice(await h.ctx('finance'), res.creditNote.id);
  return { ...r, retId, creditNoteId: res.creditNote.id, brgMoveId: brg.id };
}

async function T12() {
  const s = await h.ctx('sales');
  const soId = await sales.createOrder(s, { partnerId: await h.partnerId('C03'), lines: [{ productId: await h.productId('BRG-REG'), qty: 5 }] });
  const { picking } = await sales.confirmOrder(s, soId);
  const pk = await stock.getPicking(picking.id);
  const res = await stock.validateDelivery(await h.ctx('warehouse'), picking.id, { done: { [pk.moves[0].id]: 3 } });
  return { soId, pickingId: picking.id, backorder: res.backorder };
}

async function T15() {
  const w = await h.ctx('warehouse');
  const poId = await purchase.createRFQ(w, { partnerId: await h.partnerId('V02'), lines: [{ productId: await h.productId('FRY-SML'), qty: 20 }] });
  const { receipt } = await purchase.confirmPO(w, poId);
  return { poId, receiptId: receipt.id };
}

async function T17() {
  const r = await T15();
  const w = await h.ctx('warehouse');
  const pk = await stock.getPicking(r.receiptId);
  await stock.saveQualityCheck(w, r.receiptId, { [pk.moves[0].id]: { received: 20, accepted: 15, rejected: 5 } });
  await stock.validateReceipt(w, r.receiptId);
  return { ...r, moveId: pk.moves[0].id };
}

module.exports = { T09, T11, T12, T15, T17, T19, T23, T27 };
