// Interaksi kecil di sisi browser. Semua aturan bisnis tetap divalidasi di server.
(function () {
  'use strict';
  var fmt = new Intl.NumberFormat('id-ID');
  var rp = function (n) { return 'Rp' + fmt.format(Math.round(n)); };

  document.addEventListener('click', function (e) {
    document.querySelectorAll('details.dd[open], details.userbox[open]').forEach(function (d) {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
    var c = e.target.closest('[data-confirm]');
    if (c && !window.confirm(c.getAttribute('data-confirm'))) e.preventDefault();
  });

  var table = document.getElementById('lines-table');
  if (!table) return;
  var taxRate = Number(table.getAttribute('data-tax') || 0);
  var tbody = table.querySelector('tbody');

  function recalc() {
    var untaxed = 0, tax = 0;
    tbody.querySelectorAll('tr.line-row').forEach(function (tr) {
      var sel = tr.querySelector('.js-product');
      var opt = sel.options[sel.selectedIndex];
      var qty = Number((tr.querySelector('.js-qty').value || '0').replace(/\D/g, ''));
      var priceInput = tr.querySelector('.js-price');
      var price = priceInput.value !== '' ? Number(priceInput.value.replace(/\D/g, '')) : Number(opt && opt.getAttribute('data-price') || 0);
      var discEl = tr.querySelector('.js-disc');
      var disc = discEl && discEl.value ? Number(discEl.value.replace(',', '.')) : 0;
      var gross = price * qty * (1 - disc / 100);
      var sub = Math.round(gross);
      var t = Math.round(gross * taxRate / 100);
      tr.querySelector('.js-sub').textContent = sel.value ? rp(sub) : '—';
      if (sel.value) { untaxed += sub; tax += t; }
    });
    var box = document.getElementById('totals-preview');
    box.querySelector('.js-untaxed').textContent = rp(untaxed);
    box.querySelector('.js-tax').textContent = rp(tax);
    box.querySelector('.js-total').textContent = rp(untaxed + tax);
  }

  function renumber() {
    tbody.querySelectorAll('tr.line-row').forEach(function (tr, i) {
      tr.querySelectorAll('[name]').forEach(function (el) {
        el.name = el.name.replace(/lines\[\d+\]/, 'lines[' + i + ']');
      });
    });
  }

  document.getElementById('add-line').addEventListener('click', function () {
    var first = tbody.querySelector('tr.line-row');
    var clone = first.cloneNode(true);
    clone.querySelectorAll('input').forEach(function (i) { i.value = ''; });
    clone.querySelector('select').selectedIndex = 0;
    tbody.appendChild(clone);
    renumber();
    recalc();
  });
  tbody.addEventListener('click', function (e) {
    if (!e.target.classList.contains('js-del')) return;
    var rows = tbody.querySelectorAll('tr.line-row');
    if (rows.length > 1) e.target.closest('tr').remove();
    else e.target.closest('tr').querySelectorAll('input').forEach(function (i) { i.value = ''; });
    renumber();
    recalc();
  });
  tbody.addEventListener('input', recalc);
  tbody.addEventListener('change', recalc);
  recalc();
})();
