'use strict';
const ui = require('../lib/ui');
const db = require('../db');
const { buildList } = require('../lib/listview');
const { currentPeriod } = require('../lib/time');
const policies = require('../policies');
const payroll = require('../services/payroll');
const { loadChatter } = require('./_chatter');

module.exports = (app) => {
  app.get('/payroll', ui.need('payroll.view'), async (req, res) => {
    res.locals.setApp(res.locals.perms['employees.view'] && req.user.role === 'hr' ? 'employees' : 'accounting');
    const rows = await payroll.listPayslips();
    const list = buildList(req, rows, {
      search: ['number', 'employee_code', 'employee_name', 'period'],
      filters: ['draft', 'approved', 'posted', 'paid'].map((s) => ({ key: s, label: payroll.STATE_LABEL[s], group: 's', test: (r) => r.state === s })),
      groupBys: [{ key: 'period', label: 'Period', value: (r) => r.period }, { key: 'state', label: 'Status', value: (r) => payroll.STATE_LABEL[r.state] }],
    });
    const employees = await db.query("SELECT id, code, name FROM employees WHERE status = 'active' ORDER BY code");
    res.render('pages/payroll_list', { title: 'Payroll Simulation', list, employees, period: currentPeriod(), policy: policies.PAYROLL_POLICY });
  });

  app.post('/payroll/generate', ui.need('payroll.view'), async (req, res) => {
    const ids = req.body.employee_id ? [Number(req.body.employee_id)] : null;
    const r = await payroll.generatePayslips(ui.ctx(req), { period: req.body.period, employeeIds: ids });
    ui.flash(req, 'success', `${r.created.length} payslip draft dibuat${r.skipped.length ? `; dilewati (sudah ada): ${r.skipped.join(', ')}` : ''}.`);
    res.redirect(r.created.length === 1 ? `/payroll/${r.created[0].id}` : '/payroll');
  });

  app.get('/payroll/:id', ui.need('payroll.view'), async (req, res) => {
    res.locals.setApp(req.user.role === 'hr' ? 'employees' : 'accounting');
    const ps = await payroll.getPayslip(Number(req.params.id));
    const related = [{ label: `Employee ${ps.employee_code}`, href: `/employees/${ps.employee_id}` }];
    if (ps.journal_entry_id) related.push({ label: `Salary Journal ${ps.entry_number}`, href: `/accounting/entries/${ps.journal_entry_id}` });
    if (ps.payment_entry_id) related.push({ label: `Bank Payment ${ps.payment_number}`, href: `/accounting/entries/${ps.payment_entry_id}` });
    res.render('pages/payslip_form', {
      title: ps.number, ps, policy: policies.PAYROLL_POLICY,
      chatter: await loadChatter('hr.payslip', ps.id, { numbers: [ps.number, ps.entry_number, ps.payment_number].filter(Boolean), related }),
    });
  });

  app.post('/payroll/:id/:action', ui.need('payroll.view'), async (req, res) => {
    const id = Number(req.params.id);
    const ctx = ui.ctx(req);
    const map = {
      attendance: () => payroll.updateAttendance(ctx, id, req.body.attended_days),
      approve: () => payroll.approvePayslip(ctx, id),
      post: () => payroll.postPayslip(ctx, id),
      pay: () => payroll.payPayslip(ctx, id),
    };
    if (!map[req.params.action]) return res.redirect(`/payroll/${id}`);
    await map[req.params.action]();
    ui.flash(req, 'success', { attendance: 'Hari hadir disimpan.', approve: 'Payslip disetujui HR.', post: 'Gaji diposting ke Accounting.', pay: 'Gaji dibayar via bank.' }[req.params.action]);
    res.redirect(`/payroll/${id}`);
  });
};
