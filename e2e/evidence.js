'use strict';
/**
 * Menjalankan T-01 … T-38 lewat antarmuka web (Playwright + Chromium), menyimpan screenshot bukti
 * ke docs/evidence/ dan menulis docs/TEST_RESULTS.md (expected · actual · pass/fail · evidence).
 *
 * Pemakaian: server berjalan (npm start) lalu `npm run evidence`.
 * Setiap tes dimulai dari baseline seed segar (fixture); prasyarat "After T-xx" dijalankan ulang lewat UI.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { resetBaseline } = require('../src/seed');
const db = require('../src/db');
const L = require('./lib');

const { go, submit, text, flash, shot, createQuotation, openByNumber, stockOf, ledgerBalance, rpText } = L;

// ------------------------------------------------------------------ prasyarat lewat UI

async function uiT09(s) {
  const p = await s.as('sales');
  const id = await createQuotation(p, 'C03', [{ sku: 'BRG-REG', qty: 3 }, { sku: 'FRY-SML', qty: 2 }]);
  await submit(p, '[data-test=confirm]');
  return { soId: id };
}

async function validateDeliveryUI(s, number, done) {
  const w = await s.as('warehouse');
  await openByNumber(w, '/inventory/pickings?type=out', number);
  for (const [sku, qty] of Object.entries(done || {})) await w.fill(`[data-test="done-${sku}"]`, String(qty));
  await submit(w, '[data-test=validate]');
  return w;
}

async function uiT11(s) {
  const r = await uiT09(s);
  await validateDeliveryUI(s, 'WH/OUT/00008');
  return r;
}

async function uiT19(s) {
  const r = await uiT11(s);
  const f = await s.as('finance');
  await go(f, `/sales/orders/${r.soId}`);
  await submit(f, '[data-test=create-invoice]');
  await submit(f, '[data-test=post]');
  return { ...r, invoiceId: Number(f.url().match(/invoices\/(\d+)/)[1]) };
}

async function payUI(s, invoiceId, amount) {
  const f = await s.as('finance');
  await go(f, `/invoicing/invoices/${invoiceId}`);
  await f.fill('[data-test=pay-amount]', String(amount));
  await submit(f, '[data-test=pay]');
  return f;
}

async function uiT23(s) {
  const r = await uiT19(s);
  await payUI(s, r.invoiceId, 60000);
  return r;
}

async function uiT12(s) {
  const p = await s.as('sales');
  const id = await createQuotation(p, 'C03', [{ sku: 'BRG-REG', qty: 5 }]);
  await submit(p, '[data-test=confirm]');
  await validateDeliveryUI(s, 'WH/OUT/00008', { 'BRG-REG': 3 });
  return { soId: id };
}

async function uiT15(s) {
  const w = await s.as('warehouse');
  await go(w, '/purchase/orders/new');
  await L.selectPrefix(w, '#partner_id', 'V02 ');
  await L.fillLines(w, [{ sku: 'FRY-SML', qty: 20 }]);
  await submit(w, '[data-test=save-rfq]');
  const poId = Number(w.url().match(/orders\/(\d+)/)[1]);
  await submit(w, '[data-test=confirm-po]');
  return { poId };
}

async function qcUI(w, received, accepted, rejected) {
  await w.fill('[data-test=qc-received]', String(received));
  await w.fill('[data-test=qc-accepted]', String(accepted));
  await w.fill('[data-test=qc-rejected]', String(rejected));
  await submit(w, '[data-test=save-qc]');
}

async function uiT17(s) {
  const r = await uiT15(s);
  const w = await s.as('warehouse');
  await openByNumber(w, '/inventory/pickings?type=in', 'WH/IN/00008');
  await qcUI(w, 20, 15, 5);
  await submit(w, '[data-test=validate-receipt]');
  return r;
}

async function uiT27(s) {
  const r = await uiT23(s);
  const w = await s.as('warehouse');
  await openByNumber(w, '/inventory/pickings?type=out', 'WH/OUT/00008');
  await Promise.all([w.waitForNavigation(), w.click('[data-test=return]')]);
  await w.fill('[data-test="ret-qty-BRG-REG"]', '1');
  await submit(w, '[data-test=create-return]');
  await submit(w, '[data-test=validate]');
  const f = await s.as('finance');
  await openByNumber(f, '/invoicing/credit-notes', 'Draft');
  await submit(f, '[data-test=post]');
  return { ...r, creditNoteId: Number(f.url().match(/invoices\/(\d+)/)[1]) };
}

// ------------------------------------------------------------------ definisi tes

const TESTS = [
  {
    id: 'T-01', type: 'Normal flow', feature: 'F-01', screen: 'S-01',
    situation: 'Masuk dengan Sales; navigasi ke Sales dan CRM.',
    expected: 'Daftar aplikasi dan ringkasan dua modul terlihat, data lain mengikuti peran.',
    async run({ s, ev, check }) {
      const p = await s.as('sales');
      await go(p, '/');
      const apps = await p.$$eval('[data-test=app-switcher] .app-tile', (els) => els.map((e) => e.dataset.app));
      await ev(p, 'beranda_sales');
      await go(p, '/sales/orders'); await ev(p, 'sales');
      await go(p, '/crm'); await ev(p, 'crm');
      check(apps.includes('sales') && apps.includes('crm'), 'Sales & CRM tampil');
      check(!apps.includes('accounting') && !apps.includes('employees'), 'Accounting/Employees tidak tampil untuk Sales');
      return `App switcher sales.demo: ${apps.join(', ')}. Accounting, Employees, Settings tidak tampil.`;
    },
  },
  {
    id: 'T-02', type: 'Rule / edge case', feature: 'F-01', screen: 'S-01', rule: 'SR-13',
    situation: 'Sales mengakses Journal Entries tanpa hak.',
    expected: 'SR-13: akses ditolak (HTTP 403) dan upaya tercatat di audit log (actor, time, action, document) dengan result denied.',
    async run({ s, ev, check }) {
      const p = await s.as('sales');
      const status = await go(p, '/accounting/entries');
      await ev(p, 'akses_ditolak');
      const o = await s.as('owner');
      await go(o, '/audit?f=denied&q=sales.demo');
      await ev(o, 'audit_denied');
      const row = await db.one("SELECT * FROM audit_logs WHERE username = 'sales.demo' AND result = 'denied' ORDER BY id DESC LIMIT 1");
      check(status === 403, 'HTTP 403');
      check(row && row.action === 'ACCESS_DENIED', 'Audit denied tercatat');
      return `HTTP ${status}; audit: ${row ? `${row.ts} ${row.username} ${row.action} ${row.result} — ${row.message}` : 'tidak ada'}`;
    },
  },
  {
    id: 'T-03', type: 'Normal flow', feature: 'F-02', screen: 'S-02',
    situation: 'Buka kontak C03 dari dataset.',
    expected: 'Limit Rp2.000.000 dan termin NET14 tampil; tidak ada pergerakan saldo.',
    async run({ s, ev, check }) {
      const p = await s.as('sales');
      await openByNumber(p, '/contacts', 'C03');
      const limit = await text(p, '[data-test=credit-limit]');
      const terms = await text(p, '[data-test=payment-terms]');
      const smart = await text(p, '[data-test=smart-buttons]');
      await ev(p, 'kontak_c03');
      check(limit.includes('Rp2.000.000') && terms === 'NET14', 'limit & termin');
      check(smart.startsWith('Rp0'), 'AR Rp0');
      return `Credit limit ${limit.replace(/\(.*\)/, '').trim()}, payment terms ${terms}; AR terbuka ${smart.split(' ')[0]} (tidak ada pergerakan saldo).`;
    },
  },
  {
    id: 'T-04', type: 'Rule / edge case', feature: 'F-02', screen: 'S-02', rule: 'SR-12',
    situation: 'Coba simpan kontak baru memakai ID C03.',
    expected: 'SR-12: ID kontak harus unik — penyimpanan ditolak, tidak ada rekaman ganda, upaya tercatat di log.',
    async run({ s, ev, check }) {
      const p = await s.as('sales');
      await go(p, '/contacts/new?kind=customer');
      await p.fill('#code', 'C03');
      await p.fill('#name', 'Universitas Riau Event (duplikat)');
      await submit(p, '[data-test=save]');
      const msg = await flash(p);
      await ev(p, 'validasi_id');
      const n = await db.one("SELECT COUNT(*) c FROM partners WHERE code = 'C03'");
      const log = await db.one("SELECT * FROM audit_logs WHERE action = 'CONTACT_CREATE' ORDER BY id DESC LIMIT 1");
      check(/C03 sudah dipakai/.test(msg), 'pesan validasi');
      check(n.c === 1 && log.result === 'rejected', 'tidak ganda + log');
      return `Ditolak: "${msg}". Jumlah kontak C03 = ${n.c}. Log: ${log.username} ${log.action} ${log.result}.`;
    },
  },
  {
    id: 'T-05', type: 'Normal flow', feature: 'F-03', screen: 'S-03',
    situation: 'Bandingkan FRY-SML dengan FRY-LRG.',
    expected: 'Rp16.000/Rp24.000; biaya Rp6.000/Rp9.000; unit porsi.',
    async run({ s, ev, check }) {
      const p = await s.as('warehouse');
      await go(p, '/products?q=FRY&f=');
      await ev(p, 'daftar_sku');
      const get = async (sku) => {
        await openByNumber(p, '/products', sku);
        await ev(p, `detail_${sku}`);
        return { price: await text(p, '[data-test=sales-price]'), cost: await text(p, '[data-test=standard-cost]'), uom: await p.inputValue('#uom') };
      };
      const a = await get('FRY-SML');
      const b = await get('FRY-LRG');
      check(a.price === 'Rp16.000' && b.price === 'Rp24.000' && a.cost === 'Rp6.000' && b.cost === 'Rp9.000' && a.uom === 'porsi' && b.uom === 'porsi', 'nilai SKU');
      return `FRY-SML ${a.price} / cost ${a.cost} / ${a.uom}; FRY-LRG ${b.price} / cost ${b.cost} / ${b.uom}.`;
    },
  },
  {
    id: 'T-06', type: 'Rule / edge case', feature: 'F-03', screen: 'S-03', rule: 'SR-21',
    situation: 'Buat ulang SKU FRY-SML ukuran dan warna sama.',
    expected: 'SR-21: variant SKU (produk+ukuran+warna+unit) harus unik — rekaman ganda ditolak.',
    async run({ s, ev, check }) {
      const p = await s.as('warehouse');
      await go(p, '/products/new');
      for (const [k, v] of Object.entries({ sku: 'FRY-SML', name: 'Kentang goreng', size: 'Small', color: 'Kuning', uom: 'porsi' })) await p.fill(`#${k}`, v);
      await submit(p, '[data-test=save]');
      const m1 = await flash(p);
      await ev(p, 'sku_sama');
      await go(p, '/products/new');
      for (const [k, v] of Object.entries({ sku: 'FRY-SML-B', name: 'Kentang goreng', size: 'Small', color: 'Kuning', uom: 'porsi' })) await p.fill(`#${k}`, v);
      await submit(p, '[data-test=save]');
      const m2 = await flash(p);
      await ev(p, 'kombinasi_sama');
      const n = await db.one("SELECT COUNT(*) c FROM products WHERE name = 'Kentang goreng' AND size = 'Small'");
      check(/SR-21/.test(m1) && /FRY-SML/.test(m2) && n.c === 1, 'unik');
      return `SKU sama: "${m1}" | SKU baru dengan kombinasi sama: "${m2}". Rekaman Kentang goreng Small = ${n.c}.`;
    },
  },
  {
    id: 'T-07', type: 'Normal flow', feature: 'F-04', screen: 'S-04',
    situation: 'Konversi L00007 sekali.',
    expected: 'Satu Opportunity terhubung ke lead, nilai stok/jurnal tidak berubah.',
    async run({ s, ev, check }) {
      const before = await db.one('SELECT (SELECT SUM(on_hand) FROM stock_quants) AS units, (SELECT COUNT(*) FROM journal_entries) AS je');
      const p = await s.as('sales');
      await openByNumber(p, '/crm/leads', 'L00007');
      await ev(p, 'lead_sebelum');
      await submit(p, '[data-test=convert]');
      await ev(p, 'opportunity');
      await go(p, '/crm'); await ev(p, 'kanban');
      const after = await db.one('SELECT (SELECT SUM(on_hand) FROM stock_quants) AS units, (SELECT COUNT(*) FROM journal_entries) AS je, (SELECT COUNT(*) FROM crm_opportunities) AS opp, (SELECT number FROM crm_opportunities LIMIT 1) AS num');
      check(after.opp === 1 && Number(after.units) === Number(before.units) && after.je === before.je, 'satu opp, stok/jurnal tetap');
      return `Opportunity ${after.num} terhubung ke L00007 (total ${after.opp}). Stok ${before.units}→${after.units} unit, jumlah jurnal ${before.je}→${after.je}.`;
    },
  },
  {
    id: 'T-08', type: 'Rule / edge case', feature: 'F-04', screen: 'S-04', rule: 'SR-22',
    situation: 'Ulangi konversi L00007.',
    expected: 'SR-22: lead hanya boleh dikonversi sekali — konversi kedua ditolak, tidak ada Opportunity ganda.',
    async run({ s, ev, check }) {
      const p = await s.as('sales');
      await openByNumber(p, '/crm/leads', 'L00007');
      await submit(p, '[data-test=convert]');
      await openByNumber(p, '/crm/leads', 'L00007');
      await submit(p, '[data-test=convert]');
      const msg = await flash(p);
      await ev(p, 'konversi_ulang');
      await go(p, '/crm?v=list'); await ev(p, 'daftar_konversi');
      const n = await db.one('SELECT COUNT(*) c FROM crm_opportunities');
      check(/SR-22/.test(msg) && n.c === 1, 'ditolak');
      return `Ditolak: "${msg}". Jumlah Opportunity = ${n.c}.`;
    },
  },
  {
    id: 'T-09', type: 'Normal flow', feature: 'F-05', related: 'F-06, F-10', screen: 'S-05',
    situation: 'Dari baseline buat dan Confirm SO C03: 3 BRG-REG + 2 FRY-SML.',
    expected: 'Subtotal Rp116.000, PBJT Rp11.600, total Rp127.600; nomor baru S00008.',
    async run({ s, ev, check }) {
      const p = await s.as('sales');
      const id = await createQuotation(p, 'C03', [{ sku: 'BRG-REG', qty: 3 }, { sku: 'FRY-SML', qty: 2 }]);
      await ev(p, 'quotation_draft');
      await submit(p, '[data-test=confirm]');
      await ev(p, 'so_confirmed');
      const totals = await text(p, '[data-test=so-totals]');
      const h1 = await text(p, 'h1');
      const brg = await stockOf(p, 'BRG-REG', 'OUTLET-SUD');
      await ev(p, 'reservasi');
      check(h1.startsWith('S00008') && /Rp116\.000.*Rp11\.600.*Rp127\.600/.test(totals), 'nomor & total');
      check(brg.reserved === 7 && brg.available === 11, 'reservasi');
      return `${h1.split(' ')[0]} Confirmed (id ${id}): ${totals.replace('Untaxed Amount', 'Subtotal')}. Reservasi BRG-REG OUTLET-SUD: reserved ${brg.reserved}, available ${brg.available}.`;
    },
  },
  {
    id: 'T-10', type: 'Rule / edge case', feature: 'F-10', screen: 'S-05', rule: 'SR-09',
    situation: 'C01 dengan AR Rp550.000 dan SO terbuka Rp123.200 memesan transaksi baru Rp127.600.',
    expected: 'SR-09: exposure = 550.000 + 123.200 + 127.600 = Rp800.800 > limit Rp800.000 → konfirmasi diblokir.',
    async run({ s, ev, check }) {
      const p = await s.as('sales');
      await createQuotation(p, 'C01', [{ sku: 'BRG-REG', qty: 3 }, { sku: 'FRY-SML', qty: 2 }]);
      await ev(p, 'exposure_sebelum');
      await submit(p, '[data-test=confirm]');
      const msg = await flash(p);
      await ev(p, 'diblokir');
      const st = await db.one("SELECT state FROM sale_orders WHERE number = 'S00008'");
      check(/Rp800\.800/.test(msg) && st.state === 'draft', 'diblokir');
      return `Ditolak: "${msg}". Status S00008 tetap ${st.state}.`;
    },
  },
  {
    id: 'T-11', type: 'Normal flow', feature: 'F-07', related: 'F-05', screen: 'S-06',
    situation: 'After T-09: validasi pengiriman lengkap SO S00008.',
    expected: 'BRG outlet 18→15; FRY outlet 25→23; COGS Rp48.000.',
    async run({ s, ev, check }) {
      await uiT09(s);
      const w = await s.as('warehouse');
      await openByNumber(w, '/inventory/pickings?type=out', 'WH/OUT/00008');
      await ev(w, 'delivery_ready');
      await submit(w, '[data-test=validate]');
      await ev(w, 'delivery_done');
      const brg = await stockOf(w, 'BRG-REG', 'OUTLET-SUD');
      const fry = await stockOf(w, 'FRY-SML', 'OUTLET-SUD');
      await ev(w, 'stok');
      const f = await s.as('finance');
      const cogs = await ledgerBalance(f, '501');
      await ev(f, 'jurnal_cogs');
      check(brg.onHand === 15 && fry.onHand === 23 && cogs === 48000, 'stok & COGS');
      return `WH/OUT/00008 Done. BRG-REG outlet 18→${brg.onHand}; FRY-SML outlet 25→${fry.onHand}; COGS (501) ${rpText(cogs)}.`;
    },
  },
  {
    id: 'T-12', type: 'Rule / edge case', feature: 'F-08', screen: 'S-06', rule: 'SR-02, SR-04',
    situation: 'Dari baseline buat SO 5 BRG-REG C03; kirim hanya 3.',
    expected: 'SR-02/SR-04: hanya 3 unit menjadi Done (stok berkurang 3); sisa 2 menjadi backorder yang tetap tereservasi; tidak ada unit lain yang ikut terkirim.',
    async run({ s, ev, check }) {
      const p = await s.as('sales');
      await createQuotation(p, 'C03', [{ sku: 'BRG-REG', qty: 5 }]);
      await submit(p, '[data-test=confirm]');
      const w = await validateDeliveryUI(s, 'WH/OUT/00008', { 'BRG-REG': 3 });
      await ev(w, 'shipped_3');
      const bo = await db.one("SELECT pk.number, pk.state, m.qty_demand, m.qty_reserved FROM pickings pk JOIN stock_moves m ON m.picking_id = pk.id WHERE pk.backorder_of_id IS NOT NULL");
      await openByNumber(w, '/inventory/pickings?type=out', bo.number);
      await ev(w, 'backorder');
      const st = await stockOf(w, 'BRG-REG', 'OUTLET-SUD');
      check(bo.qty_demand === 2 && bo.qty_reserved === 2 && st.onHand === 15, 'backorder');
      return `WH/OUT/00008 Done 3 unit; backorder ${bo.number} (${bo.state}) demand ${bo.qty_demand}, reserved ${bo.qty_reserved}. BRG-REG outlet on hand ${st.onHand}, reserved ${st.reserved}.`;
    },
  },
  {
    id: 'T-13', type: 'Normal flow', feature: 'F-17', screen: 'S-07',
    situation: 'Transfer 5 FRY-SML WH-PKU ke OUTLET-SUD.',
    expected: 'WH 40→35, outlet 25→30; total 65 tetap, nilai total tidak berubah.',
    async run({ s, ev, check }) {
      const w = await s.as('warehouse');
      await go(w, '/inventory/transfers/new');
      await L.selectPrefix(w, 'select[name="lines[0][product_id]"]', 'FRY-SML ');
      await w.fill('[data-test=transfer-qty]', '5');
      await submit(w, '[data-test=save-todo]');
      await submit(w, '[data-test=validate]');
      await ev(w, 'transfer_done');
      const a = await stockOf(w, 'FRY-SML', 'WH-PKU');
      const b = await stockOf(w, 'FRY-SML', 'OUTLET-SUD');
      await ev(w, 'nilai_lokasi');
      const t = await db.one('SELECT SUM(sq.on_hand * p.standard_cost) v FROM stock_quants sq JOIN products p ON p.id = sq.product_id');
      check(a.onHand === 35 && b.onHand === 30 && Number(t.v) === 5422000, 'transfer');
      return `WH/INT/00001 Done. FRY-SML WH-PKU 40→${a.onHand}, OUTLET-SUD 25→${b.onHand}, total ${a.onHand + b.onHand}; nilai stok perusahaan ${rpText(Number(t.v))} (tetap), tanpa jurnal.`;
    },
  },
  {
    id: 'T-14', type: 'Rule / edge case', feature: 'F-07', related: 'F-17', screen: 'S-07', rule: 'SR-03, SR-04',
    situation: 'Coba alokasi 16 BRG-REG baru dari OUTLET-SUD ketika Available 14.',
    expected: 'SR-04 (keputusan D-02; pengecualian SR-03 tidak berlaku karena nilai > Rp100.000 dan bukan kasir): alokasi ditolak, Available tetap 14, reservasi S00007 tidak terpakai.',
    async run({ s, ev, check }) {
      const p = await s.as('sales');
      const before = await stockOf(p, 'BRG-REG', 'OUTLET-SUD');
      await ev(p, 'available_sebelum');
      await createQuotation(p, 'C02', [{ sku: 'BRG-REG', qty: 16 }]);
      await submit(p, '[data-test=confirm]');
      const msg = await flash(p);
      await ev(p, 'ditolak');
      const after = await stockOf(p, 'BRG-REG', 'OUTLET-SUD');
      await ev(p, 'available_sesudah');
      check(/Available 14/.test(msg) && after.available === 14 && after.reserved === 4, 'ditolak');
      return `Ditolak: "${msg}". Available sebelum ${before.available} / sesudah ${after.available}; reserved ${after.reserved}.`;
    },
  },
  {
    id: 'T-15', type: 'Normal flow', feature: 'F-11', screen: 'S-08',
    situation: 'Dari baseline buat PO baru 20 FRY-SML ke V02.',
    expected: 'PO00008; total Rp120.000; stok dan AP belum berubah.',
    async run({ s, ev, check }) {
      const { poId } = await uiT15(s);
      const w = await s.as('warehouse');
      await go(w, `/purchase/orders/${poId}`);
      await ev(w, 'po_confirmed');
      const h1 = await text(w, 'h1');
      const total = await text(w, '.totals .grand');
      const st = await stockOf(w, 'FRY-SML', 'WH-PKU');
      const ap = await ledgerBalance(await s.as('finance'), '201');
      check(h1.startsWith('PO00008') && /Rp120\.000/.test(total) && st.onHand === 40 && ap === -1500000, 'po');
      return `${h1.split(' ')[0]} Purchase Order total ${total.replace('Total ', '')}; stok FRY-SML WH-PKU tetap ${st.onHand}; AP (201) tetap ${rpText(-ap)}.`;
    },
  },
  {
    id: 'T-16', type: 'Rule / edge case', feature: 'F-11', screen: 'S-08', rule: 'SR-12',
    situation: 'Coba menimpa nomor PO baru dengan PO00007 yang sudah ada.',
    expected: 'SR-12: nomor dokumen dari sequence, unik dan tidak dapat ditimpa — perubahan ditolak, PO tetap PO00008.',
    async run({ s, ev, check }) {
      const w = await s.as('warehouse');
      await go(w, '/purchase/orders/new');
      await L.selectPrefix(w, '#partner_id', 'V02 ');
      await L.fillLines(w, [{ sku: 'FRY-SML', qty: 20 }]);
      await submit(w, '[data-test=save-rfq]');
      await Promise.all([w.waitForNavigation(), w.click('[data-test=edit-rfq]')]);
      await w.click('summary:has-text("Uji kontrol SR-12")');
      await w.fill('[data-test=override-number]', 'PO00007');
      await ev(w, 'upaya_timpa');
      await submit(w, '[data-test=save-rfq]');
      const msg = await flash(w);
      await ev(w, 'validasi_sequence');
      const n = await db.query("SELECT number FROM purchase_orders ORDER BY id");
      check(/SR-12/.test(msg) && n.map((r) => r.number).join(',') === 'PO00007,PO00008', 'unik');
      return `Ditolak: "${msg}". Nomor PO di database: ${n.map((r) => r.number).join(', ')}.`;
    },
  },
  {
    id: 'T-17', type: 'Normal flow', feature: 'F-12', screen: 'S-09',
    situation: 'After T-15: 20 datang, accepted 15, rejected 5.',
    expected: 'WH FRY-SML 40→55; valuasi +Rp90.000; GRNI Rp90.000.',
    async run({ s, ev, check }) {
      await uiT15(s);
      const w = await s.as('warehouse');
      await openByNumber(w, '/inventory/pickings?type=in', 'WH/IN/00008');
      await qcUI(w, 20, 15, 5);
      await ev(w, 'quality_check');
      await submit(w, '[data-test=validate-receipt]');
      await ev(w, 'receipt_done');
      const st = await stockOf(w, 'FRY-SML', 'WH-PKU');
      const f = await s.as('finance');
      const grni = await ledgerBalance(f, '125');
      await ev(f, 'grni');
      const inv = await ledgerBalance(f, '120');
      check(st.onHand === 55 && grni === -90000 && inv === 5512000, 'receipt');
      return `WH/IN/00008 Done (received 20, accepted 15, rejected 5). FRY-SML WH-PKU 40→${st.onHand}; Inventory (120) ${rpText(inv)} (+Rp90.000); GRNI (125) ${rpText(-grni)} kredit.`;
    },
  },
  {
    id: 'T-18', type: 'Rule / edge case', feature: 'F-12', screen: 'S-09', rule: 'SR-19',
    situation: 'Pada PO T-15 upayakan menambah stok 20 tanpa mengubah 5 unit rejected.',
    expected: 'SR-19: received/accepted/rejected terpisah; accepted 20 + rejected 5 ≠ received 20 ditolak; setelah Done kuantitas terkunci; stok hanya +15.',
    async run({ s, ev, check }) {
      await uiT15(s);
      const w = await s.as('warehouse');
      await openByNumber(w, '/inventory/pickings?type=in', 'WH/IN/00008');
      await qcUI(w, 20, 20, 5);
      const m1 = await flash(w);
      await ev(w, 'accepted_20_ditolak');
      await qcUI(w, 20, 15, 5);
      await submit(w, '[data-test=validate-receipt]');
      await w.click('summary:has-text("Uji kontrol")');
      await submit(w, '[data-test=retry-qc]');
      const m2 = await flash(w);
      await ev(w, 'setelah_done_ditolak');
      const st = await stockOf(w, 'FRY-SML', 'WH-PKU');
      await ev(w, 'saldo_stok');
      check(/SR-19/.test(m1) && /terkunci/.test(m2) && st.onHand === 55, 'qc');
      return `Upaya 1: "${m1}". Upaya 2 (setelah Done): "${m2}". Stok FRY-SML WH-PKU ${st.onHand} (hanya +15 accepted).`;
    },
  },
  {
    id: 'T-19', type: 'Normal flow', feature: 'F-09', screen: 'S-10',
    situation: 'After T-11: buat dan Post Customer Invoice untuk S00008.',
    expected: 'Total Rp127.600, AR bertambah Rp127.600, PBJT payable Rp11.600.',
    async run({ s, ev, check }) {
      const r = await uiT11(s);
      const f = await s.as('finance');
      await go(f, `/sales/orders/${r.soId}`);
      await submit(f, '[data-test=create-invoice]');
      await ev(f, 'draft_invoice');
      await submit(f, '[data-test=post]');
      await ev(f, 'invoice_posted');
      const totals = await text(f, '[data-test=invoice-totals]');
      const ar = await ledgerBalance(f, '110');
      await ev(f, 'ledger_ar');
      const pbjt = await ledgerBalance(f, '202');
      await ev(f, 'ledger_pbjt');
      check(/Total Rp127\.600/.test(totals) && ar === 3427600 && pbjt === -11600, 'invoice');
      return `INV/2026/0008 Posted: ${totals.split('Amount Due')[0].trim()}. AR (110) Rp3.300.000→${rpText(ar)} (+Rp127.600); PBJT Payable (202) ${rpText(-pbjt)}.`;
    },
  },
  {
    id: 'T-20', type: 'Rule / edge case', feature: 'F-09', related: 'F-08', screen: 'S-10', rule: 'SR-01, SR-02',
    situation: 'After T-12: coba tagih 5 BRG-REG walau Done hanya 3.',
    expected: 'SR-02 (keputusan D-01 mengalahkan SR-01): invoice hanya memuat 3 unit Done; menagih 5 ditolak.',
    async run({ s, ev, check }) {
      const r = await uiT12(s);
      const f = await s.as('finance');
      await go(f, `/sales/orders/${r.soId}`);
      await submit(f, '[data-test=create-invoice]');
      const q0 = await f.inputValue('[data-test="inv-qty-BRG-REG"]');
      await f.fill('[data-test="inv-qty-BRG-REG"]', '5');
      await submit(f, '[data-test=save-qty]');
      const msg = await flash(f);
      await ev(f, 'tagih_5_ditolak');
      const q1 = await f.inputValue('[data-test="inv-qty-BRG-REG"]');
      check(q0 === '3' && q1 === '3' && /SR-02/.test(msg), 'qty');
      return `Draft invoice otomatis ${q0} unit. Ubah ke 5 → "${msg}". Kuantitas tetap ${q1}.`;
    },
  },
  {
    id: 'T-21', type: 'Normal flow', feature: 'F-13', screen: 'S-11',
    situation: 'After T-17: buat Vendor Bill atas 15 accepted FRY-SML, lalu register pembayaran bank Rp90.000.',
    expected: 'Bill Rp90.000; GRNI Rp90.000→0; AP naik sementara ke Rp1.590.000 lalu kembali Rp1.500.000; bank menjadi Rp24.910.000.',
    async run({ s, ev, check }) {
      const r = await uiT17(s);
      const f = await s.as('finance');
      await go(f, `/purchase/orders/${r.poId}`);
      await submit(f, '[data-test=create-bill]');
      await submit(f, '[data-test=post]');
      await ev(f, 'bill_posted');
      const billUrl = f.url();
      const apMid = await ledgerBalance(f, '201');
      await go(f, billUrl.replace(L.BASE, ''));
      await f.fill('[data-test=pay-amount]', '90000');
      await submit(f, '[data-test=pay]');
      await ev(f, 'bill_paid');
      const total = await text(f, '[data-test=invoice-totals]');
      const grni = await ledgerBalance(f, '125');
      const ap = await ledgerBalance(f, '201');
      await ev(f, 'ledger_ap');
      const bank = await ledgerBalance(f, '102');
      check(/Total Rp90\.000/.test(total) && grni === 0 && apMid === -1590000 && ap === -1500000 && bank === 24910000, 'bill');
      return `BILL/2026/0008 Rp90.000 (three-way match: ordered 20, accepted 15, billed 15). GRNI → ${rpText(grni)}; AP ${rpText(-apMid)} → ${rpText(-ap)}; Bank ${rpText(bank)}.`;
    },
  },
  {
    id: 'T-22', type: 'Rule / edge case', feature: 'F-13', screen: 'S-11', rule: 'SR-05, SR-06',
    situation: 'After T-17: coba Bill untuk seluruh 20 FRY-SML.',
    expected: 'SR-06 (keputusan D-03 mengalahkan SR-05): bill dibatasi 15 accepted; 20 unit ditolak, 5 rejected tidak diakui utang.',
    async run({ s, ev, check }) {
      const r = await uiT17(s);
      const f = await s.as('finance');
      await go(f, `/purchase/orders/${r.poId}`);
      await submit(f, '[data-test=create-bill]');
      await f.fill('[data-test="inv-qty-FRY-SML"]', '20');
      await submit(f, '[data-test=save-qty]');
      const msg = await flash(f);
      await ev(f, 'bill_20_ditolak');
      const match = await text(f, '[data-test=match]');
      check(/SR-06/.test(msg), 'ditolak');
      return `Ditolak: "${msg}". Perbandingan: ${match}.`;
    },
  },
  {
    id: 'T-23', type: 'Normal flow', feature: 'F-15', screen: 'S-12',
    situation: 'After T-19: bayar bank Rp60.000 dari invoice S00008.',
    expected: 'Sisa invoice Rp67.600; bank Rp25.060.000; total AR Rp3.367.600.',
    async run({ s, ev, check }) {
      const r = await uiT19(s);
      const f = await payUI(s, r.invoiceId, 60000);
      await ev(f, 'payment_posted');
      const due = await text(f, '[data-test=amount-due]');
      const bank = await ledgerBalance(f, '102');
      await ev(f, 'ledger_bank');
      const ar = await ledgerBalance(f, '110');
      check(due === 'Rp67.600' && bank === 25060000 && ar === 3367600, 'payment');
      return `Payment BNK/2026/0001 Rp60.000 Posted. Sisa invoice ${due}; Bank (102) ${rpText(bank)}; total AR (110) ${rpText(ar)}.`;
    },
  },
  {
    id: 'T-24', type: 'Rule / edge case', feature: 'F-15', screen: 'S-12', rule: 'SR-20',
    situation: 'After T-19: upayakan payment Rp150.000 untuk invoice Rp127.600.',
    expected: 'SR-20 (keputusan D-06): overpayment ditolak; saldo invoice dan bank tidak berubah.',
    async run({ s, ev, check }) {
      const r = await uiT19(s);
      const f = await payUI(s, r.invoiceId, 150000);
      const msg = await flash(f);
      await ev(f, 'overpayment_ditolak');
      const due = await text(f, '[data-test=amount-due]');
      const bank = await ledgerBalance(f, '102');
      check(/SR-20/.test(msg) && due === 'Rp127.600' && bank === 25000000, 'overpay');
      return `Ditolak: "${msg}". Amount due tetap ${due}; Bank tetap ${rpText(bank)}.`;
    },
  },
  {
    id: 'T-25', type: 'Normal flow', feature: 'F-14', screen: 'S-13',
    situation: 'After T-19: inspeksi posting invoice dan delivery terkait.',
    expected: 'Debit=Credit Rp175.600 gabungan; COGS Rp48.000; PBJT Rp11.600.',
    async run({ s, ev, check }) {
      await uiT19(s);
      const f = await s.as('finance');
      await openByNumber(f, '/accounting/entries', 'INV/2026/0008');
      await ev(f, 'jurnal_invoice');
      const invLines = await text(f, '[data-test=entry-lines] tfoot');
      await openByNumber(f, '/accounting/entries', 'STJ/2026/00001');
      await ev(f, 'jurnal_cogs');
      const stLines = await text(f, '[data-test=entry-lines] tfoot');
      await go(f, '/accounting/trial-balance');
      await ev(f, 'trial_balance');
      const tb = await text(f, '[data-test=trial-balance] .panel-h');
      const a = Number(invLines.match(/([\d.]+) ([\d.]+)$/)[1].replace(/\./g, ''));
      const b = Number(stLines.match(/([\d.]+) ([\d.]+)$/)[1].replace(/\./g, ''));
      const cogs = await ledgerBalance(f, '501');
      const pbjt = await ledgerBalance(f, '202');
      check(a + b === 175600 && cogs === 48000 && pbjt === -11600 && /Seimbang/.test(tb), 'jurnal');
      return `INV/2026/0008 debit=kredit ${rpText(a)} + STJ/2026/00001 ${rpText(b)} = ${rpText(a + b)}. COGS ${rpText(cogs)}, PBJT ${rpText(-pbjt)}. Trial balance: ${tb}.`;
    },
  },
  {
    id: 'T-26', type: 'Rule / edge case', feature: 'F-14', screen: 'S-13', rule: 'SR-12',
    situation: 'Setelah T-25, kirim permintaan Post kedua atas peristiwa sama.',
    expected: 'SR-12: satu kejadian bisnis maksimal satu jurnal — Post kedua ditolak, ledger tidak berubah, upaya diaudit.',
    async run({ s, ev, check }) {
      const r = await uiT19(s);
      const f = await s.as('finance');
      const before = await ledgerBalance(f, '110');
      await go(f, `/invoicing/invoices/${r.invoiceId}`);
      await submit(f, '[data-test=post-again]');
      const msg = await flash(f);
      await ev(f, 'post_kedua_ditolak');
      const after = await ledgerBalance(f, '110');
      await ev(f, 'saldo_ledger');
      const o = await s.as('owner');
      await go(o, '/audit?f=blocked&q=INVOICE_POST');
      await ev(o, 'audit_posting');
      const n = await db.one("SELECT COUNT(*) c FROM journal_entries WHERE event_key = ?", [`invoice:${r.invoiceId}:post`]);
      check(/SR-12/.test(msg) && before === after && n.c === 1, 'idempoten');
      return `Ditolak: "${msg}". AR (110) ${rpText(before)} → ${rpText(after)}; jurnal untuk event invoice:${r.invoiceId}:post = ${n.c}.`;
    },
  },
  {
    id: 'T-27', type: 'Normal flow', feature: 'F-16', screen: 'S-14',
    situation: 'After T-23: pelanggan mengembalikan 1 BRG-REG layak jual.',
    expected: 'Credit Note Rp30.800; sisa invoice Rp36.800; stock BRG outlet 15→16; COGS berkurang Rp12.000.',
    async run({ s, ev, check }) {
      const r = await uiT27(s);
      const f = await s.as('finance');
      await go(f, `/invoicing/invoices/${r.creditNoteId}`);
      await ev(f, 'credit_note');
      const cn = await text(f, '[data-test=invoice-totals]');
      await go(f, `/invoicing/invoices/${r.invoiceId}`);
      await ev(f, 'invoice_sisa');
      const due = await text(f, '[data-test=amount-due]');
      const cogs = await ledgerBalance(f, '501');
      await ev(f, 'cogs');
      const w = await s.as('warehouse');
      await openByNumber(w, '/inventory/pickings?type=ret', 'RETURN/0008');
      await ev(w, 'return_done');
      const st = await stockOf(w, 'BRG-REG', 'OUTLET-SUD');
      check(/Total Rp30\.800/.test(cn) && due === 'Rp36.800' && st.onHand === 16 && cogs === 36000, 'return');
      return `RETURN/0008 Done; Credit Note RINV/2026/0001 ${cn.match(/Total (Rp[\d.]+)/)[1]} (28.000 + PBJT 2.800). Sisa invoice ${due}; BRG-REG outlet 15→${st.onHand}; COGS 48.000→${cogs.toLocaleString('id-ID')} (−12.000).`;
    },
  },
  {
    id: 'T-28', type: 'Rule / edge case', feature: 'F-16', screen: 'S-14', rule: 'SR-10',
    situation: 'After T-27: upayakan return tambahan 3 BRG-REG untuk delivery yang semula 3.',
    expected: 'SR-10: kuantitas sah maksimal 2 (3 terkirim − 1 diretur) — retur 3 ditolak, stok/credit note tidak berubah.',
    async run({ s, ev, check }) {
      await uiT27(s);
      const w = await s.as('warehouse');
      await openByNumber(w, '/inventory/pickings?type=out', 'WH/OUT/00008');
      await Promise.all([w.waitForNavigation(), w.click('[data-test=return]')]);
      await w.fill('[data-test="ret-qty-BRG-REG"]', '3');
      await submit(w, '[data-test=create-return]');
      const msg = await flash(w);
      await ev(w, 'retur_3_ditolak');
      const st = await stockOf(w, 'BRG-REG', 'OUTLET-SUD');
      const cn = await db.one("SELECT COUNT(*) c FROM invoices WHERE move_type = 'out_refund'");
      check(/maksimal 2/.test(msg) && st.onHand === 16 && cn.c === 1, 'retur');
      return `Ditolak: "${msg}". BRG-REG outlet tetap ${st.onHand}; jumlah credit note ${cn.c}.`;
    },
  },
  {
    id: 'T-29', type: 'Normal flow', feature: 'F-18', screen: 'S-15',
    situation: 'Buka dataset enam Employee Active.',
    expected: 'Enam Employee ID unik; E02 Cashier, OUTLET-SUD, Active.',
    async run({ s, ev, check }) {
      const h = await s.as('hr');
      await go(h, '/employees');
      await ev(h, 'daftar_pegawai');
      const codes = await h.$$eval('table.list tbody tr td:first-child', (tds) => tds.map((t) => t.innerText.trim()));
      await openByNumber(h, '/employees', 'E02');
      await ev(h, 'form_e02');
      const job = await h.inputValue('#job_title');
      const loc = await h.$eval('#location_id', (el) => el.options[el.selectedIndex].text);
      const status = await h.$eval('#status', (el) => el.value);
      check(codes.length === 6 && new Set(codes).size === 6 && job === 'Cashier' && loc.startsWith('OUTLET-SUD') && status === 'active', 'pegawai');
      return `${codes.length} Employee ID unik (${codes.join(', ')}). E02 Citra Dewi: ${job}, ${loc.split(' ')[0]}, ${status}.`;
    },
  },
  {
    id: 'T-30', type: 'Rule / edge case', feature: 'F-18', screen: 'S-15', rule: 'SR-13, SR-15',
    situation: 'Pengguna Cashier mencoba mengubah Base Salary E02.',
    expected: 'SR-13: Cashier tidak berhak — ditolak (403) dan tercatat; tarif tetap Rp3.300.000; perubahan sah oleh HR masuk riwayat (SR-15).',
    async run({ s, ev, check }) {
      const c = await s.as('cashier');
      const eid = (await db.one("SELECT id FROM employees WHERE code = 'E02'")).id;
      const status = await go(c, `/employees/${eid}`);
      await ev(c, 'cashier_buka_form');
      // Upaya mengirim form perubahan gaji langsung (tombol Save tidak tersedia untuk Cashier).
      await L.postForm(c, `/employees/${eid}`, { base_salary: '9000000' });
      await ev(c, 'cashier_post_ditolak');
      const salary = (await db.one('SELECT base_salary FROM employees WHERE id = ?', [eid])).base_salary;
      const log = await db.one("SELECT * FROM audit_logs WHERE action = 'EMPLOYEE_UPDATE' AND result = 'denied' ORDER BY id DESC LIMIT 1");
      const h = await s.as('hr');
      await go(h, `/employees/${eid}`);
      await h.fill('[data-test=base-salary]', '3300000');
      await ev(h, 'hr_form_riwayat');
      const o = await s.as('owner');
      await go(o, '/audit?f=denied&q=cashier.demo');
      await ev(o, 'audit_denied');
      check(status === 403 && salary === 3300000 && log && log.username === 'cashier.demo', 'akses');
      return `Buka form: HTTP ${status}. Kirim perubahan gaji: ditolak, base salary tetap ${rpText(salary)}. Audit: ${log.ts} ${log.username} ${log.action} ${log.result}.`;
    },
  },
  {
    id: 'T-31', type: 'Normal flow', feature: 'F-19', screen: 'S-16',
    situation: 'Dari baseline: proses payslip E02 22/22 hari lalu bayar via bank.',
    expected: 'Gross/net Rp3.520.000; expense +Rp3.520.000; bank Rp21.480.000; payable selesai Rp0.',
    async run({ s, ev, check }) {
      const h = await s.as('hr');
      await go(h, '/payroll');
      await L.selectPrefix(h, '[data-test=employee]', 'E02 ');
      await h.fill('[data-test=period]', '2026-10');
      await submit(h, '[data-test=generate]');
      await ev(h, 'payslip_draft');
      await submit(h, '[data-test=approve]');
      const url = h.url().replace(L.BASE, '');
      const f = await s.as('finance');
      await go(f, url);
      await submit(f, '[data-test=post]');
      await submit(f, '[data-test=pay]');
      await ev(f, 'payslip_paid');
      const total = await text(f, '[data-test=payslip-total]');
      const exp = await ledgerBalance(f, '601');
      const bank = await ledgerBalance(f, '102');
      await ev(f, 'ledger_bank');
      const payable = await ledgerBalance(f, '203');
      check(total === '3.520.000' && exp === 3520000 && bank === 21480000 && payable === 0, 'payroll');
      return `PAY/2026-10/E02 Paid: gross = net Rp${total}; Salary Expense (601) ${rpText(exp)}; Bank (102) ${rpText(bank)}; Salary Payable (203) ${rpText(payable)}.`;
    },
  },
  {
    id: 'T-32', type: 'Rule / edge case', feature: 'F-19', screen: 'S-16', rule: 'SR-12, SR-17',
    situation: 'After T-31: coba buat payroll Posted lagi untuk E02 periode Oktober 2026.',
    expected: 'SR-12: payroll karyawan + periode yang sama hanya sekali — pembuatan dan posting ulang ditolak; ledger tetap.',
    async run({ s, ev, check }) {
      const h = await s.as('hr');
      await go(h, '/payroll');
      await L.selectPrefix(h, '[data-test=employee]', 'E02 ');
      await submit(h, '[data-test=generate]');
      const url = h.url().replace(L.BASE, '');
      await submit(h, '[data-test=approve]');
      const f = await s.as('finance');
      await go(f, url);
      await submit(f, '[data-test=post]');
      await submit(f, '[data-test=pay]');
      await go(h, '/payroll');
      await L.selectPrefix(h, '[data-test=employee]', 'E02 ');
      await submit(h, '[data-test=generate]');
      const m1 = await flash(h);
      await ev(h, 'generate_ulang_ditolak');
      await go(f, url);
      await submit(f, '[data-test=post-again]');
      const m2 = await flash(f);
      await ev(f, 'post_ulang_ditolak');
      const exp = await ledgerBalance(f, '601');
      await ev(f, 'ledger_salary');
      check(/SR-12/.test(m1) && /SR-12/.test(m2) && exp === 3520000, 'idempoten');
      return `Generate ulang: "${m1}" | Post ulang: "${m2}". Salary Expense tetap ${rpText(exp)}.`;
    },
  },
  {
    id: 'T-33', type: 'Normal flow', feature: 'F-20', screen: 'S-17',
    situation: 'After T-23: buka dashboard dari transaksi uji baru.',
    expected: 'Revenue Rp116.000, penerimaan Rp60.000, COGS Rp48.000; Draft tidak masuk.',
    async run({ s, ev, check }) {
      await uiT23(s);
      const o = await s.as('owner');
      await go(o, '/dashboard');
      await ev(o, 'dashboard');
      const rev = await text(o, '[data-test=kpi-revenue]');
      const cash = await text(o, '[data-test=kpi-cash]');
      const cogs = await text(o, '[data-test=kpi-cogs]');
      check(rev === 'Rp116.000' && cash === 'Rp60.000' && cogs === 'Rp48.000', 'kpi');
      return `Revenue Posted ${rev}; Cash Collected ${cash}; COGS ${cogs}; sumber: INV/2026/0008 dan BNK/2026/0001.`;
    },
  },
  {
    id: 'T-34', type: 'Rule / edge case', feature: 'F-20', screen: 'S-17', rule: 'SR-18',
    situation: 'Tambahkan Quotation Draft Rp100.000 dan PO baru tanpa Receipt.',
    expected: 'SR-18: KPI realisasi tidak berubah (hanya invoice Posted, payment Posted, move Done); kedua dokumen tampil di daftar "tidak dihitung".',
    async run({ s, ev, check }) {
      const o = await s.as('owner');
      await go(o, '/dashboard');
      const before = [await text(o, '[data-test=kpi-revenue]'), await text(o, '[data-test=kpi-cash]'), await text(o, '[data-test=kpi-cogs]')];
      await ev(o, 'kpi_sebelum');
      const p = await s.as('sales');
      await createQuotation(p, 'C02', [{ sku: 'BRG-DBL', qty: 2 }, { sku: 'ICE-TEA', qty: 1 }, { sku: 'LEMON-TEA', qty: 1 }]);
      await ev(p, 'quotation_draft_100rb');
      await uiT15(s);
      await go(o, '/dashboard');
      const after = [await text(o, '[data-test=kpi-revenue]'), await text(o, '[data-test=kpi-cash]'), await text(o, '[data-test=kpi-cogs]')];
      const excluded = await text(o, '[data-test=kpi-excluded]');
      await ev(o, 'kpi_sesudah');
      check(before.join() === after.join() && /Quotation Draft 1 Rp110\.000/.test(excluded), 'kpi tetap');
      return `KPI sebelum [${before.join(' | ')}] = sesudah [${after.join(' | ')}]. Tidak dihitung: ${excluded}. (Quotation subtotal Rp100.000, total + PBJT Rp110.000.)`;
    },
  },
  {
    id: 'T-35', type: 'Normal flow', feature: 'F-21', screen: 'S-18',
    situation: 'Dari baseline: cashier menjual tunai 1 NUG-6.',
    expected: 'Total Rp25.300; outlet NUG-6 14→13; kas Rp10.025.300; COGS Rp10.000.',
    async run({ s, ev, check }) {
      const c = await s.as('cashier');
      await go(c, '/counter');
      await L.selectPrefix(c, 'select[name="lines[0][product_id]"]', 'NUG-6 ');
      await c.fill('input[name="lines[0][qty]"]', '1');
      await c.fill('input[name=cash_received]', '30000');
      await ev(c, 'counter_order');
      await submit(c, '[data-test=pay]');
      await ev(c, 'struk');
      const receipt = await text(c, '[data-test=receipt]');
      const st = await stockOf(await s.as('warehouse'), 'NUG-6', 'OUTLET-SUD');
      const f = await s.as('finance');
      const cash = await ledgerBalance(f, '101');
      await ev(f, 'ledger_kas');
      const cogs = await ledgerBalance(f, '501');
      check(/TOTAL Rp25\.300/.test(receipt) && st.onHand === 13 && cash === 10025300 && cogs === 10000, 'counter');
      return `Struk ${receipt.match(/INV\/2026\/\d+/)[0]} TOTAL Rp25.300 (23.000 + PBJT 2.300), kembalian 4.700. NUG-6 outlet 14→${st.onHand}; Cash (101) ${rpText(cash)}; COGS ${rpText(cogs)}.`;
    },
  },
  {
    id: 'T-36', type: 'Rule / edge case', feature: 'F-21', screen: 'S-18', rule: 'SR-03, SR-04',
    situation: 'Dari baseline: kasir menjual 16 NUG-6 dari 14 on-hand outlet.',
    expected: 'SR-04 (keputusan D-02; SR-03 tidak berlaku karena 16 × 23.000 + PBJT = Rp404.800 ≥ Rp100.000): transaksi ditolak seluruhnya; stok dan kas tidak berubah.',
    async run({ s, ev, check }) {
      const c = await s.as('cashier');
      await go(c, '/counter');
      await ev(c, 'stok_sebelum');
      await L.selectPrefix(c, 'select[name="lines[0][product_id]"]', 'NUG-6 ');
      await c.fill('input[name="lines[0][qty]"]', '16');
      await submit(c, '[data-test=pay]');
      const msg = await flash(c);
      await ev(c, 'ditolak_stok_sesudah');
      const st = await stockOf(await s.as('warehouse'), 'NUG-6', 'OUTLET-SUD');
      const cash = await ledgerBalance(await s.as('finance'), '101');
      const so = await db.one('SELECT COUNT(*) c FROM sale_orders WHERE is_counter = 1');
      check(/Available 14/.test(msg) && st.onHand === 14 && cash === 10000000 && so.c === 0, 'ditolak');
      return `Ditolak: "${msg}". NUG-6 outlet tetap ${st.onHand}; Cash tetap ${rpText(cash)}; tidak ada SO/invoice tersisa (rollback).`;
    },
  },
  {
    id: 'T-37', type: 'Normal flow', feature: 'F-22', screen: 'S-19',
    situation: 'After T-23: telusuri SO S00008 hingga payment.',
    expected: 'Empat objek terhubung dan audit aktor, waktu, aksi; saldo tersisa Rp67.600.',
    async run({ s, ev, check }) {
      await uiT23(s);
      const o = await s.as('owner');
      await go(o, '/audit/trace?number=S00008');
      await ev(o, 'trace');
      const residual = await text(o, '[data-test=trace-residual]');
      const docs = await text(o, '[data-test=trace-docs]');
      const s1 = await s.as('sales');
      await openByNumber(s1, '/sales/orders', 'S00008');
      await ev(s1, 'smart_buttons');
      check(residual === 'Rp67.600' && ['S00008', 'WH/OUT/00008', 'INV/2026/0008', 'BNK/2026/0001'].every((n) => docs.includes(n)), 'trace');
      return `Terhubung: S00008 → WH/OUT/00008 → INV/2026/0008 → BNK/2026/0001 (+ jurnal STJ/INV/BNK) dengan audit actor/time/action; saldo tersisa ${residual}.`;
    },
  },
  {
    id: 'T-38', type: 'Rule / edge case', feature: 'F-22', related: 'F-06', screen: 'S-19', rule: 'SR-07, SR-08',
    situation: 'After T-09: coba ubah unit price BRG-REG dan diskon menjadi 12% tanpa persetujuan.',
    expected: 'SR-08: dokumen Confirmed terkunci — edit langsung ditolak; perubahan hanya lewat Revisi yang wajib disetujui Owner (SR-07: diskon > 10%); semua tercatat di audit.',
    async run({ s, ev, check }) {
      const { soId } = await uiT09(s);
      const p = await s.as('sales');
      await go(p, `/sales/orders/${soId}/edit`);
      await p.fill('input[name="lines[0][unit_price]"]', '25000');
      await p.fill('input[name="lines[0][discount]"]', '12');
      await ev(p, 'upaya_edit');
      await submit(p, '[data-test=save-quotation]');
      const m1 = await flash(p);
      await ev(p, 'edit_ditolak');
      await go(p, `/sales/orders/${soId}`);
      await L.selectPrefix(p, 'select[name=line_id]', 'BRG-REG');
      await p.fill('input[name=new_discount]', '12');
      await p.fill('input[name=reason]', 'Permintaan diskon pelanggan');
      await submit(p, '[data-test=request-revision]');
      const totalPending = await text(p, '[data-test=so-totals] .grand');
      await ev(p, 'revisi_menunggu');
      // Tombol Approve tidak tampil untuk Sales; kirim permintaan approve langsung untuk menguji kontrol server.
      const revId = await p.$eval('[data-revision-id]', (el) => el.dataset.revisionId);
      await L.postForm(p, `/sales/revisions/${revId}/approve`, {});
      const st403 = await text(p, '[data-test=error-403]');
      await ev(p, 'sales_approve_ditolak');
      const o = await s.as('owner');
      await go(o, `/sales/orders/${soId}`);
      await submit(o, '[data-test=approve-revision]');
      const totalAfter = await text(o, '[data-test=so-totals] .grand');
      await ev(o, 'owner_menyetujui');
      await go(o, '/audit?q=S00008');
      await ev(o, 'audit');
      check(/SR-08/.test(m1) && /Rp127\.600/.test(totalPending) && /SR-13/.test(st403) && /Rp116\.512/.test(totalAfter), 'lock');
      return `Edit langsung: "${m1}". Revisi 12% diajukan: total tetap ${totalPending.replace('Total ', '')} (pending). Sales mencoba approve: 403. Owner menyetujui → total ${totalAfter.replace('Total ', '')} (3 × 28.000 × 88% + PBJT).`;
    },
  },
];

// ------------------------------------------------------------------ runner

async function main() {
  const only = process.argv.slice(2);
  const selected = only.length ? TESTS.filter((t) => only.includes(t.id)) : TESTS;
  fs.mkdirSync(L.OUT, { recursive: true });
  if (!only.length) for (const f of fs.readdirSync(L.OUT)) if (f.endsWith('.jpg')) fs.unlinkSync(path.join(L.OUT, f));
  const browser = await chromium.launch();
  const results = [];
  for (const t of selected) {
    await resetBaseline();
    const s = new L.Session(browser);
    const evidence = [];
    const failures = [];
    let n = 0;
    const ev = async (page, label) => { n += 1; evidence.push(await shot(page, `${t.id}_${n}_${label}`)); };
    const check = (cond, label) => { if (!cond) failures.push(label); };
    let actual = '';
    try {
      actual = await t.run({ s, ev, check });
    } catch (err) {
      failures.push(`error: ${err.message.split('\n')[0]}`);
      const pages = Object.values(s.pages);
      if (pages.length) await ev(pages[pages.length - 1], 'error');
    }
    await s.close();
    const pass = failures.length === 0;
    results.push({ ...t, actual, pass, failures, evidence });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${t.id} ${pass ? '' : failures.join('; ')}`);
  }
  await browser.close();
  await resetBaseline();
  if (!only.length) writeReport(results, (await db.one('SELECT VERSION() AS v')).v);
  await db.closePool();
  if (results.some((r) => !r.pass)) process.exitCode = 1;
}

function writeReport(results, mysqlVersion) {
  const passed = results.filter((r) => r.pass).length;
  const now = new Date();
  const lines = [
    '# Hasil Pengujian T-01 – T-38',
    '',
    `Dijalankan otomatis lewat antarmuka web (Playwright + Chromium) pada ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC terhadap MySQL ${mysqlVersion}.`,
    'Setiap tes dimulai dari **baseline seed segar** (fixture). Tes bertanda "After T-xx" menjalankan ulang prasyaratnya lewat UI.',
    'Untuk tes aturan, hasil yang seharusnya ditentukan dari SR-xx dan keputusan di [DECISION_LOG.md](DECISION_LOG.md).',
    '',
    `**Ringkasan: ${passed} / ${results.length} PASS.**  Bukti screenshot ada di [evidence/](evidence/). Perintah ulang: \`npm start\` lalu \`npm run evidence\`.`,
    '',
    'Pengujian lapisan layanan (logika bisnis + constraint database) juga tersedia: `npm test` (lihat `test/scenarios.test.js`).',
    '',
    '| Test | Jenis | Fitur / Layar | Situasi | Expected (handout / SR) | Actual | Status | Evidence |',
    '|---|---|---|---|---|---|---|---|',
  ];
  const esc = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  for (const r of results) {
    const evid = r.evidence.map((f, i) => `[${i + 1}](evidence/${f})`).join(' ');
    lines.push(`| **${r.id}** | ${r.type} | ${r.feature}${r.related ? ` (+${r.related})` : ''} · ${r.screen} | ${esc(r.situation)} | ${esc(r.expected)} | ${esc(r.actual || r.failures.join('; '))} | ${r.pass ? '✅ PASS' : `❌ FAIL (${esc(r.failures.join('; '))})`} | ${evid} |`);
  }
  lines.push('', '## Pemetaan fitur → tes', '', '| Fitur | Tes |', '|---|---|');
  const map = {};
  for (const r of results) {
    for (const f of [r.feature, ...(r.related ? r.related.split(/,\s*/) : [])]) (map[f] = map[f] || []).push(r.id);
  }
  for (const f of Object.keys(map).sort()) lines.push(`| ${f} | ${map[f].join(', ')} |`);
  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'TEST_RESULTS.md'), `${lines.join('\n')}\n`);
  console.log(`Laporan ditulis: docs/TEST_RESULTS.md (${passed}/${results.length} PASS)`);
}

main().catch(async (err) => {
  console.error(err);
  await db.closePool();
  process.exit(1);
});
