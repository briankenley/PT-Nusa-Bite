'use strict';
const { q, q1, getPool } = require('../db');
const { run } = require('../lib/action');
const { requirePerm } = require('../lib/acl');
const { BusinessError, NotFoundError } = require('../lib/errors');
const { nowStr, todayStr } = require('../lib/time');
const { roundDiv, rp, toInt } = require('../lib/money');
const audit = require('../lib/audit');
const policies = require('../policies');
const { postEntry } = require('./accounting');

const STATE_LABEL = { draft: 'Draft', approved: 'Approved', posted: 'Posted', paid: 'Paid' };

/**
 * Hitung payslip (keputusan D-05):
 * - proportional (SR-17): gaji pokok × hadir ÷ rencana, dibulatkan ke Rupiah terdekat;
 * - full (SR-16): gaji pokok penuh untuk karyawan Active.
 * Tunjangan tetap dibayar penuh jika hadir minimal 1 hari. Tanpa PPh 21/BPJS/lembur (lingkup simulasi).
 */
function computePayslip({ baseSalary, allowance, plannedDays, attendedDays, policy = policies.PAYROLL_POLICY }) {
  const basePaid = policy === 'full' ? baseSalary : roundDiv(baseSalary * attendedDays, plannedDays);
  const allowancePaid = attendedDays >= 1 ? allowance : 0;
  const gross = basePaid + allowancePaid;
  return { basePaid, allowancePaid, gross, net: gross };
}

function payslipNumber(period, code) {
  return `PAY/${period}/${code}`;
}

async function listPayslips() {
  return q(getPool(), `SELECT ps.*, e.code AS employee_code, e.name AS employee_name, e.job_title FROM payslips ps
    JOIN employees e ON e.id = ps.employee_id ORDER BY ps.period DESC, e.code`);
}

async function getPayslip(id) {
  const pool = getPool();
  const ps = await q1(pool, `SELECT ps.*, e.code AS employee_code, e.name AS employee_name, e.job_title, l.code AS location_code,
      je.number AS entry_number, pe.number AS payment_number, cu.username AS created_by_name, au.username AS approved_by_name,
      pu.username AS posted_by_name, du.username AS paid_by_name
    FROM payslips ps JOIN employees e ON e.id = ps.employee_id JOIN locations l ON l.id = e.location_id
    LEFT JOIN journal_entries je ON je.id = ps.journal_entry_id LEFT JOIN journal_entries pe ON pe.id = ps.payment_entry_id
    LEFT JOIN users cu ON cu.id = ps.created_by LEFT JOIN users au ON au.id = ps.approved_by
    LEFT JOIN users pu ON pu.id = ps.posted_by LEFT JOIN users du ON du.id = ps.paid_by WHERE ps.id = ?`, [id]);
  if (!ps) throw new NotFoundError('Payslip tidak ditemukan');
  return ps;
}

