'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const config = require('./config');
const db = require('./db');
const { permsFor, ROLES } = require('./lib/acl');
const { visibleApps, appByKey, menuFor } = require('./lib/apps');
const { BusinessError, AccessError, NotFoundError, translateDbError } = require('./lib/errors');
const audit = require('./lib/audit');
const money = require('./lib/money');
const time = require('./lib/time');
const ui = require('./lib/ui');

function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.get('/healthz', async (req, res) => {
    try { await db.query('SELECT 1'); res.json({ ok: true }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.use(express.urlencoded({ extended: true, limit: '300kb' }));
  app.use(cookieSession({
    name: 'nusabite_session',
    keys: [config.sessionSecret],
    maxAge: 12 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
  }));
  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  // Muat pengguna aktif dari database pada setiap request.
  app.use(async (req, res, next) => {
    res.locals.user = null;
    if (req.session.uid) {
      const u = await db.one('SELECT id, username, full_name, role FROM users WHERE id = ? AND active = 1', [req.session.uid]);
      if (u && u.username === req.session.username) {
        req.user = { id: u.id, username: u.username, role: u.role, name: u.full_name };
      } else {
        req.session.uid = null;
      }
    }
    const flash = req.session.flash || [];
    req.session.flash = [];
    Object.assign(res.locals, {
      user: req.user || null,
      perms: req.user ? permsFor(req.user.role) : {},
      roleLabel: req.user ? ROLES[req.user.role] : '',
      apps: req.user ? visibleApps(req.user) : [],
      flash,
      path: req.path,
      url: req.originalUrl,
      money, time, ui,
      rp: money.rp,
      num: money.num,
      fmtDate: time.fmtDate,
      fmtDateTime: time.fmtDateTime,
      company: 'NusaBite',
      allowReset: config.allowReset,
    });
    res.locals.setApp = (key) => {
      const app2 = appByKey(key);
      res.locals.currentApp = app2;
      res.locals.menu = req.user ? menuFor(app2, req.user) : null;
    };
    res.locals.setApp(null);
    next();
  });

  // CSRF sederhana: token per sesi wajib ada pada setiap POST.
  app.use((req, res, next) => {
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(18).toString('hex');
    res.locals.csrf = req.session.csrf;
    if (req.method === 'POST' && (!req.body || req.body._csrf !== req.session.csrf)) {
      return res.status(403).render('pages/error', { code: 403, title: 'Sesi kedaluwarsa', message: 'Token formulir tidak valid. Muat ulang halaman lalu coba lagi.', rule: null });
    }
    next();
  });


  require('./routes/auth')(app);
  app.use((req, res, next) => {
    if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    next();
  });
  require('./routes/home')(app);
  require('./routes/contacts')(app);
  require('./routes/products')(app);
  require('./routes/crm')(app);
  require('./routes/sales')(app);
  require('./routes/counter')(app);
  require('./routes/inventory')(app);
  require('./routes/purchase')(app);
  require('./routes/invoicing')(app);
  require('./routes/accounting')(app);
  require('./routes/employees')(app);
  require('./routes/payroll')(app);
  require('./routes/dashboard')(app);
  require('./routes/audit')(app);

  app.use((req, res) => {
    res.status(404).render('pages/error', { code: 404, title: 'Halaman tidak ditemukan', message: req.originalUrl, rule: null });
  });

  app.use(async (raw, req, res, next) => {
    const err = translateDbError(raw);
    if (err instanceof BusinessError) {
      if (req.method === 'POST') {
        ui.flash(req, 'error', err.message, err.rule);
        return res.redirect(ui.back(req));
      }
      return res.status(422).render('pages/error', { code: 422, title: 'Ditolak oleh aturan bisnis', message: err.message, rule: err.rule });
    }
    if (err instanceof AccessError) {
      return res.status(403).render('pages/error', { code: 403, title: 'Akses ditolak', message: err.message, rule: 'SR-13' });
    }
    if (err instanceof NotFoundError) {
      return res.status(404).render('pages/error', { code: 404, title: 'Tidak ditemukan', message: err.message, rule: null });
    }
    console.error(err);
    if (req.user) await audit.logOutside({ user: req.user }, { action: 'SERVER_ERROR', docType: 'system', result: 'rejected', message: String(err.message).slice(0, 400) });
    return res.status(500).render('pages/error', { code: 500, title: 'Terjadi kesalahan', message: config.isProduction ? 'Kesalahan server. Coba lagi.' : err.message, rule: null });
  });

  return app;
}

module.exports = { createApp };
