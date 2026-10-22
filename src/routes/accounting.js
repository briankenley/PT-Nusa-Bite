'use strict';
const ui = require('../lib/ui');
const db = require('../db');
const { buildList } = require('../lib/listview');
const { rp } = require('../lib/money');
const accounting = require('../services/accounting');
const invoicing = require('../services/invoicing');
const { loadChatter } = require('./_chatter');

module.exports = (app) => {
  app.get('/accounting', ui.need('accounting.view'), async (req, res) => {
    res.locals.setApp('accounting');
    const tb = await accounting.trialBalance();
    const counts = await db.one(`SELECT
      (SELECT COUNT(*) FROM invoices WHERE move_type = 'out_invoice' AND state = 'draft') AS inv_draft,
      (SELECT COUNT(*) FROM invoices WHERE move_type = 'out_invoice' AND state = 'posted' AND payment_state <> 'paid') AS inv_open,
      (SELECT COUNT(*) FROM invoices WHERE move_type = 'in_invoice' AND state = 'draft') AS bill_draft,
      (SELECT COUNT(*) FROM invoices WHERE move_type = 'in_invoice' AND state = 'posted' AND payment_state <> 'paid') AS bill_open,
      (SELECT COUNT(*) FROM invoices WHERE move_type = 'out_refund' AND state = 'draft') AS cn_draft,
      (SELECT COUNT(*) FROM payslips WHERE state = 'approved') AS ps_approved`);
    res.render('pages/accounting_overview', { title: 'Accounting', tb, counts });
  });

  app.get('/accounting/payments', ui.need('accounting.view'), async (req, res) => {
    res.locals.setApp('accounting');
    const rows = await invoicing.listPayments();
    const list = buildList(req, rows, {
      search: ['number', 'partner_code', 'partner_name', 'invoice_number'],
      filters: [
        { key: 'in', label: 'Customer Payments', group: 't', test: (r) => r.payment_type === 'inbound' },
        { key: 'out', label: 'Vendor Payments', group: 't', test: (r) => r.payment_type === 'outbound' },
        { key: 'cash', label: 'Cash', group: 'm', test: (r) => r.method === 'cash' },
        { key: 'bank', label: 'Bank', group: 'm', test: (r) => r.method === 'bank' },
      ],
      groupBys: [{ key: 'type', label: 'Payment Type', value: (r) => (r.payment_type === 'inbound' ? 'Customer Payment' : 'Vendor Payment') }, { key: 'method', label: 'Method', value: (r) => r.method }],
    });
    res.render('pages/list_page', {
      title: 'Payments',
      cp: { crumbs: [{ label: 'Accounting', href: '/accounting' }, { label: 'Payments' }], list },
      intro: 'Register Payment dilakukan dari invoice/bill Posted. Pembayaran parsial mengurangi saldo terbuka tanpa mengubah invoice awal; kelebihan bayar ditolak (SR-20).',
      columns: [
        { label: 'Number', html: (r) => `<span id="${r.number}">${r.number}</span>` },
        { label: 'Date', value: (r) => r.payment_date },
        { label: 'Type', value: (r) => (r.payment_type === 'inbound' ? 'Customer Payment' : 'Vendor Payment') },
        { label: 'Partner', value: (r) => `${r.partner_code} ${r.partner_name}` },
        { label: 'Invoice', value: (r) => r.invoice_number },
        { label: 'Method', value: (r) => r.method },
        { label: 'Status', html: () => ui.badge('posted') },
        { label: 'By', value: (r) => r.created_by_name },
        { label: 'Amount', value: (r) => r.amount, html: (r) => rp(r.amount), cls: 'num', sum: true, fmt: 'money' },
      ],
      href: (r) => `/accounting/entries/${r.journal_entry_id}`,
    });
  });

  app.get('/accounting/entries', ui.need('accounting.view'), async (req, res) => {
    res.locals.setApp('accounting');
    const rows = await accounting.listEntries();
    const list = buildList(req, rows, {
      search: ['number', 'ref', 'journal', 'event_key'],
      filters: [
        { key: 'posted', label: 'Posted', group: 's', test: (r) => r.state === 'posted' },
        { key: 'draft', label: 'Draft', group: 's', test: (r) => r.state === 'draft' },
        ...Object.keys(accounting.JOURNALS).map((j) => ({ key: `j_${j}`, label: `Journal ${j}`, group: 'j', test: (r) => r.journal === j })),
      ],
      groupBys: [{ key: 'journal', label: 'Journal', value: (r) => `${r.journal} — ${accounting.JOURNALS[r.journal]}` }, { key: 'date', label: 'Date', value: (r) => r.entry_date }],
    });
    res.render('pages/list_page', {
      title: 'Journal Entries',
      cp: { crumbs: [{ label: 'Accounting', href: '/accounting' }, { label: 'Journal Entries' }], list, actions: res.locals.perms['accounting.edit'] ? '<a class="btn btn-primary" href="/accounting/entries/new">New (manual)</a>' : '' },
      columns: [
        { label: 'Number', value: (r) => r.number || 'Draft' },
        { label: 'Date', value: (r) => r.entry_date },
        { label: 'Journal', value: (r) => r.journal },
        { label: 'Reference', value: (r) => r.ref || '' },
        { label: 'Event key (SR-12)', html: (r) => `<code>${ui.escapeHtml(r.event_key || '')}</code>` },
        { label: 'Status', html: (r) => ui.badge(r.state) },
        { label: 'Posted by', value: (r) => r.posted_by_name || 'system' },
        { label: 'Debit = Credit', value: (r) => r.total_debit, html: (r) => rp(r.total_debit), cls: 'num', sum: true, fmt: 'money' },
      ],
      href: (r) => `/accounting/entries/${r.id}`,
    });
  });

  app.get('/accounting/entries/new', ui.need('accounting.edit'), async (req, res) => {
    res.locals.setApp('accounting');
    res.render('pages/entry_new', { title: 'Jurnal manual', accounts: await accounting.listAccounts() });
  });

  app.post('/accounting/entries/new', ui.need('accounting.edit'), async (req, res) => {
    const raw = req.body.lines || [];
    const id = await accounting.createManualEntry(ui.ctx(req), { date: req.body.date, ref: req.body.ref, lines: Array.isArray(raw) ? raw : Object.values(raw) });
    ui.flash(req, 'success', 'Draft jurnal manual dibuat (seimbang).');
    res.redirect(`/accounting/entries/${id}`);
  });

  app.post('/accounting/entries/:id/post', ui.need('accounting.edit'), async (req, res) => {
    const number = await accounting.postManualEntry(ui.ctx(req), Number(req.params.id));
    ui.flash(req, 'success', `${number} Posted.`);
    res.redirect(`/accounting/entries/${req.params.id}`);
  });

  app.get('/accounting/entries/:id', ui.need('accounting.view'), async (req, res) => {
    res.locals.setApp('accounting');
    const e = await accounting.getEntry(Number(req.params.id));
    const src = { 'account.move': '/invoicing/invoices/', 'stock.picking': '/inventory/pickings/', 'hr.payslip': '/payroll/', 'account.payment': null }[e.source_type];
    const related = src && e.source_id ? [{ label: `Sumber: ${e.source_type} #${e.source_id}`, href: src + e.source_id }] : [];
    res.render('pages/entry_form', { title: e.number || 'Draft entry', e, journals: accounting.JOURNALS, chatter: await loadChatter('account.entry', e.id, { numbers: [e.number].filter(Boolean), related }) });
  });

  app.get('/accounting/ledger', ui.need('accounting.view'), async (req, res) => {
    res.locals.setApp('accounting');
    const accounts = await accounting.listAccounts();
    const code = req.query.account || '110';
    const partners = await db.query('SELECT id, code, name FROM partners ORDER BY code');
    const data = await accounting.ledger(code, { partnerId: req.query.partner ? Number(req.query.partner) : null });
    res.render('pages/ledger', { title: `General Ledger ${code}`, accounts, data, code, partners, partner: req.query.partner || '' });
  });

  app.get('/accounting/trial-balance', ui.need('accounting.view'), async (req, res) => {
    res.locals.setApp('accounting');
    res.render('pages/trial_balance', { title: 'Trial Balance', tb: await accounting.trialBalance({ dateTo: req.query.to || null }), to: req.query.to || '' });
  });

  app.get('/accounting/accounts', ui.need('accounting.view'), async (req, res) => {
    res.locals.setApp('accounting');
    const tb = await accounting.trialBalance();
    const list = buildList(req, tb.rows, { search: ['code', 'name'], groupBys: [{ key: 'type', label: 'Account Type', value: (r) => r.account_type }] });
    res.render('pages/list_page', {
      title: 'Chart of Accounts',
      cp: { crumbs: [{ label: 'Accounting', href: '/accounting' }, { label: 'Chart of Accounts' }], list },
      columns: [
        { label: 'Code', value: (r) => r.code }, { label: 'Name', value: (r) => r.name }, { label: 'Type', value: (r) => r.account_type },
        { label: 'Balance (Dr − Cr)', value: (r) => r.balance, html: (r) => rp(r.balance), cls: 'num' },
      ],
      href: (r) => `/accounting/ledger?account=${r.code}`,
    });
  });

  app.get('/accounting/taxes', ui.need('accounting.view'), async (req, res) => {
    res.locals.setApp('accounting');
    const taxes = await db.query('SELECT * FROM taxes');
    const terms = await db.query('SELECT * FROM payment_terms ORDER BY due_days');
    res.render('pages/taxes', { title: 'Taxes & Payment Terms', taxes, terms });
  });
};
