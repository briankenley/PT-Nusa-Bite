'use strict';
/**
 * Pengujian T-01 s.d. T-38 (Bagian 7 handout) pada lapisan layanan + database MySQL nyata.
 * Setiap tes dimulai dari baseline seed segar (fixture), lalu menjalankan prasyarat "After T-xx".
 */
const { test, after, beforeEach } = require('node:test');
const h = require('./helpers');
const flows = require('./flows');
const { assert, db } = h;
const { permsFor, requirePerm } = require('../src/lib/acl');
const { AccessError } = require('../src/lib/errors');
const contacts = require('../src/services/contacts');
const products = require('../src/services/products');
const crm = require('../src/services/crm');
const sales = require('../src/services/sales');
const stock = require('../src/services/stock');
const purchase = require('../src/services/purchase');
const invoicing = require('../src/services/invoicing');
const accounting = require('../src/services/accounting');
const employees = require('../src/services/employees');
const payroll = require('../src/services/payroll');
const counter = require('../src/services/counter');
const dashboard = require('../src/services/dashboard');
const auditsvc = require('../src/services/auditsvc');

beforeEach(async () => { await h.fresh(); });
after(async () => { await db.closePool(); });

test('Baseline: 773 unit Rp5.422.000, saldo pembuka seimbang Rp43.722.000, S00007 reserved 4', async () => {
  assert.deepEqual(await h.totalStock(), { units: 773, value: 5422000 });
  assert.equal(await h.trialBalanced(), true);
  assert.equal(await h.balance('101'), 10000000);
  assert.equal(await h.balance('102'), 25000000);
  assert.equal(await h.balance('110'), 3300000);
  assert.equal(await h.balance('201'), -1500000);
  assert.deepEqual(await h.quant('BRG-REG', 'OUTLET-SUD'), { onHand: 18, reserved: 4, available: 14 });
});

test('T-01 Sales melihat Sales/CRM sesuai peran', async () => {
  const p = permsFor('sales');
  assert.equal(p['sales.view'], true);
  assert.equal(p['crm.view'], true);
  assert.equal(p['accounting.view'], false);
  assert.equal(p['employees.view'], false);
});

test('T-02 Sales mengakses Journal Entries ditolak (SR-13)', async () => {
  const s = await h.ctx('sales');
  assert.throws(() => requirePerm(s, 'accounting.view'), AccessError);
});

test('T-03 Kontak C03: limit Rp2.000.000, NET14, tanpa pergerakan saldo', async () => {
  const c = await contacts.getContact(await h.partnerId('C03'));
  assert.equal(c.credit_limit, 2000000);
  assert.equal(c.payment_term_code, 'NET14');
  assert.equal(c.exposure.ar, 0);
  assert.equal(c.exposure.exposure, 0);
});

test('T-04 Simpan kontak baru dengan ID C03 ditolak (SR-12) dan tercatat', async () => {
  const s = await h.ctx('sales');
  const err = await h.rejects(contacts.createContact(s, { code: 'C03', name: 'Duplikat', partner_type: 'company', is_customer: 1 }), 'SR-12');
  assert.match(err.message, /C03 sudah dipakai/);
  const log = await h.lastAudit('CONTACT_CREATE');
  assert.equal(log.result, 'rejected');
  assert.equal(log.doc_number, 'C03');
  const n = await db.one("SELECT COUNT(*) c FROM partners WHERE code = 'C03'");
  assert.equal(n.c, 1);
});

test('T-05 FRY-SML vs FRY-LRG: Rp16.000/Rp24.000, biaya Rp6.000/Rp9.000, unit porsi', async () => {
  const sml = await products.getProduct(await h.productId('FRY-SML'));
  const lrg = await products.getProduct(await h.productId('FRY-LRG'));
  assert.deepEqual([sml.sales_price, sml.standard_cost, sml.uom, sml.size], [16000, 6000, 'porsi', 'Small']);
  assert.deepEqual([lrg.sales_price, lrg.standard_cost, lrg.uom, lrg.size], [24000, 9000, 'porsi', 'Large']);
});

