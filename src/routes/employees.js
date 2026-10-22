'use strict';
const ui = require('../lib/ui');
const db = require('../db');
const { can } = require('../lib/acl');
const { buildList } = require('../lib/listview');
const { rp } = require('../lib/money');
const employees = require('../services/employees');
const { loadChatter } = require('./_chatter');

const fields = (b) => ({
  code: b.code, name: b.name, job_title: b.job_title, location_id: b.location_id, start_date: b.start_date, status: b.status,
  base_salary: b.base_salary, fixed_allowance: b.fixed_allowance, planned_days: b.planned_days, attended_days: b.attended_days,
});

module.exports = (app) => {
  app.get('/employees', ui.need('employees.view'), async (req, res) => {
    res.locals.setApp('employees');
    const rows = await employees.listEmployees();
    const list = buildList(req, rows, {
      search: ['code', 'name', 'job_title', 'location_code'],
      filters: [
        { key: 'active', label: 'Active', group: 's', test: (r) => r.status === 'active' },
        { key: 'inactive', label: 'Inactive', group: 's', test: (r) => r.status === 'inactive' },
        { key: 'outlet', label: 'OUTLET-SUD', group: 'l', test: (r) => r.location_code === 'OUTLET-SUD' },
        { key: 'wh', label: 'WH-PKU', group: 'l', test: (r) => r.location_code === 'WH-PKU' },
      ],
      groupBys: [{ key: 'location', label: 'Work Unit', value: (r) => r.location_code }, { key: 'job', label: 'Job Title', value: (r) => r.job_title }],
      views: ['list', 'kanban'],
    });
    res.render('pages/list_page', {
      title: 'Employees',
      cp: { crumbs: [{ label: 'Employees' }], list, views: ['list', 'kanban'], actions: can(req.user.role, 'employees.edit') ? '<a class="btn btn-primary" href="/employees/new">New</a>' : '' },
      columns: [
        { label: 'Employee ID', value: (r) => r.code },
        { label: 'Name', value: (r) => r.name },
        { label: 'Role', value: (r) => r.job_title },
        { label: 'Location', value: (r) => r.location_code },
        { label: 'Start Date', value: (r) => r.start_date },
        { label: 'Status', html: (r) => ui.badge(r.status) },
        { label: 'Base Salary', value: (r) => r.base_salary, html: (r) => rp(r.base_salary), cls: 'num', sum: true, fmt: 'money' },
        { label: 'Allowance', value: (r) => r.fixed_allowance, html: (r) => rp(r.fixed_allowance), cls: 'num', sum: true, fmt: 'money' },
        { label: 'Hadir/Rencana', value: (r) => `${r.attended_days}/${r.planned_days}`, cls: 'num' },
      ],
      href: (r) => `/employees/${r.id}`,
      card: (r) => ({ title: `${r.code} · ${r.name}`, subtitle: `${r.job_title} · ${r.location_code}`, left: ui.badge(r.status), right: rp(r.base_salary) }),
    });
  });

  const locations = () => db.query("SELECT id, code, name FROM locations WHERE usage_type = 'internal' ORDER BY id");

  app.get('/employees/new', ui.need('employees.edit'), async (req, res) => {
    res.locals.setApp('employees');
    res.render('pages/employee_form', {
      title: 'New Employee', isNew: true, canEdit: true, locations: await locations(), chatter: null,
      e: { code: '', name: '', job_title: '', location_id: '', start_date: '', status: 'active', base_salary: 0, fixed_allowance: 0, planned_days: 22, attended_days: 22, history: [], payslips: [] },
    });
  });

  app.post('/employees/new', ui.need('employees.edit'), async (req, res) => {
    const id = await employees.createEmployee(ui.ctx(req), fields(req.body));
    ui.flash(req, 'success', 'Karyawan dibuat.');
    res.redirect(`/employees/${id}`);
  });

  app.get('/employees/:id', ui.need('employees.view'), async (req, res) => {
    res.locals.setApp('employees');
    const e = await employees.getEmployee(Number(req.params.id));
    res.render('pages/employee_form', {
      title: `${e.code} ${e.name}`, isNew: false, e, canEdit: can(req.user.role, 'employees.edit'), locations: await locations(),
      chatter: await loadChatter('hr.employee', e.id, { numbers: [e.code], related: e.payslips.map((p) => ({ label: `${p.number} (${p.state})`, href: `/payroll/${p.id}` })) }),
    });
  });

  // Tanpa middleware halaman: pengecekan hak dilakukan di layanan agar upaya Cashier tetap tercatat (T-30).
  app.post('/employees/:id', async (req, res) => {
    await employees.updateEmployee(ui.ctx(req), Number(req.params.id), fields(req.body));
    ui.flash(req, 'success', 'Data karyawan disimpan; perubahan tercatat di riwayat.');
    res.redirect(`/employees/${req.params.id}`);
  });
};
