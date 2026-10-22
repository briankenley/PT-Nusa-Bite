'use strict';
const ui = require('../lib/ui');
const { can } = require('../lib/acl');
const { buildList } = require('../lib/listview');
const { rp } = require('../lib/money');
const contacts = require('../services/contacts');
const { loadChatter } = require('./_chatter');

function formData(body) {
  return {
    code: body.code, name: body.name, partner_type: body.partner_type, city: body.city,
    credit_limit: body.credit_limit, payment_term_code: body.payment_term_code,
    is_customer: body.kind === 'customer' ? 1 : 0, is_vendor: body.kind === 'vendor' ? 1 : 0,
  };
}

module.exports = (app) => {
  app.get('/contacts', ui.need('contacts.view'), async (req, res) => {
    res.locals.setApp('contacts');
    const rows = await contacts.listContacts();
    const list = buildList(req, rows, {
      search: ['code', 'name', 'city'],
      filters: [
        { key: 'customer', label: 'Customers', group: 'role', test: (r) => r.is_customer },
        { key: 'vendor', label: 'Vendors', group: 'role', test: (r) => r.is_vendor },
        { key: 'company', label: 'Company', group: 'type', test: (r) => r.partner_type === 'company' },
        { key: 'person', label: 'Person', group: 'type', test: (r) => r.partner_type === 'person' },
        { key: 'ar', label: 'Punya AR terbuka', test: (r) => r.ar_balance > 0 },
      ],
      groupBys: [
        { key: 'type', label: 'Type', value: (r) => (r.partner_type === 'company' ? 'Company' : 'Person') },
        { key: 'city', label: 'City', value: (r) => r.city || '—' },
        { key: 'terms', label: 'Payment Terms', value: (r) => r.payment_term_code },
      ],
      views: ['list', 'kanban'],
    });
    const actions = [
      can(req.user.role, 'contacts.create_customer') ? '<a class="btn btn-primary" href="/contacts/new?kind=customer">New Customer</a>' : '',
      can(req.user.role, 'contacts.create_vendor') ? '<a class="btn" href="/contacts/new?kind=vendor">New Vendor</a>' : '',
    ].join(' ');
    res.render('pages/list_page', {
      title: 'Contacts',
      cp: { crumbs: [{ label: 'Contacts' }], list, views: ['list', 'kanban'], actions },
      columns: [
        { label: 'ID', value: (r) => r.code },
        { label: 'Name', value: (r) => r.name },
        { label: 'Role', html: (r) => (r.is_customer ? ui.badge('active', 'Customer') : ui.badge('approved', 'Vendor')) },
        { label: 'Type', value: (r) => r.partner_type },
        { label: 'City', value: (r) => r.city || '' },
        { label: 'Credit Limit', value: (r) => (r.is_customer ? rp(r.credit_limit) : '—'), cls: 'num' },
        { label: 'Payment Terms', value: (r) => r.payment_term_code },
        { label: 'AR Balance', value: (r) => r.ar_balance, html: (r) => (r.is_customer ? rp(r.ar_balance) : ''), cls: 'num', sum: true, fmt: 'money' },
      ],
      href: (r) => `/contacts/${r.id}`,
      card: (r) => ({ title: `${r.code} — ${r.name}`, subtitle: `${r.partner_type} · ${r.city || ''}`, left: r.is_customer ? `Limit ${rp(r.credit_limit)}` : 'Vendor', right: r.payment_term_code }),
    });
  });

  app.get('/contacts/new', ui.need('contacts.view'), async (req, res) => {
    res.locals.setApp('contacts');
    const kind = req.query.kind === 'vendor' ? 'vendor' : 'customer';
    res.render('pages/contact_form', {
      title: 'New Contact', isNew: true, kind, c: { code: '', name: '', partner_type: 'company', city: 'Pekanbaru', credit_limit: 0, payment_term_code: 'COD' },
      terms: await contacts.listTerms(), canCredit: can(req.user.role, 'contacts.edit_credit'),
      canEdit: can(req.user.role, kind === 'vendor' ? 'contacts.create_vendor' : 'contacts.create_customer'), chatter: null,
    });
  });

  app.post('/contacts/new', ui.need('contacts.view'), async (req, res) => {
    const id = await contacts.createContact(ui.ctx(req), formData(req.body));
    ui.flash(req, 'success', 'Kontak dibuat.');
    res.redirect(`/contacts/${id}`);
  });

  app.get('/contacts/:id', ui.need('contacts.view'), async (req, res) => {
    res.locals.setApp('contacts');
    const c = await contacts.getContact(Number(req.params.id));
    const kind = c.is_vendor ? 'vendor' : 'customer';
    const related = [];
    if (c.sale_count) related.push({ label: `Sales Orders (${c.sale_count})`, href: `/sales/orders?q=${encodeURIComponent(c.code)}` });
    if (c.purchase_count) related.push({ label: `Purchase Orders (${c.purchase_count})`, href: `/purchase/orders?q=${encodeURIComponent(c.code)}` });
    if (c.invoice_count) related.push({ label: `Invoices/Bills (${c.invoice_count})`, href: `/invoicing/invoices?q=${encodeURIComponent(c.code)}` });
    res.render('pages/contact_form', {
      title: `${c.code} ${c.name}`, isNew: false, kind, c, terms: await contacts.listTerms(),
      canCredit: can(req.user.role, 'contacts.edit_credit'),
      canEdit: can(req.user.role, kind === 'vendor' ? 'contacts.create_vendor' : 'contacts.create_customer'),
      chatter: await loadChatter('res.partner', c.id, { numbers: [c.code], related }),
    });
  });

  app.post('/contacts/:id', ui.need('contacts.view'), async (req, res) => {
    const d = formData(req.body);
    delete d.is_customer; delete d.is_vendor;
    if (req.body.credit_limit === undefined) delete d.credit_limit;
    if (req.body.payment_term_code === undefined) delete d.payment_term_code;
    await contacts.updateContact(ui.ctx(req), Number(req.params.id), d);
    ui.flash(req, 'success', 'Kontak disimpan.');
    res.redirect(`/contacts/${req.params.id}`);
  });
};
