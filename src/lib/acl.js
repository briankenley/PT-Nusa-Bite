'use strict';
const { AccessError } = require('./errors');

const ROLES = {
  sales: 'Sales',
  warehouse: 'Warehouse',
  finance: 'Finance',
  hr: 'HR',
  cashier: 'Cashier',
  owner: 'Owner',
};

// Matriks hak akses (SR-13). Owner memegang semua hak.
const PERMS = {
  'contacts.view': ['sales', 'warehouse', 'finance'],
  'contacts.create_customer': ['sales', 'finance'],
  'contacts.create_vendor': ['warehouse', 'finance'],
  'contacts.edit_credit': ['finance'],
  'products.view': ['sales', 'warehouse', 'finance', 'cashier'],
  'products.edit': ['warehouse', 'finance'],
  'products.edit_price': ['finance'],
  'crm.view': ['sales'],
  'crm.edit': ['sales'],
  'sales.view': ['sales', 'finance', 'warehouse'],
  'sales.edit': ['sales'],
  'sales.approve_discount': [],
  'sales.revision_request': ['sales'],
  'sales.revision_approve': [],
  'counter.use': ['cashier', 'sales'],
  'inventory.view': ['warehouse', 'sales', 'finance', 'cashier'],
  'inventory.operate': ['warehouse'],
  'purchase.view': ['warehouse', 'finance'],
  'purchase.edit': ['warehouse'],
  'invoicing.view': ['finance', 'sales'],
  'invoicing.edit': ['finance'],
  'accounting.view': ['finance'],
  'accounting.edit': ['finance'],
  'employees.view': ['hr', 'finance'],
  'employees.edit': ['hr'],
  'payroll.view': ['hr', 'finance'],
  'payroll.prepare': ['hr'],
  'payroll.post': ['finance'],
  'dashboard.view': ['finance'],
  'audit.view': ['finance'],
  'admin.reset': [],
};

function can(role, perm) {
  if (!PERMS[perm]) throw new Error(`Permission tidak dikenal: ${perm}`);
  return role === 'owner' || PERMS[perm].includes(role);
}

function requirePerm(ctx, perm, docNumber = null) {
  const role = ctx && ctx.user ? ctx.user.role : 'anonymous';
  if (!ctx || !ctx.user || !can(role, perm)) {
    throw new AccessError(`Akses ditolak: peran ${ROLES[role] || role} tidak memiliki hak "${perm}" (SR-13).`, { perm, docNumber });
  }
}

function permsFor(role) {
  const out = {};
  for (const p of Object.keys(PERMS)) out[p] = can(role, p);
  return out;
}

module.exports = { ROLES, PERMS, can, requirePerm, permsFor };
