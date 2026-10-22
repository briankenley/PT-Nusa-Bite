'use strict';
const { q, q1, getPool } = require('../db');
const { run } = require('../lib/action');
const { requirePerm, can } = require('../lib/acl');
const { BusinessError, AccessError, NotFoundError } = require('../lib/errors');
const { nowStr } = require('../lib/time');
const { toInt, rp } = require('../lib/money');
const audit = require('../lib/audit');
const { creditExposure } = require('./exposure');

const TYPES = ['company', 'person'];

async function listContacts() {
  const rows = await q(getPool(), `SELECT p.*,
      COALESCE((SELECT SUM(l.debit - l.credit) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id AND e.state = 'posted'
        WHERE l.account_code = '110' AND l.partner_id = p.id), 0) AS ar_balance,
      COALESCE((SELECT SUM(l.credit - l.debit) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id AND e.state = 'posted'
        WHERE l.account_code = '201' AND l.partner_id = p.id), 0) AS ap_balance
    FROM partners p ORDER BY p.is_vendor, p.code`);
  return rows.map((r) => ({ ...r, ar_balance: Number(r.ar_balance), ap_balance: Number(r.ap_balance) }));
}

async function getContact(id) {
  const pool = getPool();
  const p = await q1(pool, 'SELECT * FROM partners WHERE id = ?', [id]);
  if (!p) throw new NotFoundError('Kontak tidak ditemukan');
  p.exposure = p.is_customer ? await creditExposure(pool, p.id) : null;
  p.sale_count = (await q1(pool, 'SELECT COUNT(*) c FROM sale_orders WHERE partner_id = ?', [id])).c;
  p.purchase_count = (await q1(pool, 'SELECT COUNT(*) c FROM purchase_orders WHERE partner_id = ?', [id])).c;
  p.invoice_count = (await q1(pool, 'SELECT COUNT(*) c FROM invoices WHERE partner_id = ?', [id])).c;
  return p;
}

function normalize(data) {
  return {
    code: String(data.code || '').trim().toUpperCase(),
    name: String(data.name || '').trim(),
    partner_type: TYPES.includes(data.partner_type) ? data.partner_type : 'company',
    city: String(data.city || '').trim() || null,
    credit_limit: toInt(data.credit_limit, 0),
    payment_term_code: String(data.payment_term_code || 'COD').trim(),
    is_customer: data.is_customer ? 1 : 0,
    is_vendor: data.is_vendor ? 1 : 0,
  };
}