/** Buat payslip Draft untuk satu atau semua karyawan Active. Satu payslip per karyawan per periode (SR-12). */
async function generatePayslips(ctx, { period, employeeIds = null }) {
  return run(ctx, { action: 'PAYSLIP_GENERATE', docType: 'hr.payslip', detail: { period } }, async (conn) => {
    requirePerm(ctx, 'payroll.prepare');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))) throw new BusinessError('Periode berformat YYYY-MM (contoh 2026-10).', { rule: 'SR-17' });
    const single = Array.isArray(employeeIds) && employeeIds.length === 1;
    let employees;
    if (employeeIds && employeeIds.length) {
      employees = await q(conn, `SELECT * FROM employees WHERE id IN (${employeeIds.map(() => '?').join(',')}) FOR UPDATE`, employeeIds.map(Number));
    } else {
      employees = await q(conn, "SELECT * FROM employees WHERE status = 'active' ORDER BY code FOR UPDATE");
    }
    const created = [];
    const skipped = [];
    const now = nowStr();
    for (const e of employees) {
      const number = payslipNumber(period, e.code);
      const existing = await q1(conn, 'SELECT number, state FROM payslips WHERE employee_id = ? AND period = ?', [e.id, period]);
      if (existing) {
        if (single) {
          throw new BusinessError(`Payslip ${existing.number} sudah ada (status ${STATE_LABEL[existing.state]}). Payroll karyawan dan periode yang sama tidak boleh dibuat atau diposting dua kali (SR-12, SR-17).`, {
            rule: 'SR-12', docNumber: existing.number,
          });
        }
        skipped.push(existing.number);
        continue;
      }
      if (e.status !== 'active') {
        if (single) throw new BusinessError(`${e.code} berstatus Inactive; tidak diproses payroll.`, { rule: 'SR-15', docNumber: number });
        continue;
      }
      const c = computePayslip({ baseSalary: e.base_salary, allowance: e.fixed_allowance, plannedDays: e.planned_days, attendedDays: e.attended_days });
      const [r] = await conn.query(`INSERT INTO payslips (number, employee_id, period, planned_days, attended_days, base_salary, fixed_allowance, base_paid, allowance_paid,
          gross, net, state, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      [number, e.id, period, e.planned_days, e.attended_days, e.base_salary, e.fixed_allowance, c.basePaid, c.allowancePaid, c.gross, c.net, ctx.user.id, now]);
      await audit.log(conn, ctx, { action: 'PAYSLIP_CREATE', docType: 'hr.payslip', docId: r.insertId, docNumber: number, message: `Draft ${e.attended_days}/${e.planned_days} hari; gross ${rp(c.gross)}` });
      await audit.note(conn, ctx, 'hr.payslip', r.insertId, `Draft dibuat: gaji pokok ${rp(c.basePaid)} + tunjangan ${rp(c.allowancePaid)} = ${rp(c.gross)} (kebijakan ${policies.PAYROLL_POLICY}).`);
      created.push({ id: r.insertId, number });
    }
    return { created, skipped };
  });
}

async function updateAttendance(ctx, id, attendedDays) {
  return run(ctx, { action: 'PAYSLIP_UPDATE', docType: 'hr.payslip', docId: id }, async (conn) => {
    requirePerm(ctx, 'payroll.prepare');
    const ps = await q1(conn, 'SELECT * FROM payslips WHERE id = ? FOR UPDATE', [id]);
    if (!ps) throw new NotFoundError('Payslip tidak ditemukan');
    if (ps.state !== 'draft') throw new BusinessError(`${ps.number} sudah ${STATE_LABEL[ps.state]}; hari hadir terkunci.`, { rule: 'SR-12', docNumber: ps.number });
    const days = toInt(attendedDays, -1);
    if (days < 0 || days > ps.planned_days) throw new BusinessError(`Hari hadir harus 0–${ps.planned_days}.`, { rule: 'SR-17', docNumber: ps.number });
    const c = computePayslip({ baseSalary: ps.base_salary, allowance: ps.fixed_allowance, plannedDays: ps.planned_days, attendedDays: days });
    await q(conn, 'UPDATE payslips SET attended_days = ?, base_paid = ?, allowance_paid = ?, gross = ?, net = ? WHERE id = ?', [days, c.basePaid, c.allowancePaid, c.gross, c.net, id]);
    await audit.log(conn, ctx, { action: 'PAYSLIP_UPDATE', docType: 'hr.payslip', docId: id, docNumber: ps.number, message: `Hari hadir ${ps.attended_days} → ${days}; gross ${rp(c.gross)}` });
    await audit.note(conn, ctx, 'hr.payslip', id, `Hari hadir ${ps.attended_days} → ${days}. Gross ${rp(ps.gross)} → ${rp(c.gross)}.`);
    return id;
  });
}

async function transition(ctx, id, { action, perm, from, to, label }, extra) {
  return run(ctx, { action, docType: 'hr.payslip', docId: id }, async (conn) => {
    requirePerm(ctx, perm);
    const ps = await q1(conn, 'SELECT ps.*, e.code AS employee_code, e.name AS employee_name FROM payslips ps JOIN employees e ON e.id = ps.employee_id WHERE ps.id = ? FOR UPDATE', [id]);
    if (!ps) throw new NotFoundError('Payslip tidak ditemukan');
    if (ps.state !== from) {
      throw new BusinessError(`${ps.number} berstatus ${STATE_LABEL[ps.state]}; aksi "${label}" hanya untuk status ${STATE_LABEL[from]}. Payroll yang sama tidak boleh diposting/dibayar dua kali (SR-12).`, {
        rule: 'SR-12', docNumber: ps.number,
      });
    }
    const now = nowStr();
    const result = extra ? await extra(conn, ps) : {};
    const col = { approved: 'approved', posted: 'posted', paid: 'paid' }[to];
    await q(conn, `UPDATE payslips SET state = ?, ${col}_by = ?, ${col}_at = ? ${result.set || ''} WHERE id = ?`, [to, ctx.user.id, now, ...(result.params || []), id]);
    await audit.log(conn, ctx, { action, docType: 'hr.payslip', docId: id, docNumber: ps.number, message: `${STATE_LABEL[from]} → ${STATE_LABEL[to]}${result.msg ? `; ${result.msg}` : ''}` });
    await audit.note(conn, ctx, 'hr.payslip', id, `${label}: ${STATE_LABEL[from]} → ${STATE_LABEL[to]}.${result.msg ? ` ${result.msg}.` : ''}`);
    return id;
  });
}

function approvePayslip(ctx, id) {
  return transition(ctx, id, { action: 'PAYSLIP_APPROVE', perm: 'payroll.prepare', from: 'draft', to: 'approved', label: 'Approve' });
}

/** Posting gaji ke Accounting: Dr Salary Expense / Cr Salary Payable. */
function postPayslip(ctx, id) {
  return transition(ctx, id, { action: 'PAYSLIP_POST', perm: 'payroll.post', from: 'approved', to: 'posted', label: 'Post' }, async (conn, ps) => {
    const entry = await postEntry(conn, ctx, {
      journal: 'SAL', ref: `Salary ${ps.number} ${ps.employee_name}`, sourceType: 'hr.payslip', sourceId: ps.id,
      eventKey: `payslip:${ps.employee_id}:${ps.period}:post`,
      lines: [
        { account: '601', label: `Salary expense ${ps.employee_code} ${ps.period}`, debit: ps.gross },
        { account: '203', label: `Salary payable ${ps.employee_code} ${ps.period}`, credit: ps.net },
      ],
    });
    return { set: ', journal_entry_id = ?', params: [entry.id], msg: `jurnal ${entry.number} ${rp(ps.gross)}` };
  });
}

/** Pembayaran gaji via bank: Dr Salary Payable / Cr Bank. */
function payPayslip(ctx, id) {
  return transition(ctx, id, { action: 'PAYSLIP_PAY', perm: 'payroll.post', from: 'posted', to: 'paid', label: 'Bank Payment' }, async (conn, ps) => {
    const entry = await postEntry(conn, ctx, {
      journal: 'BNK', date: todayStr(), ref: `Salary payment ${ps.number}`, sourceType: 'hr.payslip', sourceId: ps.id,
      eventKey: `payslip:${ps.employee_id}:${ps.period}:pay`,
      lines: [
        { account: '203', label: `Pelunasan gaji ${ps.employee_code} ${ps.period}`, debit: ps.net },
        { account: '102', label: `Transfer gaji ${ps.employee_code}`, credit: ps.net },
      ],
    });
    return { set: ', payment_entry_id = ?', params: [entry.id], msg: `pembayaran ${entry.number} ${rp(ps.net)}` };
  });
}

module.exports = { STATE_LABEL, computePayslip, listPayslips, getPayslip, generatePayslips, updateAttendance, approvePayslip, postPayslip, payPayslip };
