'use strict';
const ui = require('../lib/ui');
const db = require('../db');
const { can } = require('../lib/acl');
const { buildList } = require('../lib/listview');
const { rp } = require('../lib/money');
const crm = require('../services/crm');
const { loadChatter } = require('./_chatter');

const STAGE_LABEL = Object.fromEntries(crm.STAGES);

module.exports = (app) => {
  app.get('/crm', ui.need('crm.view'), async (req, res) => {
    res.locals.setApp('crm');
    const opps = await crm.listOpportunities();
    const leads = await crm.listLeads();
    // Pipeline: lead baru (belum dikonversi) tampil di kolom New bersama opportunity.
    const rows = [
      ...leads.filter((l) => l.state === 'new').map((l) => ({ ...l, kind: 'lead', stage: 'new', href: `/crm/leads/${l.id}` })),
      ...opps.map((o) => ({ ...o, kind: 'opportunity', href: `/crm/opportunities/${o.id}` })),
    ];
    const list = buildList(req, rows, {
      search: ['number', 'name', 'partner_code', 'partner_name', 'lead_number'],
      filters: [
        { key: 'lead', label: 'Leads', group: 'kind', test: (r) => r.kind === 'lead' },
        { key: 'opp', label: 'Opportunities', group: 'kind', test: (r) => r.kind === 'opportunity' },
        { key: 'won', label: 'Won', test: (r) => r.stage === 'won' },
      ],
      groupBys: [
        { key: 'stage', label: 'Stage', value: (r) => STAGE_LABEL[r.stage] || r.stage, order: crm.STAGES.map(([, l]) => l) },
        { key: 'partner', label: 'Customer', value: (r) => r.partner_name || '—' },
      ],
      defaultGroupBy: 'stage', defaultView: 'kanban', views: ['kanban', 'list'],
    });
    res.render('pages/list_page', {
      title: 'CRM Pipeline',
      cp: { crumbs: [{ label: 'CRM' }, { label: 'Pipeline' }], list, views: ['kanban', 'list'], actions: can(req.user.role, 'crm.edit') ? '<a class="btn btn-primary" href="/crm/leads/new">New Lead</a>' : '' },
      intro: '② Tahap: New → Qualified → Proposition → Won. Lead hanya dapat dikonversi <b>sekali</b> menjadi Opportunity; tautan Lead → Opportunity → Quotation → Sales Order tetap terbaca (SR-22).',
      columns: [
        { label: 'Number', value: (r) => r.number },
        { label: 'Type', html: (r) => (r.kind === 'lead' ? ui.badge('new', 'Lead') : ui.badge('approved', 'Opportunity')) },
        { label: 'Name', value: (r) => r.name },
        { label: 'Customer', value: (r) => (r.partner_code ? `${r.partner_code} ${r.partner_name}` : '') },
        { label: 'From Lead', value: (r) => r.lead_number || '' },
        { label: 'Stage', html: (r) => ui.badge(r.stage, STAGE_LABEL[r.stage]) },
        { label: 'Expected Revenue', value: (r) => (r.kind === 'opportunity' ? rp(r.expected_revenue) : ''), cls: 'num' },
      ],
      href: (r) => r.href,
      card: (r) => ({
        title: `${r.number} — ${r.name}`, subtitle: r.partner_name ? `${r.partner_code} ${r.partner_name}` : '',
        left: r.kind === 'lead' ? ui.badge('new', 'Lead') : `${ui.badge('approved', 'Opportunity')} <span class="muted small">dari ${r.lead_number}</span>`,
        right: r.kind === 'opportunity' ? `${r.order_count} quotation` : '',
      }),
    });
  });

  app.get('/crm/leads', ui.need('crm.view'), async (req, res) => {
    res.locals.setApp('crm');
    const rows = await crm.listLeads();
    const list = buildList(req, rows, {
      search: ['number', 'name', 'partner_code', 'partner_name'],
      filters: [{ key: 'new', label: 'New', test: (r) => r.state === 'new' }, { key: 'converted', label: 'Converted', test: (r) => r.state === 'converted' }],
      groupBys: [{ key: 'state', label: 'Status', value: (r) => ui.stateLabel(r.state) }],
    });
    res.render('pages/list_page', {
      title: 'Leads',
      cp: { crumbs: [{ label: 'CRM', href: '/crm' }, { label: 'Leads' }], list, actions: can(req.user.role, 'crm.edit') ? '<a class="btn btn-primary" href="/crm/leads/new">New</a>' : '' },
      columns: [
        { label: 'Number', value: (r) => r.number },
        { label: 'Name', value: (r) => r.name },
        { label: 'Customer', value: (r) => (r.partner_code ? `${r.partner_code} ${r.partner_name}` : '') },
        { label: 'Status', html: (r) => ui.badge(r.state) },
        { label: 'Opportunity', value: (r) => r.opportunity_number || '' },
        { label: 'Created', value: (r) => (r.created_at || '').slice(0, 16) },
      ],
      href: (r) => `/crm/leads/${r.id}`,
    });
  });

  app.get('/crm/leads/new', ui.need('crm.edit'), async (req, res) => {
    res.locals.setApp('crm');
    const customers = await db.query('SELECT id, code, name FROM partners WHERE is_customer = 1 ORDER BY code');
    res.render('pages/lead_form', { title: 'New Lead', lead: null, customers, chatter: null });
  });

  app.post('/crm/leads/new', ui.need('crm.edit'), async (req, res) => {
    const id = await crm.createLead(ui.ctx(req), req.body);
    ui.flash(req, 'success', 'Lead dibuat.');
    res.redirect(`/crm/leads/${id}`);
  });

  app.get('/crm/leads/:id', ui.need('crm.view'), async (req, res) => {
    res.locals.setApp('crm');
    const lead = await crm.getLead(Number(req.params.id));
    const related = lead.opportunity ? [{ label: `Opportunity ${lead.opportunity.number}`, href: `/crm/opportunities/${lead.opportunity.id}` }] : [];
    res.render('pages/lead_form', {
      title: lead.number, lead, customers: [],
      chatter: await loadChatter('crm.lead', lead.id, { numbers: [lead.number], related }),
    });
  });

  app.post('/crm/leads/:id/convert', ui.need('crm.edit'), async (req, res) => {
    const oppId = await crm.convertLead(ui.ctx(req), Number(req.params.id), req.body);
    ui.flash(req, 'success', 'Lead dikonversi menjadi Opportunity.');
    res.redirect(`/crm/opportunities/${oppId}`);
  });

  app.get('/crm/opportunities/:id', ui.need('crm.view'), async (req, res) => {
    res.locals.setApp('crm');
    const o = await crm.getOpportunity(Number(req.params.id));
    const related = [{ label: `Lead ${o.lead_number}`, href: `/crm/leads/${o.lead_id}` }, ...o.orders.map((s) => ({ label: `${s.number} (${ui.stateLabel(s.state)})`, href: `/sales/orders/${s.id}` }))];
    res.render('pages/opportunity_form', {
      title: o.number, o, stages: crm.STAGES,
      chatter: await loadChatter('crm.opportunity', o.id, { numbers: [o.number], related }),
    });
  });

  app.post('/crm/opportunities/:id/stage', ui.need('crm.edit'), async (req, res) => {
    await crm.setStage(ui.ctx(req), Number(req.params.id), req.body.stage);
    res.redirect(`/crm/opportunities/${req.params.id}`);
  });
};
