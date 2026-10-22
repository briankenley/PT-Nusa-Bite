'use strict';
const { can } = require('./acl');

/**
 * Daftar aplikasi pada app switcher + menu kiri (Overview · Orders/Documents · Reporting · Configuration)
 * mengikuti struktur wireframe S-01..S-19. Payroll adalah kemampuan lintas Employees & Accounting,
 * dan Quick Counter adalah mode transaksi Sales (bukan aplikasi POS).
 */
const APPS = [
  {
    key: 'sales', name: 'Sales', icon: 'S', color: '#e07a5f', perms: ['sales.view', 'counter.use'],
    home: (u) => (can(u.role, 'sales.view') ? '/sales/orders' : '/counter'),
    menu: {
      overview: [{ label: 'Quotations & Orders', href: '/sales/orders', perm: 'sales.view' }],
      documents: [
        { label: 'Quotations', href: '/sales/orders?f=draft', perm: 'sales.view' },
        { label: 'Sales Orders', href: '/sales/orders?f=sale', perm: 'sales.view' },
        { label: 'Quick Counter Order', href: '/counter', perm: 'counter.use' },
        { label: 'Order Revisions', href: '/sales/revisions', perm: 'sales.view' },
        { label: 'Customers', href: '/contacts?f=customer', perm: 'contacts.view' },
      ],
      reporting: [{ label: 'Dashboard', href: '/dashboard', perm: 'dashboard.view' }],
      configuration: [{ label: 'Products', href: '/products', perm: 'products.view' }],
    },
  },
  {
    key: 'crm', name: 'CRM', icon: 'C', color: '#3d8bd9', perms: ['crm.view'], home: () => '/crm',
    menu: {
      overview: [{ label: 'Pipeline', href: '/crm', perm: 'crm.view' }],
      documents: [
        { label: 'Leads', href: '/crm/leads', perm: 'crm.view' },
        { label: 'Opportunities', href: '/crm?v=list', perm: 'crm.view' },
        { label: 'Customers', href: '/contacts?f=customer', perm: 'contacts.view' },
      ],
      reporting: [{ label: 'Dashboard', href: '/dashboard', perm: 'dashboard.view' }],
      configuration: [],
    },
  },
  {
    key: 'purchase', name: 'Purchase', icon: 'P', color: '#8e6bbf', perms: ['purchase.view'], home: () => '/purchase/orders',
    menu: {
      overview: [{ label: 'RFQ & Purchase Orders', href: '/purchase/orders', perm: 'purchase.view' }],
      documents: [
        { label: 'Requests for Quotation', href: '/purchase/orders?f=draft', perm: 'purchase.view' },
        { label: 'Purchase Orders', href: '/purchase/orders?f=purchase', perm: 'purchase.view' },
        { label: 'Receipts', href: '/inventory/pickings?type=in', perm: 'inventory.view' },
        { label: 'Vendors', href: '/contacts?f=vendor', perm: 'contacts.view' },
      ],
      reporting: [
        { label: 'Reorder Suggestions (F-23)', href: '/purchase/reorder', perm: 'purchase.view' },
        { label: 'Vendor Bills', href: '/accounting/bills', perm: 'accounting.view' },
      ],
      configuration: [{ label: 'Products & Vendor Pricelist', href: '/products', perm: 'products.view' }],
    },
  },
  {
    key: 'inventory', name: 'Inventory', icon: 'I', color: '#2a9d8f', perms: ['inventory.view'], home: () => '/inventory',
    menu: {
      overview: [{ label: 'Inventory Overview', href: '/inventory', perm: 'inventory.view' }],
      documents: [
        { label: 'Receipts', href: '/inventory/pickings?type=in', perm: 'inventory.view' },
        { label: 'Delivery Orders', href: '/inventory/pickings?type=out', perm: 'inventory.view' },
        { label: 'Internal Transfers', href: '/inventory/pickings?type=int', perm: 'inventory.view' },
        { label: 'Returns', href: '/inventory/pickings?type=ret', perm: 'inventory.view' },
      ],
      reporting: [
        { label: 'Stock (On Hand / Reserved / Available)', href: '/inventory/stock', perm: 'inventory.view' },
        { label: 'Moves History', href: '/inventory/moves', perm: 'inventory.view' },
      ],
      configuration: [
        { label: 'Products', href: '/products', perm: 'products.view' },
        { label: 'Locations', href: '/inventory/locations', perm: 'inventory.view' },
      ],
    },
  },
  {
    key: 'accounting', name: 'Accounting', icon: 'A', color: '#c0392b', perms: ['accounting.view'], home: () => '/accounting',
    menu: {
      overview: [{ label: 'Accounting Overview', href: '/accounting', perm: 'accounting.view' }],
      documents: [
        { label: 'Customer Invoices', href: '/invoicing/invoices', perm: 'invoicing.view' },
        { label: 'Credit Notes', href: '/invoicing/credit-notes', perm: 'invoicing.view' },
        { label: 'Vendor Bills', href: '/accounting/bills', perm: 'accounting.view' },
        { label: 'Payments', href: '/accounting/payments', perm: 'accounting.view' },
        { label: 'Journal Entries', href: '/accounting/entries', perm: 'accounting.view' },
        { label: 'Payroll Posting', href: '/payroll', perm: 'payroll.view' },
      ],
      reporting: [
        { label: 'General Ledger', href: '/accounting/ledger', perm: 'accounting.view' },
        { label: 'Trial Balance', href: '/accounting/trial-balance', perm: 'accounting.view' },
      ],
      configuration: [
        { label: 'Chart of Accounts', href: '/accounting/accounts', perm: 'accounting.view' },
        { label: 'Taxes & Payment Terms', href: '/accounting/taxes', perm: 'accounting.view' },
      ],
    },
  },
  {
    key: 'invoicing', name: 'Invoicing', icon: '$', color: '#f4a261', perms: ['invoicing.view'], home: () => '/invoicing/invoices',
    menu: {
      overview: [{ label: 'Customer Invoices', href: '/invoicing/invoices', perm: 'invoicing.view' }],
      documents: [
        { label: 'Customer Invoices', href: '/invoicing/invoices', perm: 'invoicing.view' },
        { label: 'Credit Notes', href: '/invoicing/credit-notes', perm: 'invoicing.view' },
        { label: 'Payments', href: '/accounting/payments', perm: 'accounting.view' },
        { label: 'Customers', href: '/contacts?f=customer', perm: 'contacts.view' },
      ],
      reporting: [{ label: 'Dashboard', href: '/dashboard', perm: 'dashboard.view' }],
      configuration: [{ label: 'Taxes & Payment Terms', href: '/accounting/taxes', perm: 'accounting.view' }],
    },
  },
  {
    key: 'employees', name: 'Employees', icon: 'E', color: '#6d8b74', perms: ['employees.view'], home: () => '/employees',
    menu: {
      overview: [{ label: 'Employees', href: '/employees', perm: 'employees.view' }],
      documents: [
        { label: 'Employees', href: '/employees', perm: 'employees.view' },
        { label: 'Payroll Simulation (Payslips)', href: '/payroll', perm: 'payroll.view' },
      ],
      reporting: [{ label: 'Salary Journal', href: '/accounting/ledger?account=601', perm: 'accounting.view' }],
      configuration: [],
    },
  },
  {
    key: 'contacts', name: 'Contacts', icon: '@', color: '#457b9d', perms: ['contacts.view'], home: () => '/contacts',
    menu: {
      overview: [{ label: 'Contacts', href: '/contacts', perm: 'contacts.view' }],
      documents: [
        { label: 'Customers', href: '/contacts?f=customer', perm: 'contacts.view' },
        { label: 'Vendors', href: '/contacts?f=vendor', perm: 'contacts.view' },
      ],
      reporting: [],
      configuration: [{ label: 'Payment Terms', href: '/accounting/taxes', perm: 'accounting.view' }],
    },
  },
  {
    key: 'reporting', name: 'Dashboard', icon: 'D', color: '#264653', perms: ['dashboard.view'], home: () => '/dashboard',
    menu: {
      overview: [{ label: 'KPI Operasional', href: '/dashboard', perm: 'dashboard.view' }],
      documents: [],
      reporting: [
        { label: 'Trial Balance', href: '/accounting/trial-balance', perm: 'accounting.view' },
        { label: 'Stock', href: '/inventory/stock', perm: 'inventory.view' },
      ],
      configuration: [],
    },
  },
  {
    key: 'audit', name: 'Audit', icon: 'Q', color: '#6c757d', perms: ['audit.view'], home: () => '/audit',
    menu: {
      overview: [{ label: 'Audit Log', href: '/audit', perm: 'audit.view' }],
      documents: [
        { label: 'Trace S00008', href: '/audit/trace?number=S00008', perm: 'audit.view' },
        { label: 'Denied / Rejected', href: '/audit?f=blocked', perm: 'audit.view' },
      ],
      reporting: [],
      configuration: [],
    },
  },
  {
    key: 'settings', name: 'Settings', icon: '⚙', color: '#495057', perms: ['admin.reset'], home: () => '/settings',
    menu: {
      overview: [{ label: 'Users & Roles', href: '/settings', perm: 'admin.reset' }],
      documents: [],
      reporting: [],
      configuration: [{ label: 'Reset Baseline Seed', href: '/settings#reset', perm: 'admin.reset' }],
    },
  },
];

function visibleApps(user) {
  return APPS.filter((a) => a.perms.some((p) => can(user.role, p)));
}

function appByKey(key) {
  return APPS.find((a) => a.key === key);
}

function menuFor(app, user) {
  if (!app) return null;
  const filter = (items) => items.filter((i) => can(user.role, i.perm));
  return {
    overview: filter(app.menu.overview),
    documents: filter(app.menu.documents),
    reporting: filter(app.menu.reporting),
    configuration: filter(app.menu.configuration),
  };
}

module.exports = { APPS, visibleApps, appByKey, menuFor };