test('T-06 Buat ulang SKU FRY-SML / kombinasi sama ditolak (SR-21)', async () => {
  const w = await h.ctx('owner');
  await h.rejects(products.createProduct(w, { sku: 'FRY-SML', name: 'Kentang goreng', size: 'Small', color: 'Kuning', uom: 'porsi' }), 'SR-21');
  const err = await h.rejects(products.createProduct(w, { sku: 'FRY-SML2', name: 'Kentang goreng', size: 'Small', color: 'Kuning', uom: 'porsi' }), 'SR-21');
  assert.match(err.message, /FRY-SML/);
  assert.equal((await db.one("SELECT COUNT(*) c FROM products WHERE name = 'Kentang goreng' AND size = 'Small'")).c, 1);
});

test('T-07 Konversi L00007 sekali: tepat satu Opportunity, stok/jurnal tidak berubah', async () => {
  const s = await h.ctx('sales');
  const leadId = await h.id('crm_leads', 'number', 'L00007');
  const before = { stock: await h.totalStock(), je: (await db.one('SELECT COUNT(*) c FROM journal_entries')).c };
  const oppId = await crm.convertLead(s, leadId);
  const lead = await crm.getLead(leadId);
  assert.equal(lead.state, 'converted');
  assert.equal(lead.opportunity.id, oppId);
  assert.equal((await db.one('SELECT COUNT(*) c FROM crm_opportunities WHERE lead_id = ?', [leadId])).c, 1);
  assert.deepEqual(await h.totalStock(), before.stock);
  assert.equal((await db.one('SELECT COUNT(*) c FROM journal_entries')).c, before.je);
});

test('T-08 Ulangi konversi L00007 ditolak (SR-22), tidak ada Opportunity kedua', async () => {
  const s = await h.ctx('sales');
  const leadId = await h.id('crm_leads', 'number', 'L00007');
  await crm.convertLead(s, leadId);
  await h.rejects(crm.convertLead(s, leadId), 'SR-22');
  assert.equal((await db.one('SELECT COUNT(*) c FROM crm_opportunities')).c, 1);
});

test('T-09 SO C03 3 BRG-REG + 2 FRY-SML: S00008, subtotal 116.000, PBJT 11.600, total 127.600, reservasi', async () => {
  const { soId } = await flows.T09();
  const so = await sales.getOrder(soId);
  assert.equal(so.number, 'S00008');
  assert.equal(so.state, 'sale');
  assert.deepEqual([so.amount_untaxed, so.amount_tax, so.amount_total], [116000, 11600, 127600]);
  assert.deepEqual(so.lines.map((l) => [l.sku, l.unit_price, l.subtotal]), [['BRG-REG', 28000, 84000], ['FRY-SML', 16000, 32000]]);
  assert.deepEqual(await h.quant('BRG-REG', 'OUTLET-SUD'), { onHand: 18, reserved: 7, available: 11 });
  assert.deepEqual(await h.quant('FRY-SML', 'OUTLET-SUD'), { onHand: 25, reserved: 2, available: 23 });
});

test('T-10 C01 (AR 550.000 + SO 123.200) pesan 127.600 → exposure 800.800 > 800.000 diblokir (SR-09)', async () => {
  const s = await h.ctx('sales');
  const soId = await sales.createOrder(s, {
    partnerId: await h.partnerId('C01'),
    lines: [{ productId: await h.productId('BRG-REG'), qty: 3 }, { productId: await h.productId('FRY-SML'), qty: 2 }],
  });
  const err = await h.rejects(sales.confirmOrder(s, soId), 'SR-09');
  assert.equal(err.detail.ar, 550000);
  assert.equal(err.detail.uninvoiced, 123200);
  assert.equal(err.detail.exposure, 800800);
  assert.equal((await sales.getOrder(soId)).state, 'draft');
  assert.deepEqual(await h.quant('BRG-REG', 'OUTLET-SUD'), { onHand: 18, reserved: 4, available: 14 });
});

