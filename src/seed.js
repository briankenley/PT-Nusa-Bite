'use strict';
/**
 * Baseline seed sesuai Bagian 4 "Dataset Realistis" pada handout.
 * resetBaseline() memulihkan seluruh data ke kondisi awal sebelum tiap tes independen.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { connectionOptions, getPool } = require('./db');
const { nowStr } = require('./lib/time');
const { computeLine } = require('./lib/money');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const SCHEMA_HASH = crypto.createHash('sha1').update(SCHEMA_SQL).digest('hex');

const TABLES = [
  'messages', 'audit_logs', 'payslips', 'employee_history', 'employees', 'reconciliations', 'payments',
  'invoice_lines', 'invoices', 'journal_lines', 'journal_entries', 'stock_moves', 'pickings',
  'purchase_order_lines', 'purchase_orders', 'sale_revisions', 'sale_order_lines', 'sale_orders',
  'crm_opportunities', 'crm_leads', 'stock_quants', 'vendor_pricelist', 'products', 'locations',
  'partners', 'accounts', 'taxes', 'payment_terms', 'sequences', 'users', 'company',
];

const DATA = {
  users: [
    ['sales.demo', 'Sales Demo', 'sales'],
    ['warehouse.demo', 'Warehouse Demo', 'warehouse'],
    ['finance.demo', 'Finance Demo', 'finance'],
    ['hr.demo', 'HR Demo', 'hr'],
    ['cashier.demo', 'Cashier Demo', 'cashier'],
    ['owner.demo', 'Owner Demo', 'owner'],
  ],
  payment_terms: [
    ['COD', 'At payment', 0],
    ['NET14', 'Fourteen days', 14],
    ['NET30', 'Thirty days', 30],
  ],
  taxes: [
    ['PBJT10', 'PBJT Makanan dan Minuman', 10, 'Sale amount after discount', 'Restaurant sales'],
    ['PUR0', 'Simplified purchase tax', 0, 'Vendor Bill', 'Dataset-only simplification'],
  ],
  accounts: [
    ['101', 'Cash', 'Current Asset'],
    ['102', 'Bank', 'Current Asset'],
    ['110', 'Accounts Receivable', 'Current Asset'],
    ['120', 'Inventory', 'Current Asset'],
    ['125', 'GRNI (Goods Received Not Invoiced)', 'Current Liability'],
    ['201', 'Accounts Payable', 'Current Liability'],
    ['202', 'PBJT Payable', 'Current Liability'],
    ['203', 'Salary Payable', 'Current Liability'],
    ['301', 'Opening Equity', 'Equity'],
    ['401', 'Sales Revenue', 'Income'],
    ['402', 'Sales Returns', 'Contra Income'],
    ['501', 'COGS', 'Expense'],
    ['601', 'Salary Expense', 'Expense'],
    ['602', 'Inventory Shrinkage', 'Expense'],
    ['701', 'Purchase Price Variance', 'Expense'],
  ],
  // code, name, type, city, credit limit, terms, customer, vendor
  partners: [
    ['C01', 'CV Riau Meeting', 'company', 'Pekanbaru', 800000, 'NET14', 1, 0],
    ['C02', 'PT Sinar Andalas', 'company', 'Pekanbaru', 5000000, 'NET30', 1, 0],
    ['C03', 'Universitas Riau Event', 'company', 'Pekanbaru', 2000000, 'NET14', 1, 0],
    ['C04', 'Rani Wibowo', 'person', 'Pekanbaru', 300000, 'COD', 1, 0],
    ['C05', 'Koperasi Melati', 'company', 'Dumai', 1500000, 'NET14', 1, 0],
    ['C06', 'Fikri Saputra', 'person', 'Pekanbaru', 200000, 'COD', 1, 0],
    ['V01', 'PT Protein Nusantara', 'company', 'Pekanbaru', 0, 'NET14', 0, 1],
    ['V02', 'PT Kentang Andalas', 'company', 'Pekanbaru', 0, 'NET14', 0, 1],
    ['V03', 'CV Segar Minum', 'company', 'Dumai', 0, 'NET30', 0, 1],
    ['V04', 'UD Saus Maju', 'company', 'Pekanbaru', 0, 'NET14', 0, 1],
    // Pelanggan umum untuk Quick Counter Order (dibayar tunai saat itu juga).
    ['WALKIN', 'Walk-in Customer', 'person', 'Pekanbaru', 0, 'COD', 1, 0],
  ],
  locations: [
    ['WH-PKU', 'Gudang Pekanbaru', 'Warehouse', 'internal', 'Pekanbaru'],
    ['OUTLET-SUD', 'Outlet Sudirman', 'Internal Location', 'internal', 'Pekanbaru'],
    ['VENDORS', 'Partners/Vendors', 'Virtual', 'vendor', null],
    ['CUSTOMERS', 'Partners/Customers', 'Virtual', 'customer', null],
    ['INV-ADJ', 'Virtual/Inventory Adjustment', 'Virtual', 'inventory', null],
    ['QC-REJECT', 'Virtual/QC Rejected (dikembalikan ke vendor)', 'Virtual', 'rejected', null],
    ['DAMAGED', 'Virtual/Retur Rusak', 'Virtual', 'damaged', null],
  ],
  // sku, name, size, color, unit, sales price, cost, vendor
  products: [
    ['BRG-REG', 'Burger reguler', 'Regular', 'Merah', 'porsi', 28000, 12000, 'V01'],
    ['BRG-DBL', 'Burger ganda', 'Double', 'Merah', 'porsi', 39000, 18000, 'V01'],
    ['CHK-CRS', 'Ayam krispi', 'Regular', 'Emas', 'porsi', 32000, 15000, 'V01'],
    ['CHS-WRP', 'Wrap keju', 'Regular', 'Kuning', 'porsi', 30000, 13000, 'V01'],
    ['RCE-CHK', 'Nasi ayam', 'Regular', 'Putih', 'porsi', 35000, 16000, 'V01'],
    ['FRY-SML', 'Kentang goreng', 'Small', 'Kuning', 'porsi', 16000, 6000, 'V02'],
    ['FRY-LRG', 'Kentang goreng', 'Large', 'Kuning', 'porsi', 24000, 9000, 'V02'],
    ['NUG-6', 'Nugget', '6 pcs', 'Emas', 'porsi', 23000, 10000, 'V02'],
    ['ICE-TEA', 'Es teh', 'Regular', 'Cokelat', 'gelas', 9000, 3000, 'V03'],
    ['LEMON-TEA', 'Teh lemon', 'Regular', 'Kuning', 'gelas', 13000, 4000, 'V03'],
    ['SODA-330', 'Minuman soda', '330 ml', 'Merah', 'kaleng', 12000, 5000, 'V03'],
    ['WATER-600', 'Air mineral', '600 ml', 'Bening', 'botol', 7000, 2500, 'V03'],
    ['SAU-BBQ', 'Saus pendamping', 'BBQ', 'Cokelat', 'cup', 5000, 1500, 'V04'],
    ['SAU-CHS', 'Saus pendamping', 'Keju', 'Kuning', 'cup', 6000, 2000, 'V04'],
    ['ICE-CRM', 'Es krim cup', 'Regular', 'Putih', 'cup', 15000, 6500, 'V04'],
  ],
  // sku: [WH-PKU, OUTLET-SUD]
  opening_stock: {
    'BRG-REG': [30, 18], 'BRG-DBL': [24, 12], 'CHK-CRS': [24, 14], 'CHS-WRP': [20, 12], 'RCE-CHK': [18, 12],
    'FRY-SML': [40, 25], 'FRY-LRG': [30, 18], 'NUG-6': [32, 14], 'ICE-TEA': [50, 30], 'LEMON-TEA': [35, 18],
    'SODA-330': [55, 25], 'WATER-600': [60, 30], 'SAU-BBQ': [35, 15], 'SAU-CHS': [30, 15], 'ICE-CRM': [22, 10],
  },
  // code, name, job, location, start date, base salary, allowance, planned, attended
  employees: [
    ['E01', 'Arif Hamzah', 'Outlet Manager', 'OUTLET-SUD', '2023-06-01', 4400000, 550000, 22, 22],
    ['E02', 'Citra Dewi', 'Cashier', 'OUTLET-SUD', '2024-05-15', 3300000, 220000, 22, 22],
    ['E03', 'Bima Saputra', 'Warehouse', 'WH-PKU', '2024-02-12', 3520000, 220000, 22, 22],
    ['E04', 'Nia Maharani', 'Finance', 'WH-PKU', '2022-12-01', 3960000, 330000, 22, 22],
    ['E05', 'Sari Amelia', 'Cashier', 'OUTLET-SUD', '2024-03-02', 3300000, 220000, 22, 22],
    ['E06', 'Rudi Firmansyah', 'Shift Staff', 'OUTLET-SUD', '2025-01-09', 2860000, 220000, 22, 22],
  ],
  // code, prefix, padding, next. Nomor 0001–0007 dianggap dipakai sistem lama (lihat README).
  sequences: [
    ['crm.lead', 'L', 5, 8],
    ['crm.opportunity', 'OPP', 5, 1],
    ['sale.order', 'S', 5, 8],
    ['sale.revision', 'REV/{Y}/', 4, 1],
    ['purchase.order', 'PO', 5, 8],
    ['stock.out', 'WH/OUT/', 5, 8],
    ['stock.in', 'WH/IN/', 5, 8],
    ['stock.int', 'WH/INT/', 5, 1],
    ['stock.return', 'RETURN/', 4, 8],
    ['invoice.out', 'INV/{Y}/', 4, 8],
    ['invoice.refund', 'RINV/{Y}/', 4, 1],
    ['invoice.in', 'BILL/{Y}/', 4, 8],
    ['journal.BNK', 'BNK/{Y}/', 4, 1],
    ['journal.CSH', 'CSH/{Y}/', 4, 1],
    ['journal.STJ', 'STJ/{Y}/', 5, 1],
    ['journal.MISC', 'MISC/{Y}/', 4, 2],
    ['journal.SAL', 'SAL/{Y}/', 4, 1],
  ],
};

const OPENING_DATE = '2026-10-01';
const SEED_DOC_DATE = '2026-10-20';

let cachedHash = null;
let cachedFor = null;
function passwordHash() {
  if (cachedHash && cachedFor === config.demoPassword) return cachedHash;
  cachedHash = bcrypt.hashSync(config.demoPassword, 10);
  cachedFor = config.demoPassword;
  return cachedHash;
}

async function schemaIsCurrent(conn) {
  try {
    const [rows] = await conn.query('SELECT schema_hash FROM company WHERE id = 1');
    return rows.length > 0 && rows[0].schema_hash === SCHEMA_HASH;
  } catch (_) {
    return false;
  }
}

/**
 * Pulihkan baseline seed. Bila skema berubah / belum ada, tabel dibuat ulang;
 * bila sudah ada, semua tabel dikosongkan lalu diisi ulang (lebih cepat untuk tes).
 */
