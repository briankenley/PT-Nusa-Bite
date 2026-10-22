'use strict';
const { q, q1, getPool } = require('../db');
const { run } = require('../lib/action');
const { requirePerm } = require('../lib/acl');
const { BusinessError, NotFoundError } = require('../lib/errors');
const { nowStr } = require('../lib/time');
const { toInt, rp } = require('../lib/money');
const audit = require('../lib/audit');

const FIELDS = ['name', 'job_title', 'location_id', 'start_date', 'status', 'base_salary', 'fixed_allowance', 'planned_days', 'attended_days'];
const MONEY = ['base_salary', 'fixed_allowance'];

async function listEmployees() {
  return q(getPool(), `SELECT e.*, l.code AS location_code, l.name AS location_name FROM employees e
    JOIN locations l ON l.id = e.location_id ORDER BY e.code`);
}

async function getEmployee(id) {
  const pool = getPool();
  const e = await q1(pool, `SELECT e.*, l.code AS location_code, l.name AS location_name FROM employees e
    JOIN locations l ON l.id = e.location_id WHERE e.id = ?`, [id]);
  if (!e) throw new NotFoundError('Karyawan tidak ditemukan');
  e.history = await q(pool, 'SELECT * FROM employee_history WHERE employee_id = ? ORDER BY id DESC', [id]);
  e.payslips = await q(pool, 'SELECT id, number, period, gross, state FROM payslips WHERE employee_id = ? ORDER BY period DESC', [id]);
  return e;
}

function normalize(data) {
  return {
    code: String(data.code || '').trim().toUpperCase(),
    name: String(data.name || '').trim(),
    job_title: String(data.job_title || '').trim(),
    location_id: Number(data.location_id) || null,
    start_date: String(data.start_date || '').slice(0, 10),
    status: data.status === 'inactive' ? 'inactive' : 'active',
    base_salary: toInt(data.base_salary, 0),
    fixed_allowance: toInt(data.fixed_allowance, 0),
    planned_days: toInt(data.planned_days, 22),
    attended_days: toInt(data.attended_days, 0),
  };
}

async function validate(conn, d) {
  if (!d.name || !d.job_title) throw new BusinessError('Nama dan jabatan wajib diisi (SR-15).', { rule: 'SR-15', docNumber: d.code });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.start_date)) throw new BusinessError('Tanggal mulai wajib (YYYY-MM-DD).', { rule: 'SR-15', docNumber: d.code });
  const loc = await q1(conn, "SELECT id FROM locations WHERE id = ? AND usage_type = 'internal'", [d.location_id]);
  if (!loc) throw new BusinessError('Unit kerja harus lokasi internal (WH-PKU / OUTLET-SUD).', { rule: 'SR-15', docNumber: d.code });
  if (d.base_salary < 0 || d.fixed_allowance < 0) throw new BusinessError('Tarif gaji tidak boleh negatif.', { rule: 'SR-15', docNumber: d.code });
  if (d.planned_days <= 0 || d.attended_days < 0 || d.attended_days > d.planned_days) {
    throw new BusinessError('Hari hadir harus 0 sampai hari rencana.', { rule: 'SR-17', docNumber: d.code });
  }
}

async function createEmployee(ctx, data) {
  const d = normalize(data);
  return run(ctx, { action: 'EMPLOYEE_CREATE', docType: 'hr.employee', docNumber: d.code }, async (conn) => {
    requirePerm(ctx, 'employees.edit', d.code);
    if (!/^E\d{2,4}$/.test(d.code)) throw new BusinessError('Employee ID berformat E + angka (contoh E07).', { rule: 'SR-15', docNumber: d.code });
    const dup = await q1(conn, 'SELECT name FROM employees WHERE code = ?', [d.code]);
    if (dup) throw new BusinessError(`Employee ID ${d.code} sudah dipakai oleh ${dup.name}; identitas karyawan harus unik (SR-15).`, { rule: 'SR-15', docNumber: d.code });
    await validate(conn, d);
    const now = nowStr();
    const [r] = await conn.query(`INSERT INTO employees (code, name, job_title, location_id, start_date, status, base_salary, fixed_allowance, planned_days, attended_days, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.code, d.name, d.job_title, d.location_id, d.start_date, d.status, d.base_salary, d.fixed_allowance, d.planned_days, d.attended_days, now, now]);
    await q(conn, `INSERT INTO employee_history (employee_id, field, old_value, new_value, changed_by, changed_by_name, changed_at)
      VALUES (?, 'created', NULL, ?, ?, ?, ?)`, [r.insertId, `${d.job_title}; gaji ${d.base_salary}; tunjangan ${d.fixed_allowance}`, ctx.user.id, ctx.user.username, now]);
    await audit.log(conn, ctx, { action: 'EMPLOYEE_CREATE', docType: 'hr.employee', docId: r.insertId, docNumber: d.code, message: `${d.code} ${d.name} dibuat` });
    await audit.note(conn, ctx, 'hr.employee', r.insertId, 'Karyawan dibuat.');
    return r.insertId;
  });
}

/** SR-13/SR-15: hanya HR/Owner yang boleh mengubah data dan tarif gaji; setiap perubahan tercatat di riwayat. */
async function updateEmployee(ctx, id, data) {
  return run(ctx, { action: 'EMPLOYEE_UPDATE', docType: 'hr.employee', docId: id, detail: { attempted: data } }, async (conn) => {
    const e = await q1(conn, 'SELECT * FROM employees WHERE id = ? FOR UPDATE', [id]);
    if (!e) throw new NotFoundError('Karyawan tidak ditemukan');
    requirePerm(ctx, 'employees.edit', e.code);
    const d = normalize({ ...e, ...data, code: e.code });
    if (data.code !== undefined && String(data.code).trim().toUpperCase() !== e.code) {
      throw new BusinessError(`Employee ID ${e.code} tidak boleh diubah agar identitas tidak tertukar antar-outlet (SR-15).`, { rule: 'SR-15', docNumber: e.code });
    }
    await validate(conn, d);
    const now = nowStr();
    const changes = [];
    for (const f of FIELDS) {
      if (String(d[f] ?? '') !== String(e[f] ?? '').slice(0, f === 'start_date' ? 10 : undefined)) {
        changes.push({ field: f, old: e[f], new: d[f] });
        await q(conn, `INSERT INTO employee_history (employee_id, field, old_value, new_value, changed_by, changed_by_name, changed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, f, String(e[f] ?? ''), String(d[f] ?? ''), ctx.user.id, ctx.user.username, now]);
      }
    }
    if (!changes.length) return id;
    await q(conn, `UPDATE employees SET name = ?, job_title = ?, location_id = ?, start_date = ?, status = ?, base_salary = ?, fixed_allowance = ?,
      planned_days = ?, attended_days = ?, updated_at = ? WHERE id = ?`,
    [d.name, d.job_title, d.location_id, d.start_date, d.status, d.base_salary, d.fixed_allowance, d.planned_days, d.attended_days, now, id]);
    const text = changes.map((c) => `${c.field}: ${MONEY.includes(c.field) ? `${rp(c.old)} → ${rp(c.new)}` : `${c.old} → ${c.new}`}`).join('; ');
    await audit.log(conn, ctx, { action: 'EMPLOYEE_UPDATE', docType: 'hr.employee', docId: id, docNumber: e.code, message: text, detail: { changes } });
    await audit.note(conn, ctx, 'hr.employee', id, `Diubah: ${text}.`);
    return id;
  });
}

module.exports = { listEmployees, getEmployee, createEmployee, updateEmployee };