test('T-11 Validasi pengiriman lengkap S00008: BRG outlet 18→15, FRY 25→23, COGS 48.000', async () => {
  await flows.T11();
  assert.equal((await h.quant('BRG-REG', 'OUTLET-SUD')).onHand, 15);
  assert.equal((await h.quant('FRY-SML', 'OUTLET-SUD')).onHand, 23);
  assert.equal(await h.balance('501'), 48000);
  assert.equal(await h.balance('120'), 5422000 - 48000);
  const pk = await db.one("SELECT state FROM pickings WHERE number = 'WH/OUT/00008'");
  assert.equal(pk.state, 'done');
});

test('T-12 SO 5 BRG-REG kirim 3: backorder 2 tetap tereservasi (SR-02, SR-04)', async () => {
  const { soId, backorder } = await flows.T12();
  assert.ok(backorder);
  const bo = await stock.getPicking(backorder.id);
  assert.equal(bo.state, 'ready');
  assert.equal(bo.moves[0].qty_demand, 2);
  assert.equal(bo.moves[0].qty_reserved, 2);
  const so = await sales.getOrder(soId);
  assert.equal(so.lines[0].qty_delivered, 3);
  assert.deepEqual(await h.quant('BRG-REG', 'OUTLET-SUD'), { onHand: 15, reserved: 6, available: 9 });
});

test('T-13 Transfer 5 FRY-SML WH-PKU → OUTLET-SUD: 40→35, 25→30, total 65 dan nilai tetap', async () => {
  const w = await h.ctx('warehouse');
  const before = await h.totalStock();
  const jeBefore = (await db.one('SELECT COUNT(*) c FROM journal_entries')).c;
  const tid = await stock.createTransfer(w, { srcCode: 'WH-PKU', destCode: 'OUTLET-SUD', lines: [{ productId: await h.productId('FRY-SML'), qty: 5 }] });
  await stock.confirmTransfer(w, tid);
  await stock.validateTransfer(w, tid);
  assert.equal((await h.quant('FRY-SML', 'WH-PKU')).onHand, 35);
  assert.equal((await h.quant('FRY-SML', 'OUTLET-SUD')).onHand, 30);
  assert.deepEqual(await h.totalStock(), before);
  assert.equal((await db.one('SELECT COUNT(*) c FROM journal_entries')).c, jeBefore);
});

test('T-14 Alokasi 16 BRG-REG dari OUTLET-SUD saat Available 14 ditolak (SR-03/SR-04)', async () => {
  const s = await h.ctx('sales');
  const soId = await sales.createOrder(s, { partnerId: await h.partnerId('C02'), lines: [{ productId: await h.productId('BRG-REG'), qty: 16 }] });
  const err = await h.rejects(sales.confirmOrder(s, soId), 'SR-04');
  assert.equal(err.detail.available, 14);
  assert.deepEqual(await h.quant('BRG-REG', 'OUTLET-SUD'), { onHand: 18, reserved: 4, available: 14 });
  // Transfer yang melewati Available juga ditolak.
  const w = await h.ctx('warehouse');
  const tid = await stock.createTransfer(w, { srcCode: 'OUTLET-SUD', destCode: 'WH-PKU', lines: [{ productId: await h.productId('BRG-REG'), qty: 15 }] });
  await h.rejects(stock.confirmTransfer(w, tid), 'SR-04');
});

test('T-15 PO baru 20 FRY-SML ke V02: PO00008 Rp120.000; stok dan AP belum berubah', async () => {
  const { poId } = await flows.T15();
  const po = await purchase.getOrder(poId);
  assert.equal(po.number, 'PO00008');
  assert.equal(po.amount_total, 120000);
  assert.equal(po.state, 'purchase');
  assert.equal((await h.quant('FRY-SML', 'WH-PKU')).onHand, 40);
  assert.equal(await h.balance('201'), -1500000);
});