async function createContact(ctx, data) {
  const d = normalize(data);
  return run(ctx, { action: 'CONTACT_CREATE', docType: 'res.partner', docNumber: d.code }, async (conn) => {
    if (!d.is_customer && !d.is_vendor) d.is_customer = 1;
    if (d.is_customer) requirePerm(ctx, 'contacts.create_customer', d.code);
    if (d.is_vendor) requirePerm(ctx, 'contacts.create_vendor', d.code);
    if (!/^[A-Z0-9-]{2,20}$/.test(d.code)) throw new BusinessError('ID kontak wajib 2–20 karakter huruf/angka (contoh C07).', { rule: 'SR-12', docNumber: d.code });
    if (!d.name) throw new BusinessError('Nama kontak wajib diisi.', { rule: 'SR-12', docNumber: d.code });
    const existing = await q1(conn, 'SELECT id, name FROM partners WHERE code = ?', [d.code]);
    if (existing) {
      throw new BusinessError(`ID ${d.code} sudah dipakai oleh "${existing.name}". Duplikasi kontak dicegah (SR-12).`, {
        rule: 'SR-12', docNumber: d.code, detail: { existing_id: existing.id },
      });
    }
    const term = await q1(conn, 'SELECT code FROM payment_terms WHERE code = ?', [d.payment_term_code]);
    if (!term) throw new BusinessError(`Payment terms ${d.payment_term_code} tidak dikenal.`, { rule: 'SR-09' });
    if (!can(ctx.user.role, 'contacts.edit_credit') && (d.credit_limit !== 0 || d.payment_term_code !== 'COD')) {
      throw new AccessError('Credit limit dan payment terms hanya boleh diatur Finance/Owner (SR-13, SR-09).', { perm: 'contacts.edit_credit', docNumber: d.code });
    }
    if (d.credit_limit < 0) throw new BusinessError('Credit limit tidak boleh negatif.', { rule: 'SR-09' });
    const now = nowStr();
    const [r] = await conn.query(`INSERT INTO partners (code, name, partner_type, is_customer, is_vendor, city, credit_limit, payment_term_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [d.code, d.name, d.partner_type, d.is_customer, d.is_vendor, d.city, d.credit_limit, d.payment_term_code, now, now]);
    await audit.log(conn, ctx, { action: 'CONTACT_CREATE', docType: 'res.partner', docId: r.insertId, docNumber: d.code, message: `Kontak ${d.code} ${d.name} dibuat`, detail: d });
    await audit.note(conn, ctx, 'res.partner', r.insertId, `Kontak dibuat (credit limit ${rp(d.credit_limit)}, ${d.payment_term_code}).`);
    return r.insertId;
  });
}

async function updateContact(ctx, id, data) {
  return run(ctx, { action: 'CONTACT_UPDATE', docType: 'res.partner', docId: id }, async (conn) => {
    const p = await q1(conn, 'SELECT * FROM partners WHERE id = ? FOR UPDATE', [id]);
    if (!p) throw new NotFoundError('Kontak tidak ditemukan');
    if (p.is_customer) requirePerm(ctx, 'contacts.create_customer', p.code);
    if (p.is_vendor) requirePerm(ctx, 'contacts.create_vendor', p.code);
    const d = normalize({ ...p, ...data, is_customer: p.is_customer, is_vendor: p.is_vendor });
    if (data.code !== undefined && d.code !== p.code) {
      throw new BusinessError(`ID kontak ${p.code} adalah identitas tetap dan tidak boleh diubah menjadi ${d.code} (SR-12).`, { rule: 'SR-12', docNumber: p.code });
    }
    if (!d.name) throw new BusinessError('Nama kontak wajib diisi.', { rule: 'SR-12', docNumber: p.code });
    const creditChanged = d.credit_limit !== Number(p.credit_limit) || d.payment_term_code !== p.payment_term_code;
    if (creditChanged) requirePerm(ctx, 'contacts.edit_credit', p.code);
    if (d.credit_limit < 0) throw new BusinessError('Credit limit tidak boleh negatif.', { rule: 'SR-09', docNumber: p.code });
    const changes = {};
    for (const f of ['name', 'partner_type', 'city', 'credit_limit', 'payment_term_code']) {
      if (String(d[f] ?? '') !== String(p[f] ?? '')) changes[f] = { old: p[f], new: d[f] };
    }
    if (!Object.keys(changes).length) return id;
    await q(conn, 'UPDATE partners SET name = ?, partner_type = ?, city = ?, credit_limit = ?, payment_term_code = ?, updated_at = ? WHERE id = ?',
      [d.name, d.partner_type, d.city, d.credit_limit, d.payment_term_code, nowStr(), id]);
    await audit.log(conn, ctx, { action: 'CONTACT_UPDATE', docType: 'res.partner', docId: id, docNumber: p.code, message: `Perubahan ${Object.keys(changes).join(', ')}`, detail: changes });
    await audit.note(conn, ctx, 'res.partner', id, `Diubah: ${Object.entries(changes).map(([k, v]) => `${k} ${v.old} → ${v.new}`).join('; ')}`);
    return id;
  });
}

async function listTerms() {
  return q(getPool(), 'SELECT * FROM payment_terms ORDER BY due_days');
}

module.exports = { listContacts, getContact, createContact, updateContact, listTerms };
