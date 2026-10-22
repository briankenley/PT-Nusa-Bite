'use strict';
/** Helper Playwright untuk menjalankan skenario T-xx lewat UI dan mengumpulkan bukti. */
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const PASSWORD = process.env.DEMO_PASSWORD || 'demo1234';
const OUT = path.join(__dirname, '..', 'docs', 'evidence');

function rpText(n) {
  return `Rp${new Intl.NumberFormat('id-ID').format(n)}`;
}

function parseRp(s) {
  const m = String(s || '').match(/-?Rp[\d.]+/);
  if (!m) return null;
  return Number(m[0].replace(/Rp|\./g, ''));
}

class Session {
  constructor(browser) {
    this.browser = browser;
    this.pages = {};
  }

  async as(role) {
    if (!this.pages[role]) {
      const ctx = await this.browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'id-ID' });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/login`);
      await page.fill('#username', `${role}.demo`);
      await page.fill('#password', PASSWORD);
      await submit(page, 'button[type=submit]');
      this.pages[role] = page;
    }
    return this.pages[role];
  }

  async close() {
    for (const p of Object.values(this.pages)) await p.context().close();
  }
}

async function go(page, url) {
  const res = await page.goto(BASE + url, { waitUntil: 'load' });
  return res.status();
}

async function submit(page, selector) {
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click(selector)]);
}

async function selectPrefix(page, selector, prefix) {
  const value = await page.$eval(selector, (el, p) => {
    const o = [...el.options].find((x) => x.textContent.trim().startsWith(p));
    return o ? o.value : null;
  }, prefix);
  if (!value) throw new Error(`Opsi "${prefix}" tidak ada pada ${selector}`);
  await page.selectOption(selector, value);
}

async function text(page, selector) {
  const el = await page.$(selector);
  return el ? (await el.innerText()).replace(/\s+/g, ' ').trim() : '';
}

async function flash(page, type = 'error') {
  return text(page, `[data-test=flash-${type}] [data-test=flash-message]`);
}

async function shot(page, name) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = `${name}.jpg`;
  await page.screenshot({ path: path.join(OUT, file), fullPage: true, type: 'jpeg', quality: 72 });
  return file;
}

/** Isi form lines editor: [{ sku, qty, price, disc }] */
async function fillLines(page, lines) {
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await page.click('#add-line');
    const l = lines[i];
    await selectPrefix(page, `select[name="lines[${i}][product_id]"]`, `${l.sku} `);
    await page.fill(`input[name="lines[${i}][qty]"]`, String(l.qty));
    if (l.price !== undefined) await page.fill(`input[name="lines[${i}][unit_price]"]`, String(l.price));
    if (l.disc !== undefined) await page.fill(`input[name="lines[${i}][discount]"]`, String(l.disc));
  }
}

async function createQuotation(page, partnerCode, lines) {
  await go(page, '/sales/orders/new');
  await selectPrefix(page, '#partner_id', `${partnerCode} `);
  await fillLines(page, lines);
  await submit(page, '[data-test=save-quotation]');
  return Number(page.url().match(/orders\/(\d+)/)[1]);
}

async function openByNumber(page, listUrl, number) {
  const q = number === 'Draft' ? '' : `q=${encodeURIComponent(number)}&`;
  await go(page, `${listUrl}${listUrl.includes('?') ? '&' : '?'}${q}f=`);
  const link = await page.$(`table.list tbody a:text-is("${number}")`);
  if (!link) throw new Error(`${number} tidak ditemukan di ${listUrl}`);
  await Promise.all([page.waitForNavigation(), link.click()]);
}

/** Kirim POST langsung (mis. menguji kontrol server untuk tombol yang tidak ditampilkan ke peran tsb). */
async function postForm(page, action, fields) {
  const csrf = await page.$eval('input[name=_csrf]', (i) => i.value);
  await page.evaluate(({ action: a, fields: fs, csrf: c }) => {
    const f = document.createElement('form');
    f.method = 'post'; f.action = a; f.id = '__injected';
    for (const [k, v] of Object.entries({ _csrf: c, ...fs })) {
      const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i);
    }
    const b = document.createElement('button'); b.type = 'submit'; b.id = '__injected_btn'; b.textContent = 'submit'; f.appendChild(b);
    document.body.appendChild(f);
  }, { action, fields, csrf });
  await submit(page, '#__injected_btn');
}

async function stockOf(page, sku, loc) {
  await go(page, `/inventory/stock?q=${encodeURIComponent(sku)}&f=`);
  const rows = await page.$$eval('table.list tbody tr', (trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.trim())));
  const row = rows.find((r) => r[0] === sku && r[2] === loc);
  if (!row) throw new Error(`Stok ${sku}@${loc} tidak ditemukan`);
  const n = (s) => Number(s.replace(/\./g, ''));
  return { onHand: n(row[3]), reserved: n(row[4]), available: n(row[5]) };
}

async function ledgerBalance(page, account) {
  await go(page, `/accounting/ledger?account=${account}`);
  return parseRp(await text(page, '[data-test=ledger-balance]'));
}

module.exports = { BASE, OUT, Session, go, submit, postForm, selectPrefix, text, flash, shot, fillLines, createQuotation, openByNumber, stockOf, ledgerBalance, parseRp, rpText };