test('T-16 Menimpa nomor PO baru dengan PO00007 ditolak (SR-12)', async () => {
  const w = await h.ctx('warehouse');
  const poId = await purchase.createRFQ(w, { partnerId: await h.partnerId('V02'), lines: [{ productId: await h.productId('FRY-SML'), qty: 20 }] });
  const err = await h.rejects(purchase.updateRFQ(w, poId, { number: 'PO00007', lines: [{ productId: await h.productId('FRY-SML'), qty: 20 }] }), 'SR-12');
  assert.match(err.message, /PO00007/);
  assert.equal((await purchase.getOrder(poId)).number, 'PO00008');
  const second = await purchase.createRFQ(w, { partnerId: await h.partnerId('V01'), lines: [{ productId: await h.productId('BRG-REG'), qty: 1 }] });
  assert.equal((await purchase.getOrder(second)).number, 'PO00009');
});

test('T-17 20 datang, accepted 15, rejected 5: WH FRY-SML 40→55, valuasi +90.000, GRNI 90.000', async () => {
  await flows.T17();
  assert.equal((await h.quant('FRY-SML', 'WH-PKU')).onHand, 55);
  assert.deepEqual(await h.totalStock(), { units: 788, value: 5512000 });
  assert.equal(await h.balance('125'), -90000);
  const pol = await db.one("SELECT l.qty_received, l.qty_rejected FROM purchase_order_lines l JOIN purchase_orders o ON o.id = l.order_id WHERE o.number = 'PO00008'");
  assert.deepEqual([pol.qty_received, pol.qty_rejected], [15, 5]);
});

test('T-18 Menambah stok 20 tanpa mengubah 5 rejected ditolak (SR-19)', async () => {
  const r = await flows.T15();
  const w = await h.ctx('warehouse');
  const pk = await stock.getPicking(r.receiptId);
  await h.rejects(stock.saveQualityCheck(w, r.receiptId, { [pk.moves[0].id]: { received: 20, accepted: 20, rejected: 5 } }), 'SR-19');
  await stock.saveQualityCheck(w, r.receiptId, { [pk.moves[0].id]: { received: 20, accepted: 15, rejected: 5 } });
  await stock.validateReceipt(w, r.receiptId);
  await h.rejects(stock.saveQualityCheck(w, r.receiptId, { [pk.moves[0].id]: { received: 20, accepted: 20, rejected: 0 } }), 'SR-19');
  assert.equal((await h.quant('FRY-SML', 'WH-PKU')).onHand, 55);
});

test('T-19 Post invoice S00008: total 127.600, AR +127.600, PBJT payable 11.600', async () => {
  const { invoiceId } = await flows.T19();
  const inv = await invoicing.getInvoice(invoiceId);
  assert.equal(inv.number, 'INV/2026/0008');
  assert.deepEqual([inv.amount_untaxed, inv.amount_tax, inv.amount_total, inv.state], [116000, 11600, 127600, 'posted']);
  assert.equal(await h.arOf('C03'), 127600);
  assert.equal(await h.balance('110'), 3300000 + 127600);
  assert.equal(await h.balance('202'), -11600);
});

test('T-20 Tagih 5 BRG-REG padahal Done hanya 3 ditolak (SR-01/SR-02)', async () => {
  const { soId } = await flows.T12();
  const f = await h.ctx('finance');
  const invId = await invoicing.createInvoiceFromSale(f, soId);
  const inv = await invoicing.getInvoice(invId);
  assert.equal(inv.lines[0].qty, 3);
  const err = await h.rejects(invoicing.updateDraftQuantities(f, invId, { [inv.lines[0].id]: 5 }), 'SR-02');
  assert.equal(err.detail.delivered_not_invoiced, 3);
  assert.equal((await invoicing.getInvoice(invId)).lines[0].qty, 3);
});

test('T-21 Bill 15 accepted Rp90.000 lalu bayar: GRNI 90.000→0, AP 1.590.000→1.500.000, bank 24.910.000', async () => {
  const { poId } = await flows.T17();
  const f = await h.ctx('finance');
  const billId = await invoicing.createBillFromPO(f, poId);
  const bill = await invoicing.getInvoice(billId);
  assert.equal(bill.amount_total, 90000);
  await invoicing.postInvoice(f, billId);
  assert.equal(await h.balance('125'), 0);
  assert.equal(await h.balance('201'), -1590000);
  await invoicing.registerPayment(f, billId, { amount: 90000, method: 'bank' });
  assert.equal(await h.balance('201'), -1500000);
  assert.equal(await h.balance('102'), 24910000);
  assert.equal((await invoicing.getInvoice(billId)).payment_state, 'paid');
});

