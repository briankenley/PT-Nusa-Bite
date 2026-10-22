'use strict';
const { q, q1, getPool } = require('../db');
const { run } = require('../lib/action');
const { requirePerm } = require('../lib/acl');
const { BusinessError, NotFoundError } = require('../lib/errors');
const { nextNumber } = require('../lib/sequence');
const { nowStr } = require('../lib/time');
const { toInt } = require('../lib/money');
const audit = require('../lib/audit');

const STAGES = [
  ['new', 'New'],
  ['qualified', 'Qualified'],
  ['proposition', 'Proposition'],
  ['won', 'Won'],
];

async function listLeads() {
  return q(getPool(), `SELECT l.*, p.code AS partner_code, p.name AS partner_name, o.number AS opportunity_number, o.id AS opportunity_id
    FROM crm_leads l LEFT JOIN partners p ON p.id = l.partner_id LEFT JOIN crm_opportunities o ON o.lead_id = l.id ORDER BY l.id DESC`);
}

async function getLead(id) {
  const pool = getPool();
  const lead = await q1(pool, `SELECT l.*, p.code AS partner_code, p.name AS partner_name, u.username AS converted_by_name
    FROM crm_leads l LEFT JOIN partners p ON p.id = l.partner_id LEFT JOIN users u ON u.id = l.converted_by WHERE l.id = ?`, [id]);
  if (!lead) throw new NotFoundError('Lead tidak ditemukan');
  lead.opportunity = await q1(pool, 'SELECT * FROM crm_opportunities WHERE lead_id = ?', [id]);
  return lead;
}

async function listOpportunities() {
  return q(getPool(), `SELECT o.*, l.number AS lead_number, p.code AS partner_code, p.name AS partner_name,
      (SELECT COUNT(*) FROM sale_orders s WHERE s.opportunity_id = o.id) AS order_count
    FROM crm_opportunities o JOIN crm_leads l ON l.id = o.lead_id LEFT JOIN partners p ON p.id = o.partner_id ORDER BY o.id DESC`);
}

async function getOpportunity(id) {
  const pool = getPool();
  const o = await q1(pool, `SELECT o.*, l.number AS lead_number, l.id AS lead_id, p.code AS partner_code, p.name AS partner_name
    FROM crm_opportunities o JOIN crm_leads l ON l.id = o.lead_id LEFT JOIN partners p ON p.id = o.partner_id WHERE o.id = ?`, [id]);
  if (!o) throw new NotFoundError('Opportunity tidak ditemukan');
  o.orders = await q(pool, 'SELECT id, number, state, amount_total FROM sale_orders WHERE opportunity_id = ? ORDER BY id', [id]);
  return o;
}

async function createLead(ctx, data) {
  return run(ctx, { action: 'LEAD_CREATE', docType: 'crm.lead' }, async (conn) => {
    requirePerm(ctx, 'crm.edit');
    const name = String(data.name || '').trim();
    if (!name) throw new BusinessError('Judul lead wajib diisi.', { rule: 'SR-22' });
    const number = await nextNumber(conn, 'crm.lead');
    const [r] = await conn.query('INSERT INTO crm_leads (number, name, partner_id, description, state, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [number, name, data.partner_id ? Number(data.partner_id) : null, String(data.description || '').trim() || null, 'new', ctx.user.id, nowStr()]);
    await audit.log(conn, ctx, { action: 'LEAD_CREATE', docType: 'crm.lead', docId: r.insertId, docNumber: number, message: `Lead ${number} dibuat` });
    await audit.note(conn, ctx, 'crm.lead', r.insertId, 'Lead dibuat.');
    return r.insertId;
  });
}

/** SR-22: lead hanya boleh dikonversi sekali menjadi Opportunity; tautannya tetap terbaca. */
async function convertLead(ctx, leadId, data = {}) {
  return run(ctx, { action: 'LEAD_CONVERT', docType: 'crm.lead', docId: leadId }, async (conn) => {
    requirePerm(ctx, 'crm.edit');
    const lead = await q1(conn, 'SELECT * FROM crm_leads WHERE id = ? FOR UPDATE', [leadId]);
    if (!lead) throw new NotFoundError('Lead tidak ditemukan');
    const existing = await q1(conn, 'SELECT number FROM crm_opportunities WHERE lead_id = ?', [leadId]);
    if (existing || lead.state === 'converted') {
      throw new BusinessError(`Lead ${lead.number} sudah dikonversi menjadi ${existing ? existing.number : 'Opportunity'}; konversi kedua ditolak (SR-22).`, {
        rule: 'SR-22', docNumber: lead.number, detail: { opportunity: existing ? existing.number : null },
      });
    }
    if (lead.state === 'lost') throw new BusinessError(`Lead ${lead.number} berstatus Lost.`, { rule: 'SR-22', docNumber: lead.number });
    const number = await nextNumber(conn, 'crm.opportunity');
    const now = nowStr();
    const [r] = await conn.query(`INSERT INTO crm_opportunities (number, lead_id, name, partner_id, stage, expected_revenue, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'new', ?, ?, ?, ?)`, [number, leadId, lead.name, lead.partner_id, toInt(data.expected_revenue, 0), ctx.user.id, now, now]);
    await q(conn, "UPDATE crm_leads SET state = 'converted', converted_by = ?, converted_at = ? WHERE id = ?", [ctx.user.id, now, leadId]);
    await audit.log(conn, ctx, { action: 'LEAD_CONVERT', docType: 'crm.lead', docId: leadId, docNumber: lead.number, message: `${lead.number} → ${number}`, detail: { opportunity: number } });
    await audit.note(conn, ctx, 'crm.lead', leadId, `Dikonversi menjadi Opportunity ${number}.`);
    await audit.note(conn, ctx, 'crm.opportunity', r.insertId, `Opportunity dibuat dari Lead ${lead.number}.`);
    return r.insertId;
  });
}

async function setStage(ctx, oppId, stage) {
  return run(ctx, { action: 'OPPORTUNITY_STAGE', docType: 'crm.opportunity', docId: oppId }, async (conn) => {
    requirePerm(ctx, 'crm.edit');
    if (!STAGES.some(([k]) => k === stage) && stage !== 'lost') throw new BusinessError('Stage tidak dikenal.', { rule: 'SR-22' });
    const o = await q1(conn, 'SELECT * FROM crm_opportunities WHERE id = ? FOR UPDATE', [oppId]);
    if (!o) throw new NotFoundError('Opportunity tidak ditemukan');
    if (o.stage === stage) return oppId;
    await q(conn, 'UPDATE crm_opportunities SET stage = ?, updated_at = ? WHERE id = ?', [stage, nowStr(), oppId]);
    await audit.log(conn, ctx, { action: 'OPPORTUNITY_STAGE', docType: 'crm.opportunity', docId: oppId, docNumber: o.number, message: `${o.stage} → ${stage}` });
    await audit.note(conn, ctx, 'crm.opportunity', oppId, `Stage: ${o.stage} → ${stage}.`);
    return oppId;
  });
}

module.exports = { STAGES, listLeads, getLead, listOpportunities, getOpportunity, createLead, convertLead, setStage };
