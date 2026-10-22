# Matriks Keterlacakan SR → Implementasi → F → S → T

Setiap aturan pemangku kepentingan (Bagian 2 handout) dapat ditelusuri ke kode, constraint database, fitur, layar, dan tes.

| SR | Aturan (ringkas) | Implementasi (fungsi / constraint) | Fitur | Layar | Tes |
|---|---|---|---|---|---|
| SR-01 | Tagih 100% saat SO dikonfirmasi | **Kalah oleh SR-02 (D-01)**; mitigasi Pro-forma `/sales/orders/:id/proforma` | F-05, F-09 | S-05, S-10 | T-20 |
| SR-02 | Invoice hanya kuantitas Delivery Done yang belum ditagih | `invoicing.invoiceableQty`, `_postInvoice`; CHECK `chk_sol_invoiced` | F-08, F-09 | S-06, S-10 | T-12, T-19, T-20 |
| SR-03 | Tunai outlet < Rp100.000 boleh walau stok kurang | **Kalah oleh SR-04 (D-02)**; `ALLOW_COUNTER_NEGATIVE_BELOW = 0` | F-07, F-21 | S-07, S-18 | T-14, T-36 |
| SR-04 | Tolak move yang membuat Available negatif / memakai reservasi dokumen lain | `stock.reserve` (FOR UPDATE), `_validateDelivery`, `confirmTransfer`; CHECK `chk_quant_available` | F-07, F-08, F-17, F-21 | S-06, S-07, S-18 | T-11, T-12, T-14, T-36, tes race |
| SR-05 | Bill 100% PO segera setelah dikonfirmasi | **Kalah oleh SR-06 (D-03)** | F-11, F-13 | S-08, S-11 | T-22 |
| SR-06 | Bill ≤ accepted quantity; rejected bukan utang | `invoicing.billableQty`, `_postInvoice`; CHECK `chk_pol_billed`; three-way match di form bill | F-13 | S-11 | T-21, T-22 |
| SR-07 | Diskon 0–10% oleh Sales; > 10% perlu Owner | `money.needsDiscountApproval` (diskon efektif), `sales._confirm`, `sales.approveDiscount` | F-06 | S-05 | T-38, tes layanan SR-07 |
| SR-08 | Harga/pajak/SKU/diskon Confirmed terkunci; ubah lewat revisi | `sales.updateOrder` (tolak bila ≠ draft), `requestRevision`, `decideRevision`; tabel `sale_revisions` | F-06, F-22 | S-05, S-19 | T-38 |
| SR-09 | Exposure = AR terbuka + SO Confirmed belum ditagih (incl. PBJT) ≤ limit | `exposure.creditExposure`, `sales._confirm`, revisi; limit hanya Finance/Owner | F-02, F-10 | S-02, S-05 | T-03, T-09, T-10 |
| SR-10 | Retur sah: stok layak jual kembali, COGS dibalik, credit note harga + PBJT | `stock.createReturn`, `validateReturn`, `invoicing._createCreditNoteForReturn`; CHECK `chk_sol_returned` | F-16 | S-14 | T-27, T-28 |
| SR-11 | Internal transfer: asal −q, tujuan +q, nilai perusahaan tetap | `stock.createTransfer/confirmTransfer/validateTransfer` (tanpa jurnal) | F-17 | S-07 | T-13 |
| SR-12 | Nomor unik; tiap kejadian maksimal satu jurnal/stock move | `sequence.nextNumber` (FOR UPDATE); UNIQUE nomor; `journal_entries.event_key` UNIQUE; cek status sebelum Post | F-11, F-14, F-19, F-22 | S-08, S-13, S-16 | T-04, T-16, T-26, T-32, tes race |
| SR-13 | Hak peran dibatasi; catat actor, time, action, document | `lib/acl.js`, `ui.need`, `requirePerm`; `audit_logs` (ok/denied/rejected) | F-01, F-18, F-22 | S-01, S-15, S-19 | T-01, T-02, T-30, T-38 |
| SR-14 | Quick Counter: SO, delivery, invoice/struk, PBJT, jurnal, stok dalam satu transaksi | `counter.checkout` (satu `tx`) | F-21 | S-18 | T-35, T-36 |
| SR-15 | Employee ID unik; status, unit, jabatan, tanggal mulai, tarif dengan riwayat | `employees.createEmployee/updateEmployee`; UNIQUE `uq_employee_code`; `employee_history` | F-18 | S-15 | T-29, T-30 |
| SR-16 | Gaji pokok penuh | **Kalah oleh SR-17 (D-05)**; `PAYROLL_POLICY` | F-19 | S-16 | T-31 |
| SR-17 | Gaji pokok × hadir ÷ 22; tunjangan penuh bila hadir ≥ 1 | `payroll.computePayslip` | F-19 | S-16 | T-31, T-32, tes layanan D-05 |
| SR-18 | KPI dari invoice Posted, payment Posted, move Done | `dashboard.kpis` (+ daftar "tidak dihitung") | F-20 | S-17 | T-33, T-34 |
| SR-19 | Receipt simpan received/accepted/rejected; hanya accepted menambah stok & kewajiban | `stock.saveQualityCheck`, `validateReceipt`; CHECK `chk_move_qc`, `chk_pol_received` | F-12 | S-09 | T-17, T-18 |
| SR-20 | Pembayaran parsial; overpayment ditolak | `invoicing._registerPayment` (FOR UPDATE); CHECK `chk_inv_residual` | F-15 | S-12 | T-23, T-24, tes race |
| SR-21 | Variant SKU unik (produk+ukuran+warna+unit) | `products.assertUniqueVariant`; UNIQUE `uq_products_sku`, `uq_products_variant` | F-03 | S-03 | T-05, T-06 |
| SR-22 | Lead dikonversi sekali; tautan ke Quotation & SO terbaca | `crm.convertLead` (FOR UPDATE); UNIQUE `uq_opp_lead`; `sale_orders.opportunity_id` | F-04 | S-04 | T-07, T-08 |

## Fitur → status

| Fitur | Prioritas | Status | Owner (RACI) |
|---|---|---|---|
| F-01 … F-19, F-21, F-22 | Must | Selesai, diuji | lihat ROLE_ASSIGNMENT.md |
| F-20 Dashboard operasional | Should | Selesai, diuji (T-33, T-34) | M3 |
| F-23 Saran pembelian 7 hari | Optional | Dibuat sebagai laporan read-only `/purchase/reorder` + prefill RFQ; diuji di lapisan layanan | M2 |