test('T-22 Bill seluruh 20 FRY-SML saat accepted 15 ditolak (SR-05/SR-06)', async () => {
  const { poId } = await flows.T17();
  const f = await h.ctx('finance');
  const billId = await invoicing.createBillFromPO(f, poId);
  const bill = await invoicing.getInvoice(billId);
  const err = await h.rejects(invoicing.updateDraftQuantities(f, billId, { [bill.lines[0].id]: 20 }), 'SR-06');
  assert.equal(err.detail.accepted, 15);
  assert.equal(err.detail.rejected, 5);
});

test('T-23 Bayar bank 60.000: sisa 67.600, bank 25.060.000, total AR 3.367.600', async () => {
  const { invoiceId } = await flows.T23();
  const inv = await invoicing.getInvoice(invoiceId);
  assert.equal(inv.amount_residual, 67600);
  assert.equal(inv.payment_state, 'partial');
  assert.equal(await h.balance('102'), 25060000);
  assert.equal(await h.balance('110'), 3367600);
});

test('T-24 Payment 150.000 untuk invoice 127.600 ditolak (SR-20)', async () => {
  const { invoiceId } = await flows.T19();
  const err = await h.rejects(invoicing.registerPayment(await h.ctx('finance'), invoiceId, { amount: 150000, method: 'bank' }), 'SR-20');
  assert.equal(err.detail.residual, 127600);
  assert.equal(await h.balance('102'), 25000000);
  assert.equal((await invoicing.getInvoice(invoiceId)).amount_residual, 127600);
});

test('T-25 Jurnal invoice + delivery: debit = kredit 175.600; COGS 48.000; PBJT 11.600', async () => {
  const { invoiceId, pickingId } = await flows.T19();
  const invJe = await db.one("SELECT * FROM journal_entries WHERE source_type = 'account.move' AND source_id = ?", [invoiceId]);
  const stJe = await db.one("SELECT * FROM journal_entries WHERE source_type = 'stock.picking' AND source_id = ?", [pickingId]);
  assert.equal(invJe.total_debit + stJe.total_debit, 175600);
  assert.equal(invJe.total_credit + stJe.total_credit, 175600);
  assert.equal(await h.balance('501'), 48000);
  assert.equal(await h.balance('202'), -11600);
  const tb = await accounting.trialBalance();
  assert.equal(tb.balanced, true);
});

test('T-26 Post kedua atas invoice yang sama ditolak; ledger tidak berubah (SR-12)', async () => {
  const { invoiceId } = await flows.T19();
  const before = await h.balance('110');
  const err = await h.rejects(invoicing.postInvoice(await h.ctx('finance'), invoiceId), 'SR-12');
  assert.match(err.message, /Post kedua/);
  assert.equal(await h.balance('110'), before);
  assert.equal((await db.one("SELECT COUNT(*) c FROM journal_entries WHERE event_key = ?", [`invoice:${invoiceId}:post`])).c, 1);
  const log = await h.lastAudit('INVOICE_POST');
  assert.equal(log.result, 'rejected');
});

test('T-27 Retur 1 BRG-REG layak jual: Credit Note 30.800, sisa 36.800, outlet 15→16, COGS −12.000', async () => {
  const r = await flows.T27();
  const cn = await invoicing.getInvoice(r.creditNoteId);
  assert.equal(cn.amount_total, 30800);
  assert.deepEqual([cn.amount_untaxed, cn.amount_tax], [28000, 2800]);
  assert.equal((await invoicing.getInvoice(r.invoiceId)).amount_residual, 36800);
  assert.equal((await h.quant('BRG-REG', 'OUTLET-SUD')).onHand, 16);
  assert.equal(await h.balance('501'), 48000 - 12000);
  assert.equal(await h.balance('110'), 3300000 + 36800);
  assert.equal(await h.trialBalanced(), true);
});

