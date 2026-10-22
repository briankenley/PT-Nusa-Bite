'use strict';
const { q, q1, getPool } = require('../db');
const { run } = require('../lib/action');
const { requirePerm } = require('../lib/acl');
const { BusinessError, NotFoundError } = require('../lib/errors');
const { nextNumber } = require('../lib/sequence');
const { nowStr, todayStr } = require('../lib/time');
const { rp, toInt } = require('../lib/money');
const audit = require('../lib/audit');

const JOURNALS = {
  MISC: 'Miscellaneous',
  INV: 'Customer Invoices',
  RINV: 'Credit Notes',
  BILL: 'Vendor Bills',
  STJ: 'Stock Journal',
  BNK: 'Bank',
  CSH: 'Cash',
  SAL: 'Salaries',
};

/**
 * Posting jurnal berpasangan. Ditolak bila tidak seimbang atau bila event_key yang sama
 * sudah pernah diposting (satu kejadian bisnis = maksimal satu jurnal, SR-12).
 */
async function postEntry(conn, ctx, { journal, date, ref, sourceType, sourceId, eventKey, number, lines }) {
  const clean = lines
    .map((l) => ({ ...l, debit: Math.round(l.debit || 0), credit: Math.round(l.credit || 0) }))
    .filter((l) => l.debit > 0 || l.credit > 0);
  const totalDebit = clean.reduce((s, l) => s + l.debit, 0);
  const totalCredit = clean.reduce((s, l) => s + l.credit, 0);
  if (totalDebit !== totalCredit) {
    throw new BusinessError(`Jurnal tidak seimbang: debit ${rp(totalDebit)} ≠ kredit ${rp(totalCredit)} (SR-12).`, { rule: 'SR-12' });
  }
  if (totalDebit <= 0) throw new BusinessError('Jurnal tanpa nilai tidak dapat diposting.', { rule: 'SR-12' });
  if (eventKey) {
    const dup = await q1(conn, 'SELECT number FROM journal_entries WHERE event_key = ?', [eventKey]);
    if (dup) {
      throw new BusinessError(`Kejadian bisnis "${eventKey}" sudah diposting sebagai ${dup.number}; posting kedua ditolak (SR-12).`, {
        rule: 'SR-12', detail: { event_key: eventKey, existing: dup.number },
      });
    }
  }
  const num = number || (await nextNumber(conn, `journal.${journal}`));
  const now = nowStr();
  const u = ctx && ctx.user ? ctx.user.id : null;
  const [res] = await conn.query(
    `INSERT INTO journal_entries (number, journal, entry_date, ref, source_type, source_id, event_key, state, total_debit, total_credit, created_by, created_at, posted_by, posted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?, ?, ?)`,
    [num, journal, date || todayStr(), ref || null, sourceType || null, sourceId || null, eventKey || null, totalDebit, totalCredit, u, now, u, now],
  );
  for (const l of clean) {
    await q(conn, 'INSERT INTO journal_lines (entry_id, account_code, partner_id, label, debit, credit) VALUES (?, ?, ?, ?, ?, ?)',
      [res.insertId, l.account, l.partnerId || null, l.label || null, l.debit, l.credit]);
  }
  await audit.log(conn, ctx, {
    action: 'JOURNAL_POST', docType: 'account.entry', docId: res.insertId, docNumber: num,
    message: `${num} diposting: debit = kredit = ${rp(totalDebit)}`, detail: { event_key: eventKey, ref },
  });
  return { id: res.insertId, number: num, total: totalDebit };
}

async function accountBalance(conn, code) {
  const r = await q1(conn, `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS bal FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id AND e.state = 'posted' WHERE l.account_code = ?`, [code]);
  return Number(r.bal);
}

async function partnerBalance(conn, code, partnerId) {
  const r = await q1(conn, `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS bal FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id AND e.state = 'posted' WHERE l.account_code = ? AND l.partner_id = ?`, [code, partnerId]);
  return Number(r.bal);
}

async function trialBalance({ dateTo } = {}) {
  const pool = getPool();
  const params = [];
  let dateCond = '';
  if (dateTo) { dateCond = 'AND e.entry_date <= ?'; params.push(dateTo); }
  const rows = await q(pool, `SELECT a.code, a.name, a.account_type,
      COALESCE(SUM(l.debit), 0) AS debit, COALESCE(SUM(l.credit), 0) AS credit
    FROM accounts a
    LEFT JOIN journal_lines l ON l.account_code = a.code
      AND l.entry_id IN (SELECT e.id FROM journal_entries e WHERE e.state = 'posted' ${dateCond})
    GROUP BY a.code, a.name, a.account_type ORDER BY a.code`, params);
  for (const r of rows) {
    r.debit = Number(r.debit); r.credit = Number(r.credit);
    r.balance = r.debit - r.credit;
  }
  const totals = rows.reduce((t, r) => ({ debit: t.debit + r.debit, credit: t.credit + r.credit }), { debit: 0, credit: 0 });
  return { rows, totals, balanced: totals.debit === totals.credit };
}

