'use strict';
const db = require('../db');
const config = require('../config');
const { can } = require('../lib/acl');
const ui = require('../lib/ui');
const audit = require('../lib/audit');
const { resetBaseline } = require('../seed');
const { rp } = require('../lib/money');
const { BusinessError } = require('../lib/errors');

const RIGHTS = {
  sales: 'Contacts (customer), CRM, Quotation/SO (diskon ≤ 10%), Quick Counter; tanpa jurnal & gaji',
  warehouse: 'Delivery, Receipt + Quality Check, Internal Transfer, Return, RFQ/PO, SKU (tanpa harga/biaya)',
  finance: 'Invoice, Credit Note, Vendor Bill, Payment, Journal/Ledger, credit limit, harga & cost, posting payroll',
  hr: 'Employees & tarif gaji (dengan riwayat), payslip draft/approve',
  cashier: 'Quick Counter Order (tunai/bank) di OUTLET-SUD',
  owner: 'Semua hak + persetujuan diskon > 10%, revisi dokumen Confirmed, reset baseline',
};

module.exports = (app) => {
  app.get('/', async (req, res) => {
    const u = req.user;
    const summary = [];
    const one = async (sql) => (await db.one(sql)) || {};
    if (can(u.role, 'sales.view')) {
      const s = await one("SELECT SUM(state = 'draft') AS q, SUM(state = 'sale') AS so FROM sale_orders");
      summary.push({ label: 'Sales', value: `${Number(s.q || 0)} Quotation · ${Number(s.so || 0)} SO`, hint: 'Quotation & Sales Orders', href: '/sales/orders' });
    }
    if (can(u.role, 'crm.view')) {
      const c = await one("SELECT SUM(state = 'new') AS n, (SELECT COUNT(*) FROM crm_opportunities) AS o FROM crm_leads");
      summary.push({ label: 'CRM', value: `${Number(c.n || 0)} Lead · ${Number(c.o || 0)} Opp.`, hint: 'Pipeline katering', href: '/crm' });
    }
    if (can(u.role, 'inventory.view')) {
      const s = await one("SELECT SUM(on_hand) AS oh, SUM(reserved) AS r FROM stock_quants");
      summary.push({ label: 'Inventory', value: `${Number(s.oh || 0)} unit`, hint: `Reserved ${Number(s.r || 0)}`, href: '/inventory' });
    }
    if (can(u.role, 'purchase.view')) {
      const p = await one("SELECT SUM(state = 'draft') AS rfq, SUM(state = 'purchase') AS po FROM purchase_orders");
      summary.push({ label: 'Purchase', value: `${Number(p.rfq || 0)} RFQ · ${Number(p.po || 0)} PO`, hint: 'Pengadaan', href: '/purchase/orders' });
    }
    if (can(u.role, 'accounting.view')) {
      const a = await one("SELECT COALESCE(SUM(CASE WHEN l.account_code = '110' THEN l.debit - l.credit END), 0) AS ar, COALESCE(SUM(CASE WHEN l.account_code = '102' THEN l.debit - l.credit END), 0) AS bank FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id AND e.state = 'posted'");
      summary.push({ label: 'Accounting', value: rp(a.ar), hint: `AR terbuka · Bank ${rp(a.bank)}`, href: '/accounting' });
    }
    if (can(u.role, 'employees.view')) {
      const e = await one("SELECT COUNT(*) AS n FROM employees WHERE status = 'active'");
      summary.push({ label: 'Employees', value: `${e.n} aktif`, hint: 'Data staf & payroll', href: '/employees' });
    }
    if (can(u.role, 'counter.use')) {
      summary.push({ label: 'Quick Counter', value: 'OUTLET-SUD', hint: 'Pesanan kasir tunai', href: '/counter' });
    }
    res.render('pages/home', { summary });
  });

  app.get('/settings', ui.need('admin.reset'), async (req, res) => {
    res.locals.setApp('settings');
    const users = await db.query('SELECT username, full_name, role FROM users ORDER BY id');
    const c = await db.one('SELECT baseline_at FROM company WHERE id = 1');
    res.render('pages/settings', { users, rights: RIGHTS, baselineAt: c ? c.baseline_at : null });
  });

  app.post('/settings/reset', ui.need('admin.reset'), async (req, res) => {
    if (!config.allowReset) throw new BusinessError('Reset baseline dinonaktifkan pada deployment ini.', { rule: 'SR-13' });
    await resetBaseline({ actor: { user: req.user } });
    // ID pengguna sama setelah reset (urutan seed tetap), sesi tetap valid.
    ui.flash(req, 'success', 'Baseline seed dipulihkan: 773 unit / Rp5.422.000, saldo pembuka Rp43.722.000.');
    res.redirect('/settings');
  });

  const NOTE_PERMS = {
    'res.partner': 'contacts.view', product: 'products.view', 'crm.lead': 'crm.view', 'crm.opportunity': 'crm.view',
    'sale.order': 'sales.view', 'purchase.order': 'purchase.view', 'stock.picking': 'inventory.view', 'account.move': 'invoicing.view',
    'account.entry': 'accounting.view', 'hr.employee': 'employees.view', 'hr.payslip': 'payroll.view',
  };

  app.post('/notes', async (req, res) => {
    const body = String(req.body.body || '').trim();
    const docType = String(req.body.doc_type || '');
    const docId = Number(req.body.doc_id);
    const perm = NOTE_PERMS[docType];
    if (!perm || !can(req.user.role, perm)) {
      ui.flash(req, 'error', 'Anda tidak berhak menulis log note pada dokumen ini.', 'SR-13');
      return res.redirect(ui.back(req));
    }
    if (body && docType && docId) {
      await db.tx(async (conn) => {
        await audit.note(conn, ui.ctx(req), docType, docId, body, 'note');
        await audit.log(conn, ui.ctx(req), { action: 'LOG_NOTE', docType, docId, message: body.slice(0, 200) });
      });
      ui.flash(req, 'success', 'Log note ditambahkan.');
    }
    res.redirect(ui.back(req));
  });
};