test('T-28 Retur tambahan 3 BRG-REG (dari 3 terkirim, 1 sudah diretur) ditolak (SR-10)', async () => {
  const r = await flows.T27();
  const err = await h.rejects(stock.createReturn(await h.ctx('warehouse'), r.pickingId, { [r.brgMoveId]: { qty: 3 } }), 'SR-10');
  assert.equal(err.detail.returnable, 2);
  assert.equal((await h.quant('BRG-REG', 'OUTLET-SUD')).onHand, 16);
});

test('T-29 Enam Employee ID unik; E02 Cashier, OUTLET-SUD, Active', async () => {
  const list = await employees.listEmployees();
  assert.equal(list.length, 6);
  assert.equal(new Set(list.map((e) => e.code)).size, 6);
  const e02 = list.find((e) => e.code === 'E02');
  assert.deepEqual([e02.name, e02.job_title, e02.location_code, e02.status], ['Citra Dewi', 'Cashier', 'OUTLET-SUD', 'active']);
  await h.rejects(employees.createEmployee(await h.ctx('hr'), { code: 'E02', name: 'X', job_title: 'Y', location_id: e02.location_id, start_date: '2026-01-01' }), 'SR-15');
});

test('T-30 Cashier mengubah Base Salary E02 ditolak (SR-13) dan tercatat', async () => {
  const c = await h.ctx('cashier');
  const eid = await h.id('employees', 'code', 'E02');
  const err = await h.rejects(employees.updateEmployee(c, eid, { base_salary: 9000000 }), 'SR-13');
  assert.ok(err instanceof AccessError);
  assert.equal((await employees.getEmployee(eid)).base_salary, 3300000);
  const log = await h.lastAudit('EMPLOYEE_UPDATE');
  assert.equal(log.result, 'denied');
  assert.equal(log.username, 'cashier.demo');
  // HR berhak dan perubahan masuk riwayat (SR-15).
  await employees.updateEmployee(await h.ctx('hr'), eid, { base_salary: 3400000 });
  const e = await employees.getEmployee(eid);
  assert.equal(e.history[0].field, 'base_salary');
  assert.deepEqual([e.history[0].old_value, e.history[0].new_value], ['3300000', '3400000']);
});

async function payE02() {
  const eid = await h.id('employees', 'code', 'E02');
  const hr = await h.ctx('hr');
  const f = await h.ctx('finance');
  const { created } = await payroll.generatePayslips(hr, { period: '2026-10', employeeIds: [eid] });
  const id = created[0].id;
  await payroll.approvePayslip(hr, id);
  await payroll.postPayslip(f, id);
  await payroll.payPayslip(f, id);
  return { eid, id };
}

test('T-31 Payslip E02 22/22 hari: Rp3.520.000; expense +3.520.000; bank 21.480.000; payable 0', async () => {
  const { id } = await payE02();
  const ps = await payroll.getPayslip(id);
  assert.equal(ps.number, 'PAY/2026-10/E02');
  assert.deepEqual([ps.gross, ps.net, ps.state], [3520000, 3520000, 'paid']);
  assert.equal(await h.balance('601'), 3520000);
  assert.equal(await h.balance('102'), 21480000);
  assert.equal(await h.balance('203'), 0);
});

test('T-32 Payroll Posted lagi untuk E02 Oktober 2026 ditolak (SR-12/SR-17)', async () => {
  const { eid, id } = await payE02();
  await h.rejects(payroll.generatePayslips(await h.ctx('hr'), { period: '2026-10', employeeIds: [eid] }), 'SR-12');
  await h.rejects(payroll.postPayslip(await h.ctx('finance'), id), 'SR-12');
  assert.equal(await h.balance('601'), 3520000);
  assert.equal((await db.one("SELECT COUNT(*) c FROM payslips WHERE period = '2026-10'")).c, 1);
});

