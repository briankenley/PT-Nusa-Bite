'use strict';
const ui = require('../lib/ui');
const dashboard = require('../services/dashboard');

module.exports = (app) => {
  app.get('/dashboard', ui.need('dashboard.view'), async (req, res) => {
    res.locals.setApp('reporting');
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
    res.render('pages/dashboard', { title: 'Dashboard', k: await dashboard.kpis({ from, to }), from: from || '', to: to || '' });
  });
};
