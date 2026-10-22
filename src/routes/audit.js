'use strict';
const ui = require('../lib/ui');
const { buildList } = require('../lib/listview');
const auditsvc = require('../services/auditsvc');

module.exports = (app) => {
  app.get('/audit', ui.need('audit.view'), async (req, res) => {
    res.locals.setApp('audit');
    const rows = await auditsvc.listLogs({ limit: 1000 });
    const list = buildList(req, rows, {
      search: ['doc_number', 'username', 'action', 'message', 'doc_type'],
      filters: [
        { key: 'blocked', label: 'Ditolak (denied / rejected)', group: 'r', test: (r) => r.result !== 'ok' },
        { key: 'ok', label: 'OK', group: 'r', test: (r) => r.result === 'ok' },
        { key: 'denied', label: 'Akses ditolak (SR-13)', group: 'r2', test: (r) => r.result === 'denied' },
      ],
      groupBys: [
        { key: 'user', label: 'Actor', value: (r) => r.username },
        { key: 'action', label: 'Action', value: (r) => r.action },
        { key: 'doc', label: 'Document', value: (r) => r.doc_number || '—' },
        { key: 'result', label: 'Result', value: (r) => r.result },
      ],
    });
    res.render('pages/list_page', {
      title: 'Audit Log',
      cp: { crumbs: [{ label: 'Audit' }, { label: 'Audit Log' }], list, actions: '<form method="get" action="/audit/trace" class="inline" style="display:flex;gap:6px"><input class="input" name="number" placeholder="S00008" style="width:120px"><button class="btn">Trace</button></form>' },
      intro: 'Setiap perubahan kritis dan setiap upaya yang ditolak mencatat <b>actor, time, action, document</b> (SR-13). Result <b>denied</b> = hak akses, <b>rejected</b> = aturan bisnis/constraint.',
      columns: [
        { label: 'Time', value: (r) => String(r.ts).slice(0, 19) },
        { label: 'Actor', value: (r) => r.username },
        { label: 'Role', value: (r) => r.role },
        { label: 'Action', html: (r) => `<code>${ui.escapeHtml(r.action)}</code>` },
        { label: 'Document', value: (r) => r.doc_number || (r.doc_type ? `${r.doc_type}${r.doc_id ? ` #${r.doc_id}` : ''}` : '') },
        { label: 'Result', html: (r) => ui.badge(r.result) },
        { label: 'Message', value: (r) => r.message || '' },
      ],
      href: null,
    });
  });

  app.get('/audit/trace', ui.need('audit.view'), async (req, res) => {
    res.locals.setApp('audit');
    const number = String(req.query.number || 'S00008').trim().toUpperCase();
    const t = await auditsvc.trace(number);
    res.render('pages/trace', { title: `Trace ${number}`, number, t });
  });
};
