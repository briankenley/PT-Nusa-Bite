# Naskah Video Demo (≤ 10 menit) & Kerangka Presentasi (15 + 10 menit)

> Draf bantu. **Video dan presentasi wajib dibawakan tim sendiri.** Sebelum merekam: Owner → Settings → *Reset ke baseline*.

## A. Video demo — dua alur menyeluruh + penanganan SR

| Menit | Peran (login) | Aksi di aplikasi | Yang ditunjukkan / diucapkan |
|---|---|---|---|
| 0:00–0:40 | owner.demo | Beranda → app switcher; Inventory → Stock | Baseline 773 unit / Rp5.422.000; S00007 mereservasi 4 BRG-REG (Available 14). |
| 0:40–1:40 | sales.demo | CRM → L00007 → *Convert to Opportunity* → *New Quotation* C03: 3 BRG-REG + 2 FRY-SML → *Confirm* | S00008, subtotal 116.000, PBJT 11.600, total 127.600; reservasi naik; tautan Lead→Opportunity→SO (SR-22). |
| 1:40–2:10 | sales.demo | Quotation C01 total 127.600 → *Confirm* | Ditolak: exposure 550.000 + 123.200 + 127.600 = **800.800 > 800.000** (SR-09). |
| 2:10–3:00 | warehouse.demo | Delivery WH/OUT/00008 → *Validate* | BRG outlet 18→15, FRY 25→23, jurnal COGS 48.000 (SR-02/04). |
| 3:00–3:50 | finance.demo | SO → *Create Invoice* → *Post* → *Register Payment* 60.000 | INV/2026/0008 127.600; sisa 67.600; coba bayar 150.000 → ditolak (SR-20). |
| 3:50–4:30 | warehouse.demo + finance.demo | WH/OUT/00008 → *Return* 1 BRG-REG → *Validate*; Finance *Post* credit note | Credit note 30.800; sisa invoice 36.800; COGS −12.000 (SR-10). |
| 4:30–6:00 | warehouse.demo | Purchase → RFQ V02 20 FRY-SML → *Confirm* (PO00008) → Receipt: received 20 / accepted 15 / rejected 5 → *Validate* | Stok WH 40→55, valuasi +90.000, GRNI 90.000 (SR-19). |
| 6:00–6:50 | finance.demo | PO → *Create Bill* → ubah ke 20 → ditolak; kembali 15 → *Post* → bayar 90.000 | Three-way match; AP 1.590.000→1.500.000; bank 24.910.000 (SR-06). |
| 6:50–7:40 | cashier.demo | Quick Counter: 1 NUG-6 tunai; lalu 16 NUG-6 | Struk 25.300 (SR-14); 16 unit ditolak karena Available 14 (SR-04, keputusan D-02). |
| 7:40–8:40 | hr.demo → finance.demo | Payroll: generate E02 2026-10 → Approve → Post → Bank Payment; generate ulang | 3.520.000; bank turun; generate ulang ditolak (SR-12/17). Cashier mencoba ubah gaji → 403 (SR-13). |
| 8:40–9:30 | owner.demo | Dashboard; Audit → Trace S00008 | KPI hanya dari dokumen Posted/Done (SR-18); jejak actor/time/action/document (SR-13). |
| 9:30–10:00 | — | Penutup | Ringkas keputusan D-01…D-05 dan hasil 38/38 tes. |

## B. Presentasi 15 menit + 10 menit tanya jawab (urutan wajib Bagian 10)

| # | Durasi | Isi | Bahan dari repositori |
|---|---|---|---|
| 1 | 2 mnt | Konteks & masalah: profil (26 staf, WH-PKU + OUTLET-SUD), proses manual, pemangku kepentingan, contoh SR | Bagian 1–2 handout; `TRACEABILITY.md` |
| 2 | 2 mnt | Dampak bila tidak diselesaikan, dengan hitungan dataset | Contoh di bawah |
| 3 | 2 mnt | Solusi: peta modul, SR/F/S, lima flow, video singkat | `ARCHITECTURE.md` |
| 4 | 5 mnt | Decision Defense: tiap konflik, opsi ditolak, keputusan, pihak dirugikan, bukti T, perubahan jika dibalik, pemotongan lingkup | `DECISION_LOG.md` |
| 5 | 1 mnt | Hasil uji, bug, contoh AI UI tampak benar tetapi melanggar aturan | `TEST_RESULTS.md`, `AI_USAGE.md` |
| 6 | 3 mnt | Rekomendasi masa depan (performance, functions, efficacy, convenience) dengan masalah, manfaat, effort S/M/L, Now/Next/Later | Contoh di bawah |
| 7 | 10 mnt | Q&A individu per modul | Setiap anggota menguasai modulnya |

### Contoh hitungan dampak (bagian 2)

| Masalah tanpa sistem | Hitungan dari dataset |
|---|---|
| Stok reservasi terjual ulang | BRG-REG outlet On Hand 18, Reserved 4 (S00007) → hanya 14 yang boleh dijual. Tanpa kontrol, pesanan 16 unit membuat 2 pesanan C01 gagal terkirim. |
| Kredit macet | C01: AR 550.000 + SO 123.200 + pesanan baru 127.600 = 800.800, melebihi limit 800.000. |
| Tagihan vendor atas barang rusak | PO 20 FRY-SML, 5 ditolak → tanpa three-way match perusahaan berutang Rp30.000 untuk barang yang tidak bisa dijual. |
| Tagihan pelanggan sebelum barang diterima | SO 5 BRG-REG, kirim 3 → menagih 5 membuat AR + PBJT lebih Rp61.600 (2 × 28.000 + 10%). |
| Gaji tanpa jejak | Payroll E02 Rp3.520.000 tercatat dua kali → beban gaji dan kas salah Rp3.520.000. |

### Contoh rekomendasi (bagian 6)

| Kategori | Masalah | Manfaat | Effort | Waktu |
|---|---|---|---|---|
| Performance | Render free tidur 15 menit → demo pertama lambat | Respons stabil | S (paket berbayar / ping terjadwal) | Now |
| Functions | Belum ada stock opname / inventory adjustment | Koreksi selisih fisik tanpa melanggar SR-04 | M | Next |
| Efficacy | Diskon > 10% butuh Owner hadir | Persetujuan via notifikasi/HP | M | Next |
| Convenience | Kasir memilih SKU dari dropdown | Tombol produk/scan barcode | M | Later |
| Functions | PPh 21, BPJS, lembur belum dihitung | Payroll riil | L | Later |