async function ledger(accountCode, { partnerId } = {}) {
  const pool = getPool();
  const acc = await q1(pool, 'SELECT * FROM accounts WHERE code = ?', [accountCode]);
  if (!acc) throw new NotFoundError('Akun tidak ditemukan');
  const params = [accountCode];
  let cond = '';
  if (partnerId) { cond = 'AND l.partner_id = ?'; params.push(partnerId); }
  const lines = await q(pool, `SELECT l.*, e.number, e.entry_date, e.ref, e.journal, e.id AS entry_id, p.code AS partner_code, p.name AS partner_name
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id AND e.state = 'posted'
    LEFT JOIN partners p ON p.id = l.partner_id
    WHERE l.account_code = ? ${cond} ORDER BY e.entry_date, e.id, l.id`, params);
  let running = 0;
  for (const l of lines) { running += l.debit - l.credit; l.running = running; }
  return { account: acc, lines, balance: running };
}

async function listEntries() {
  return q(getPool(), `SELECT e.*, u.username AS posted_by_name FROM journal_entries e
    LEFT JOIN users u ON u.id = e.posted_by ORDER BY e.id DESC`);
}

async function getEntry(id) {
  const pool = getPool();
  const entry = await q1(pool, `SELECT e.*, u.username AS posted_by_name, c.username AS created_by_name FROM journal_entries e
    LEFT JOIN users u ON u.id = e.posted_by LEFT JOIN users c ON c.id = e.created_by WHERE e.id = ?`, [id]);
  if (!entry) throw new NotFoundError('Journal Entry tidak ditemukan');
  entry.lines = await q(pool, `SELECT l.*, a.name AS account_name, p.code AS partner_code, p.name AS partner_name
    FROM journal_lines l JOIN accounts a ON a.code = l.account_code LEFT JOIN partners p ON p.id = l.partner_id
    WHERE l.entry_id = ? ORDER BY l.id`, [id]);
  return entry;
}

async function listAccounts() {
  return q(getPool(), 'SELECT * FROM accounts ORDER BY code');
}

function parseManualLines(raw) {
  return (raw || [])
    .map((l) => ({ account: String(l.account || '').trim(), label: String(l.label || '').trim(), debit: toInt(l.debit), credit: toInt(l.credit) }))
    .filter((l) => l.account && (l.debit > 0 || l.credit > 0));
}

/** Jurnal manual (Finance): dibuat Draft lalu diposting; harus seimbang. */
async function createManualEntry(ctx, { date, ref, lines }) {
  return run(ctx, { action: 'JOURNAL_MANUAL_CREATE', docType: 'account.entry' }, async (conn) => {
    requirePerm(ctx, 'accounting.edit');
    const clean = parseManualLines(lines);
    if (clean.length < 2) throw new BusinessError('Jurnal manual minimal dua baris.', { rule: 'SR-12' });
    for (const l of clean) {
      if (l.debit > 0 && l.credit > 0) throw new BusinessError('Satu baris tidak boleh berisi debit dan kredit sekaligus.', { rule: 'SR-12' });
      const acc = await q1(conn, 'SELECT code FROM accounts WHERE code = ?', [l.account]);
      if (!acc) throw new BusinessError(`Akun ${l.account} tidak ada di Chart of Accounts.`, { rule: 'SR-12' });
    }
    const td = clean.reduce((s, l) => s + l.debit, 0);
    const tc = clean.reduce((s, l) => s + l.credit, 0);
    if (td !== tc) throw new BusinessError(`Jurnal tidak seimbang: debit ${rp(td)} ≠ kredit ${rp(tc)} (SR-12).`, { rule: 'SR-12' });
    const now = nowStr();
    const [res] = await conn.query(`INSERT INTO journal_entries (number, journal, entry_date, ref, source_type, state, total_debit, total_credit, created_by, created_at)
      VALUES (NULL, 'MISC', ?, ?, 'manual', 'draft', ?, ?, ?, ?)`, [date || todayStr(), ref || 'Jurnal manual', td, tc, ctx.user.id, now]);
    for (const l of clean) {
      await q(conn, 'INSERT INTO journal_lines (entry_id, account_code, label, debit, credit) VALUES (?, ?, ?, ?, ?)', [res.insertId, l.account, l.label, l.debit, l.credit]);
    }
    await audit.log(conn, ctx, { action: 'JOURNAL_MANUAL_CREATE', docType: 'account.entry', docId: res.insertId, message: `Draft jurnal manual ${rp(td)}` });
    return res.insertId;
  });
}

async function postManualEntry(ctx, id) {
  return run(ctx, { action: 'JOURNAL_MANUAL_POST', docType: 'account.entry', docId: id }, async (conn) => {
    requirePerm(ctx, 'accounting.edit');
    const e = await q1(conn, 'SELECT * FROM journal_entries WHERE id = ? FOR UPDATE', [id]);
    if (!e) throw new NotFoundError('Journal Entry tidak ditemukan');
    if (e.state !== 'draft') {
      throw new BusinessError(`${e.number} sudah Posted; permintaan Post kedua ditolak (SR-12).`, { rule: 'SR-12', docNumber: e.number });
    }
    const number = await nextNumber(conn, 'journal.MISC');
    const now = nowStr();
    await q(conn, "UPDATE journal_entries SET number = ?, state = 'posted', event_key = ?, posted_by = ?, posted_at = ? WHERE id = ?",
      [number, `manual:${id}`, ctx.user.id, now, id]);
    await audit.log(conn, ctx, { action: 'JOURNAL_POST', docType: 'account.entry', docId: id, docNumber: number, message: `${number} diposting (manual) ${rp(e.total_debit)}` });
    return number;
  });
}

module.exports = {
  JOURNALS, postEntry, accountBalance, partnerBalance, trialBalance, ledger, listEntries, getEntry, listAccounts,
  createManualEntry, postManualEntry,
};
