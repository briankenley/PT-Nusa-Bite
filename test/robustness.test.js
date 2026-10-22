'use strict';
/**
 * Uji ketahanan: permintaan bersamaan (race condition) dan regresi parsing form.
 * Aturan bisnis harus tetap berlaku walaupun dua pengguna menekan tombol pada saat yang sama.
 */
const { test, after, beforeEach } = require('node:test');
const qs = require('qs');
const h = require('./helpers');
const flows = require('./flows');
const { assert, db } = h;
const sales = require('../src/services/sales');
const purchase = require('../src/services/purchase');
const invoicing = require('../src/services/invoicing');
const { idMap } = require('../src/lib/ui');
const { computeLine } = require('../src/lib/money');

beforeEach(async () => { await h.fresh(); });
after(async () => { await db.closePool(); });

test('Race SR-04: dua SO 10 BRG-REG dikonfirmasi bersamaan (Available 14) → tepat satu berhasil', async () => {
  const s = await h.ctx('sales');
  const mk = async () => sales.createOrder(s, { partnerId: await h.partnerId('C02'), lines: [{ productId: await h.productId('BRG-REG'), qty: 10 }] });
  const [a, b] = [await mk(), await mk()];
  const results = await Promise.allSettled([sales.confirmOrder(s, a), sales.confirmOrder(s, b)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.rule, 'SR-04');
  assert.deepEqual(await h.quant('BRG-REG', 'OUTLET-SUD'), { onHand: 18, reserved: 14, available: 4 });
});

test('Race SR-12: dua permintaan Post invoice bersamaan → satu jurnal', async () => {
  const r = await flows.T11();
  const f = await h.ctx('finance');
  const invId = await invoicing.createInvoiceFromSale(f, r.soId);
  const results = await Promise.allSettled([invoicing.postInvoice(f, invId), invoicing.postInvoice(f, invId)]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal((await db.one('SELECT COUNT(*) c FROM journal_entries WHERE event_key = ?', [`invoice:${invId}:post`])).c, 1);
  assert.equal(await h.balance('110'), 3300000 + 127600);
});

test('Race SR-20: dua pembayaran Rp100.000 bersamaan atas invoice Rp127.600 → satu ditolak', async () => {
  const r = await flows.T19();
  const f = await h.ctx('finance');
  const results = await Promise.allSettled([
    invoicing.registerPayment(f, r.invoiceId, { amount: 100000 }),
    invoicing.registerPayment(f, r.invoiceId, { amount: 100000 }),
  ]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(results.find((x) => x.status === 'rejected').reason.rule, 'SR-20');
  assert.equal((await invoicing.getInvoice(r.invoiceId)).amount_residual, 27600);
});

test('Race SR-12: lima RFQ dibuat bersamaan mendapat nomor unik berurutan', async () => {
  const w = await h.ctx('warehouse');
  const vendor = await h.partnerId('V03');
  const product = await h.productId('ICE-TEA');
  const ids = await Promise.all(Array.from({ length: 5 }, () => purchase.createRFQ(w, { partnerId: vendor, lines: [{ productId: product, qty: 1 }] })));
  const numbers = (await db.query(`SELECT number FROM purchase_orders WHERE id IN (${ids.join(',')}) ORDER BY number`)).map((r) => r.number);
  assert.deepEqual(numbers, ['PO00008', 'PO00009', 'PO00010', 'PO00011', 'PO00012']);
});

test('Regresi form: qs memadatkan kunci angka menjadi array; form memakai prefix sehingga ID baris terjaga', () => {
  // Inilah bug yang ditemukan lewat uji UI: done[3]=1 kehilangan ID 3.
  assert.deepEqual(qs.parse('done[3]=1'), { done: ['1'] });
  const parsed = qs.parse('done[m3]=1&done[m27]=5');
  assert.deepEqual(idMap(parsed.done), { 3: '1', 27: '5' });
  assert.deepEqual(idMap(['1', '2']), {});
});

test('PBJT dibulatkan per baris: 10% × harga setelah diskon × kuantitas', () => {
  assert.deepEqual(computeLine({ unitPrice: 28000, qty: 3, discountPct: 12, taxRatePct: 10 }), { subtotal: 73920, tax: 7392, total: 81312 });
  assert.deepEqual(computeLine({ unitPrice: 23000, qty: 1, taxRatePct: 10 }), { subtotal: 23000, tax: 2300, total: 25300 });
  // 7.000 × 3 × 97,5% = 20.475 → pajak 2.047,5 dibulatkan ke 2.048
  assert.deepEqual(computeLine({ unitPrice: 7000, qty: 3, discountPct: 2.5, taxRatePct: 10 }), { subtotal: 20475, tax: 2048, total: 22523 });
});

test('F-23 (optional): saran pembelian = rerata 7 hari × cakupan − Available − incoming', async () => {
  const counter = require('../src/services/counter');
  const reorder = require('../src/services/reorder');
  await counter.checkout(await h.ctx('cashier'), { lines: [{ productId: await h.productId('NUG-6'), qty: 10 }] });
  const rows = await reorder.suggestions({ coverDays: 30 });
  const nug = rows.find((r) => r.sku === 'NUG-6');
  // terjual 10 → rerata 1,43/hari → target ceil(1,43 × 30) = 43; Available 32 + 4 = 36; incoming 0 → saran 7
  assert.deepEqual([nug.net, nug.avg, nug.target, nug.available, nug.suggest], [10, 1.43, 43, 36, 7]);
  const fry = rows.find((r) => r.sku === 'FRY-SML');
  assert.equal(fry.incoming, 20); // PO00007 belum diterima dihitung sebagai barang dalam perjalanan
});