async function resetBaseline({ recreate = false, actor = null } = {}) {
  const conn = await mysql.createConnection(connectionOptions({ multipleStatements: true }));
  try {
    if (recreate || !(await schemaIsCurrent(conn))) {
      await conn.query(SCHEMA_SQL);
    } else {
      await conn.query(`SET FOREIGN_KEY_CHECKS = 0; ${TABLES.map((t) => `TRUNCATE TABLE ${t};`).join(' ')} SET FOREIGN_KEY_CHECKS = 1;`);
    }
    await conn.beginTransaction();
    await insertBaseline(conn, actor);
    await conn.commit();
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* abaikan */ }
    throw err;
  } finally {
    await conn.end();
  }
  // Koneksi pool lama tetap valid setelah TRUNCATE; tidak perlu ditutup.
  getPool();
}

async function insertBaseline(conn, actor) {
  const now = nowStr();
  const ins = (sql, params) => conn.query(sql, params);
  const ids = { users: {}, partners: {}, locations: {}, products: {} };

  await ins('INSERT INTO company (id, name, short_name, currency, city, schema_hash, baseline_at) VALUES (1, ?, ?, ?, ?, ?, ?)',
    ['PT NusaBite Cepat Saji', 'NusaBite', 'IDR', 'Pekanbaru', SCHEMA_HASH, now]);

  const hash = passwordHash();
  for (const [username, name, role] of DATA.users) {
    const [r] = await ins('INSERT INTO users (username, full_name, role, password_hash) VALUES (?, ?, ?, ?)', [username, name, role, hash]);
    ids.users[role] = r.insertId;
  }
  for (const s of DATA.sequences) await ins('INSERT INTO sequences (code, prefix, padding, next_number) VALUES (?, ?, ?, ?)', s);
  for (const t of DATA.payment_terms) await ins('INSERT INTO payment_terms (code, description, due_days) VALUES (?, ?, ?)', t);
  for (const t of DATA.taxes) await ins('INSERT INTO taxes (code, name, rate_pct, base, usage_note) VALUES (?, ?, ?, ?, ?)', t);
  for (const a of DATA.accounts) await ins('INSERT INTO accounts (code, name, account_type) VALUES (?, ?, ?)', a);

  for (const [code, name, type, city, limit, term, cust, vend] of DATA.partners) {
    const [r] = await ins(`INSERT INTO partners (code, name, partner_type, is_customer, is_vendor, city, credit_limit, payment_term_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [code, name, type, cust, vend, city, limit, term, now, now]);
    ids.partners[code] = r.insertId;
  }
  for (const [code, name, type, usage, city] of DATA.locations) {
    const [r] = await ins('INSERT INTO locations (code, name, loc_type, usage_type, city) VALUES (?, ?, ?, ?, ?)', [code, name, type, usage, city]);
    ids.locations[code] = r.insertId;
  }
  for (const [sku, name, size, color, uom, price, cost, vendor] of DATA.products) {
    const [r] = await ins(`INSERT INTO products (sku, name, size, color, uom, sales_price, standard_cost, default_vendor_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [sku, name, size, color, uom, price, cost, ids.partners[vendor], now, now]);
    ids.products[sku] = r.insertId;
    // vendor_pricelist: harga beli = cost, min quantity 1
    await ins('INSERT INTO vendor_pricelist (vendor_id, product_id, uom, unit_price, min_qty) VALUES (?, ?, ?, ?, 1)',
      [ids.partners[vendor], r.insertId, uom, cost]);
  }

  // opening_stock: quant + stock move "Opening stock" (nilai sudah tercakup di opening entry akun 120)
  const productCost = Object.fromEntries(DATA.products.map((p) => [p[0], p[6]]));
  for (const [sku, [wh, outlet]] of Object.entries(DATA.opening_stock)) {
    for (const [loc, qty] of [['WH-PKU', wh], ['OUTLET-SUD', outlet]]) {
      await ins('INSERT INTO stock_quants (product_id, location_id, on_hand, reserved) VALUES (?, ?, ?, 0)', [ids.products[sku], ids.locations[loc], qty]);
      await ins(`INSERT INTO stock_moves (product_id, src_location_id, dest_location_id, qty_demand, qty_done, unit_cost, value, state, ref, created_at, done_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'done', 'Opening stock (baseline)', ?, ?)`,
      [ids.products[sku], ids.locations['INV-ADJ'], ids.locations[loc], qty, qty, productCost[sku], qty * productCost[sku], `${OPENING_DATE} 00:00:00.000`, `${OPENING_DATE} 00:00:00.000`]);
    }
  }

  // opening_balances: satu jurnal pembuka seimbang (bukan transaksi tes, bukan pendapatan).
  const openingLines = [
    ['101', null, 'Saldo pembuka kas', 10000000, 0],
    ['102', null, 'Saldo pembuka bank', 25000000, 0],
    ['110', ids.partners.C01, 'Saldo AR pembuka C01', 550000, 0],
    ['110', ids.partners.C02, 'Saldo AR pembuka C02', 2750000, 0],
    ['120', null, 'Saldo persediaan pembuka (773 unit)', 5422000, 0],
    ['201', null, 'Saldo AP pembuka', 0, 1500000],
    ['301', null, 'Opening equity', 0, 42222000],
  ];
  const totalDebit = openingLines.reduce((s, l) => s + l[3], 0);
  const totalCredit = openingLines.reduce((s, l) => s + l[4], 0);
  const [je] = await ins(`INSERT INTO journal_entries (number, journal, entry_date, ref, source_type, source_id, event_key, state, total_debit, total_credit, created_at, posted_at)
    VALUES ('MISC/2026/0001', 'MISC', ?, 'Opening Balance (saldo pembuka baseline)', 'opening', NULL, 'opening:baseline', 'posted', ?, ?, ?, ?)`,
  [OPENING_DATE, totalDebit, totalCredit, `${OPENING_DATE} 00:00:00.000`, `${OPENING_DATE} 00:00:00.000`]);
  for (const [acc, partner, label, d, c] of openingLines) {
    await ins('INSERT INTO journal_lines (entry_id, account_code, partner_id, label, debit, credit) VALUES (?, ?, ?, ?, ?, ?)', [je.insertId, acc, partner, label, d, c]);
  }

  // existing_documents
  const ts = `${SEED_DOC_DATE} 09:00:00.000`;
  const [lead] = await ins(`INSERT INTO crm_leads (number, name, partner_id, description, state, created_by, created_at)
    VALUES ('L00007', 'Rapat kampus, 40 paket', ?, 'Rapat kampus, 40 paket', 'new', ?, ?)`, [ids.partners.C03, ids.users.sales, ts]);

  const line = computeLine({ unitPrice: 28000, qty: 4, discountPct: 0, taxRatePct: 10 });
  const [so] = await ins(`INSERT INTO sale_orders (number, partner_id, location_id, state, order_date, payment_term_code, amount_untaxed, amount_tax, amount_total,
      created_by, created_at, updated_at, confirmed_by, confirmed_at)
    VALUES ('S00007', ?, ?, 'sale', ?, 'NET14', ?, ?, ?, ?, ?, ?, ?, ?)`,
  [ids.partners.C01, ids.locations['OUTLET-SUD'], SEED_DOC_DATE, line.subtotal, line.tax, line.total, ids.users.sales, ts, ts, ids.users.sales, ts]);
  const [sol] = await ins(`INSERT INTO sale_order_lines (order_id, seq, product_id, qty, list_price, unit_price, discount_pct, tax_code, subtotal, tax_amount, total)
    VALUES (?, 1, ?, 4, 28000, 28000, 0, 'PBJT10', ?, ?, ?)`, [so.insertId, ids.products['BRG-REG'], line.subtotal, line.tax, line.total]);
  const [out7] = await ins(`INSERT INTO pickings (number, picking_type, state, partner_id, src_location_id, dest_location_id, sale_order_id, scheduled_date, created_by, created_at)
    VALUES ('WH/OUT/00007', 'out', 'ready', ?, ?, ?, ?, ?, ?, ?)`,
  [ids.partners.C01, ids.locations['OUTLET-SUD'], ids.locations.CUSTOMERS, so.insertId, SEED_DOC_DATE, ids.users.sales, ts]);
  await ins(`INSERT INTO stock_moves (picking_id, product_id, src_location_id, dest_location_id, qty_demand, qty_reserved, unit_cost, state, sale_line_id, created_at)
    VALUES (?, ?, ?, ?, 4, 4, 12000, 'ready', ?, ?)`,
  [out7.insertId, ids.products['BRG-REG'], ids.locations['OUTLET-SUD'], ids.locations.CUSTOMERS, sol.insertId, ts]);
  await ins('UPDATE stock_quants SET reserved = 4 WHERE product_id = ? AND location_id = ?', [ids.products['BRG-REG'], ids.locations['OUTLET-SUD']]);

  const [po] = await ins(`INSERT INTO purchase_orders (number, partner_id, state, order_date, dest_location_id, amount_untaxed, amount_tax, amount_total,
      created_by, created_at, updated_at, confirmed_by, confirmed_at)
    VALUES ('PO00007', ?, 'purchase', ?, ?, 120000, 0, 120000, ?, ?, ?, ?, ?)`,
  [ids.partners.V02, SEED_DOC_DATE, ids.locations['WH-PKU'], ids.users.warehouse, ts, ts, ids.users.warehouse, ts]);
  const [pol] = await ins(`INSERT INTO purchase_order_lines (order_id, seq, product_id, qty, unit_price, tax_code, subtotal, tax_amount, total)
    VALUES (?, 1, ?, 20, 6000, 'PUR0', 120000, 0, 120000)`, [po.insertId, ids.products['FRY-SML']]);
  const [in7] = await ins(`INSERT INTO pickings (number, picking_type, state, partner_id, src_location_id, dest_location_id, purchase_order_id, scheduled_date, created_by, created_at)
    VALUES ('WH/IN/00007', 'in', 'ready', ?, ?, ?, ?, ?, ?, ?)`,
  [ids.partners.V02, ids.locations.VENDORS, ids.locations['WH-PKU'], po.insertId, SEED_DOC_DATE, ids.users.warehouse, ts]);
  await ins(`INSERT INTO stock_moves (picking_id, product_id, src_location_id, dest_location_id, qty_demand, unit_cost, state, purchase_line_id, created_at)
    VALUES (?, ?, ?, ?, 20, 6000, 'ready', ?, ?)`,
  [in7.insertId, ids.products['FRY-SML'], ids.locations.VENDORS, ids.locations['WH-PKU'], pol.insertId, ts]);

  for (const [code, name, job, loc, start, base, allow, planned, attended] of DATA.employees) {
    await ins(`INSERT INTO employees (code, name, job_title, location_id, start_date, status, base_salary, fixed_allowance, planned_days, attended_days, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`, [code, name, job, ids.locations[loc], start, base, allow, planned, attended, now, now]);
  }

  const notes = [
    ['crm.lead', lead.insertId, 'Lead dibuat dari baseline seed.'],
    ['sale.order', so.insertId, 'Sales Order dikonfirmasi (baseline seed): 4 × BRG-REG direservasi di OUTLET-SUD.'],
    ['stock.picking', out7.insertId, 'Delivery Order menunggu pengiriman; 4 BRG-REG reserved.'],
    ['purchase.order', po.insertId, 'Purchase Order dikonfirmasi (baseline seed); belum ada penerimaan barang, bill, atau AP.'],
    ['stock.picking', in7.insertId, 'Receipt menunggu barang datang.'],
  ];
  for (const [type, id, body] of notes) {
    await ins("INSERT INTO messages (doc_type, doc_id, author_name, kind, body, created_at) VALUES (?, ?, 'System', 'system', ?, ?)", [type, id, body, ts]);
  }

  const who = actor && actor.user ? actor.user : { id: null, username: 'system', role: 'system' };
  await ins(`INSERT INTO audit_logs (ts, user_id, username, role, action, doc_type, result, message)
    VALUES (?, ?, ?, ?, 'BASELINE_RESET', 'system', 'ok', 'Baseline seed dipulihkan: 773 unit / Rp5.422.000, saldo pembuka Rp43.722.000.')`,
  [now, who.id, who.username, who.role]);
}

module.exports = { resetBaseline, DATA, SCHEMA_HASH };
