'use strict';
/**
 * Keputusan atas konflik aturan bisnis (lihat docs/DECISION_LOG.md).
 * Setiap konstanta menyebut ID keputusan agar mudah ditelusuri saat defense.
 */
module.exports = {
  // D-01 (SR-01 vs SR-02): invoice hanya untuk kuantitas Delivery Done yang belum ditagih.
  INVOICE_POLICY: 'delivered',

  // D-02 (SR-03 vs SR-04): Available tidak boleh negatif, termasuk transaksi tunai < Rp100.000.
  ALLOW_COUNTER_NEGATIVE_BELOW: 0,

  // D-03 (SR-05 vs SR-06): Vendor Bill dibatasi accepted quantity pada Receipt Done.
  BILL_POLICY: 'accepted',

  // D-04 (SR-07 + SR-08): Sales boleh memberi diskon efektif 0–10%; di atas itu wajib persetujuan Owner.
  MAX_SALES_DISCOUNT_PCT: 10,

  // D-05 (SR-16 vs SR-17): gaji pokok proporsional hari hadir ÷ hari rencana; tunjangan penuh jika hadir ≥ 1 hari.
  PAYROLL_POLICY: 'proportional',

  // D-06 (SR-20): pembayaran melebihi sisa tagihan ditolak (tidak ada pencatatan kelebihan bayar).
  ALLOW_OVERPAYMENT: false,

  // Lokasi default
  SALES_LOCATION: 'OUTLET-SUD',
  PURCHASE_LOCATION: 'WH-PKU',
  PBJT_TAX: 'PBJT10',
  PURCHASE_TAX: 'PUR0',
};
