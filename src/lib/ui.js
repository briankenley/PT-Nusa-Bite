'use strict';
const { can } = require('./acl');
const { AccessError } = require('./errors');
const audit = require('./audit');

function flash(req, type, message, rule = null) {
  req.session.flash = [...(req.session.flash || []), { type, message, rule }];
}

/** Kembali ke halaman asal (hanya path di domain yang sama). */
function back(req, fallback = '/') {
  const cand = (req.body && req.body._back) || req.get('Referer') || fallback;
  try {
    const u = new URL(cand, 'http://local');
    return u.pathname + u.search + u.hash;
  } catch (_) {
    return fallback;
  }
}

function ctx(req) {
  return { user: req.user };
}

/** Middleware hak akses halaman; upaya tanpa hak dicatat sebagai "denied" di audit log (SR-13). */
function need(perm) {
  return async (req, res, next) => {
    if (req.user && can(req.user.role, perm)) return next();
    await audit.logOutside(ctx(req), {
      action: 'ACCESS_DENIED', docType: 'page', result: 'denied',
      message: `${req.method} ${req.originalUrl} memerlukan hak "${perm}"`, detail: { perm, path: req.originalUrl },
    });
    next(new AccessError(`Akses ditolak: peran ${req.user ? req.user.role : 'anonymous'} tidak memiliki hak "${perm}" untuk membuka ${req.originalUrl} (SR-13). Upaya ini dicatat di audit log.`, { perm }));
  };
}

const STATE = {
  draft: ['Draft', 'grey'], sale: ['Sales Order', 'green'], cancel: ['Cancelled', 'red'], purchase: ['Purchase Order', 'green'],
  ready: ['Ready', 'blue'], qc: ['Quality Check', 'orange'], done: ['Done', 'green'], waiting: ['Waiting', 'grey'],
  posted: ['Posted', 'green'], not_paid: ['Not Paid', 'red'], partial: ['Partially Paid', 'orange'], paid: ['Paid', 'green'],
  approved: ['Approved', 'blue'], active: ['Active', 'green'], inactive: ['Inactive', 'grey'],
  new: ['New', 'blue'], converted: ['Converted', 'green'], lost: ['Lost', 'red'], qualified: ['Qualified', 'blue'], proposition: ['Proposition', 'orange'], won: ['Won', 'green'],
  pending: ['Waiting Owner Approval', 'orange'], applied: ['Applied', 'green'], rejected: ['Rejected', 'red'], none: ['—', 'grey'],
  ok: ['OK', 'green'], denied: ['DENIED', 'red'],
};

function badge(state, label) {
  const [text, color] = STATE[state] || [state, 'grey'];
  return `<span class="badge badge-${color}">${escapeHtml(label || text)}</span>`;
}

function stateLabel(state) {
  return (STATE[state] || [state])[0];
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Ubah input form lines[i][field] menjadi array baris. */
function parseLines(body, map = { productId: 'product_id', qty: 'qty', unitPrice: 'unit_price', discountPct: 'discount' }) {
  const raw = body.lines || [];
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  return list.map((l) => {
    const out = {};
    for (const [k, v] of Object.entries(map)) out[k] = l[v];
    if (out.productId) out.productId = Number(out.productId);
    return out;
  }).filter((l) => l.productId);
}

/**
 * Form memakai kunci non-numerik (mis. done[m12]) karena parser qs memadatkan kunci angka
 * menjadi array dan ID baris akan hilang. Helper ini mengembalikan { '12': nilai }.
 */
function idMap(obj) {
  const out = {};
  if (!obj || Array.isArray(obj) || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const m = String(k).match(/^[a-z]+(\d+)$/i);
    if (m) out[m[1]] = v;
  }
  return out;
}

module.exports = { idMap, flash, back, ctx, need, badge, stateLabel, escapeHtml, parseLines, STATE };
