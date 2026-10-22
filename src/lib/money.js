'use strict';

/** Pembagian bilangan bulat dengan pembulatan ke terdekat (half-up), a >= 0. */
function roundDiv(a, b) {
  if (a < 0) return -roundDiv(-a, b);
  return Math.floor((2 * a + b) / (2 * b));
}

const bp = (pct) => Math.round(Number(pct || 0) * 100); // persen -> basis poin

/**
 * Hitung satu baris dokumen. Pajak dibulatkan ke Rupiah terdekat per baris:
 * tax = round(rate × harga setelah diskon × kuantitas).
 */
function computeLine({ unitPrice, qty, discountPct = 0, taxRatePct = 0 }) {
  const gross = unitPrice * qty * (10000 - bp(discountPct)); // skala 10^4
  const subtotal = roundDiv(gross, 10000);
  const tax = roundDiv(gross * bp(taxRatePct), 10000 * 10000);
  return { subtotal, tax, total: subtotal + tax };
}

/** Diskon efektif terhadap harga jual katalog (memperhitungkan harga yang diturunkan). */
function effectiveDiscountPct(listPrice, unitPrice, discountPct) {
  if (!listPrice) return 0;
  const net = unitPrice * (10000 - bp(discountPct)) / 10000;
  return Math.round((1 - net / listPrice) * 10000) / 100;
}

/** SR-07: diskon efektif di atas batas wajib persetujuan Owner. */
function needsDiscountApproval(listPrice, unitPrice, discountPct, maxPct) {
  return unitPrice * (10000 - bp(discountPct)) < listPrice * (10000 - bp(maxPct));
}

const nf = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });

function rp(n) {
  const v = Number(n || 0);
  return (v < 0 ? '-Rp' : 'Rp') + nf.format(Math.abs(v));
}

function num(n) {
  return nf.format(Number(n || 0));
}

function toInt(v, fallback = 0) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(String(v).replace(/[^\d-]/g, ''));
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toPct(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

module.exports = { roundDiv, computeLine, effectiveDiscountPct, needsDiscountApproval, rp, num, toInt, toPct };