test('Kebijakan payroll D-05: hadir 11/22 → gaji pokok proporsional + tunjangan penuh', () => {
  const c = payroll.computePayslip({ baseSalary: 3300000, allowance: 220000, plannedDays: 22, attendedDays: 11 });
  assert.deepEqual([c.basePaid, c.allowancePaid, c.gross], [1650000, 220000, 1870000]);
  const zero = payroll.computePayslip({ baseSalary: 3300000, allowance: 220000, plannedDays: 22, attendedDays: 0 });
  assert.equal(zero.gross, 0);
});

test('T-33 Dashboard setelah T-23: Revenue 116.000, penerimaan 60.000, COGS 48.000', async () => {
  await flows.T23();
  const k = await dashboard.kpis();
  assert.deepEqual([k.revenue, k.cash_collected, k.cogs, k.pbjt], [116000, 60000, 48000, 11600]);
});

test('T-34 Quotation Draft Rp100.000 dan PO tanpa Receipt tidak menambah KPI realisasi (SR-18)', async () => {
  const before = await dashboard.kpis();
  const s = await h.ctx('sales');
  await sales.createOrder(s, {
    partnerId: await h.partnerId('C02'),
    lines: [{ productId: await h.productId('BRG-DBL'), qty: 2 }, { productId: await h.productId('ICE-TEA'), qty: 1 }, { productId: await h.productId('LEMON-TEA'), qty: 1 }],
  });
  await flows.T15();
  const k = await dashboard.kpis();
  assert.deepEqual([k.revenue, k.cash_collected, k.cogs, k.received_value], [before.revenue, before.cash_collected, before.cogs, before.received_value]);
  assert.equal(k.excluded.draft_quotations.n, 1);
  assert.equal(Number(k.excluded.draft_quotations.value), 110000);
  assert.ok(k.excluded.po_not_received.n >= 2);
});

test('T-35 Kasir jual tunai 1 NUG-6: total 25.300; outlet 14→13; kas 10.025.300; COGS 10.000', async () => {
  const c = await h.ctx('cashier');
  const r = await counter.checkout(c, { lines: [{ productId: await h.productId('NUG-6'), qty: 1 }], method: 'cash' });
  assert.equal(r.total, 25300);
  assert.equal((await h.quant('NUG-6', 'OUTLET-SUD')).onHand, 13);
  assert.equal(await h.balance('101'), 10025300);
  assert.equal(await h.balance('501'), 10000);
  assert.equal(await h.balance('202'), -2300);
  const so = await sales.getOrder(r.orderId);
  assert.equal(so.state, 'sale');
  assert.equal(so.pickings[0].state, 'done');
  assert.equal(so.invoices[0].payment_state, 'paid');
});

test('T-36 Kasir jual 16 NUG-6 dari 14 on-hand ditolak (SR-03/SR-04); seluruh transaksi batal', async () => {
  const c = await h.ctx('cashier');
  const soCount = (await db.one('SELECT COUNT(*) c FROM sale_orders')).c;
  const err = await h.rejects(counter.checkout(c, { lines: [{ productId: await h.productId('NUG-6'), qty: 16 }], method: 'cash' }), 'SR-04');
  assert.equal(err.detail.available, 14);
  assert.equal((await h.quant('NUG-6', 'OUTLET-SUD')).onHand, 14);
  assert.equal(await h.balance('101'), 10000000);
  assert.equal((await db.one('SELECT COUNT(*) c FROM sale_orders')).c, soCount);
  // Transaksi kecil (< Rp100.000) dengan stok kurang juga ditolak (keputusan D-02).
  const transfer = await stock.createTransfer(await h.ctx('warehouse'), { srcCode: 'OUTLET-SUD', destCode: 'WH-PKU', lines: [{ productId: await h.productId('NUG-6'), qty: 14 }] });
  await stock.confirmTransfer(await h.ctx('warehouse'), transfer);
  await stock.validateTransfer(await h.ctx('warehouse'), transfer);
  await h.rejects(counter.checkout(c, { lines: [{ productId: await h.productId('NUG-6'), qty: 1 }], method: 'cash' }), 'SR-04');
});

test('T-37 Telusuri S00008 hingga payment: 4 objek terhubung, audit aktor/waktu/aksi, sisa 67.600', async () => {
  await flows.T23();
  const t = await auditsvc.trace('S00008');
  const kinds = t.docs.map((d) => d.kind);
  for (const k of ['Sales Order', 'Delivery Order', 'Customer Invoice', 'Payment']) assert.ok(kinds.includes(k), k);
  assert.equal(t.residual, 67600);
  const actions = t.logs.map((l) => l.action);
  for (const a of ['QUOTATION_CREATE', 'SO_CONFIRM', 'DELIVERY_VALIDATE', 'INVOICE_POST', 'PAYMENT_POST']) assert.ok(actions.includes(a), a);
  assert.ok(t.logs.every((l) => l.username && l.ts && l.action));
});

test('T-38 Ubah harga BRG-REG + diskon 12% tanpa persetujuan setelah Confirmed ditolak (SR-07/SR-08)', async () => {
  const { soId } = await flows.T09();
  const s = await h.ctx('sales');
  const so = await sales.getOrder(soId);
  const brg = so.lines.find((l) => l.sku === 'BRG-REG');
  await h.rejects(sales.updateOrder(s, soId, {
    lines: [{ productId: brg.product_id, qty: 3, unitPrice: 25000, discountPct: 12 }, { productId: so.lines[1].product_id, qty: 2 }],
  }), 'SR-08');
  const revId = await sales.requestRevision(s, soId, { lineId: brg.id, newUnitPrice: 28000, newDiscount: 12, reason: 'Permintaan pelanggan' });
  let after = await sales.getOrder(soId);
  assert.equal(after.amount_total, 127600);
  assert.equal(after.revisions[0].state, 'pending');
  await h.rejects(sales.decideRevision(s, revId, true), 'SR-13');
  await sales.decideRevision(await h.ctx('owner'), revId, true);
  after = await sales.getOrder(soId);
  // 3 × 28.000 × 88% = 73.920; PBJT 7.392 → total 81.312 + 35.200 = 116.512
  assert.equal(after.lines.find((l) => l.sku === 'BRG-REG').subtotal, 73920);
  assert.equal(after.amount_total, 116512);
  const log = await db.one("SELECT * FROM audit_logs WHERE action = 'REVISION_APPROVE' ORDER BY id DESC LIMIT 1");
  assert.equal(log.username, 'owner.demo');
});

test('SR-07 Quotation diskon 12% tidak dapat dikonfirmasi sebelum Owner menyetujui', async () => {
  const s = await h.ctx('sales');
  const soId = await sales.createOrder(s, { partnerId: await h.partnerId('C02'), lines: [{ productId: await h.productId('BRG-REG'), qty: 1, discountPct: 12 }] });
  await h.rejects(sales.confirmOrder(s, soId), 'SR-07');
  await h.rejects(sales.approveDiscount(s, soId), 'SR-13');
  await sales.approveDiscount(await h.ctx('owner'), soId);
  await sales.confirmOrder(s, soId);
  // Menurunkan harga satuan juga dihitung sebagai diskon efektif.
  const p2 = await sales.createOrder(s, { partnerId: await h.partnerId('C02'), lines: [{ productId: await h.productId('BRG-REG'), qty: 1, unitPrice: 24000 }] });
  await h.rejects(sales.confirmOrder(s, p2), 'SR-07');
  const ok = await sales.createOrder(s, { partnerId: await h.partnerId('C02'), lines: [{ productId: await h.productId('BRG-REG'), qty: 1, discountPct: 10 }] });
  await sales.confirmOrder(s, ok);
});

test('SR-13 Sales tidak dapat mengubah credit limit pelanggan', async () => {
  const s = await h.ctx('sales');
  await h.rejects(contacts.updateContact(s, await h.partnerId('C03'), { credit_limit: 9000000 }), 'SR-13');
  await contacts.updateContact(await h.ctx('finance'), await h.partnerId('C03'), { credit_limit: 2500000 });
  assert.equal((await contacts.getContact(await h.partnerId('C03'))).credit_limit, 2500000);
});
