# Catatan Penggunaan Alat AI (AI-tool usage note)

Bagian 13 handout: penggunaan AI **diizinkan** dalam metode vibe coding **dengan semua alat dicatat**, dan setiap anggota harus mampu menjelaskan bagian mana pun secara live.

## Alat yang dipakai

| Alat | Dipakai untuk | Catatan |
|---|---|---|
| Claude Code (Anthropic), sesi cloud | Analisis handout, desain skema & aturan, penulisan kode aplikasi, tes otomatis, skrip bukti Playwright, draf dokumen | Seluruh commit awal di repositori ini dibuat dari sesi tersebut (lihat `Co-Authored-By` pada commit). |
| _isi bila ada (mis. Antigravity, ChatGPT, Copilot)_ | | |

## Cara kerja yang diterapkan

1. **Requirement dulu, kode kemudian.** Setiap SR-xx diterjemahkan ke aturan di layanan + constraint database; konflik ditulis di [DECISION_LOG.md](DECISION_LOG.md) sebelum dikodekan.
2. **Dataset diverifikasi ulang secara manual dan otomatis.** Total 773 unit / Rp5.422.000, saldo pembuka Rp43.722.000, dan seluruh angka expected T-xx dihitung ulang; tes `Baseline` memeriksanya di database.
3. **Dua lapis pengujian.** `npm test` (48+ tes layanan, termasuk race condition) dan `npm run evidence` (38 skenario lewat UI dengan screenshot).
4. **Commit setiap fitur yang bekerja** dan uji ulang setelah perubahan.

## Kasus "UI tampak benar tetapi melanggar aturan" yang ditemukan (bahan Refleksi 2)

| # | Gejala | Diagnosis | Perbaikan | Uji regresi |
|---|---|---|---|---|
| 1 | Validasi Delivery Order dengan Done 3 dari 5 tampil sukses, tetapi **5 unit terkirim** dan tidak ada backorder. Quality Check Receipt juga ditolak walau angka sudah diisi. | Nama input memakai ID baris (`done[12]`). Parser `qs` di Express memadatkan kunci angka menjadi array (`['3']`), sehingga ID hilang dan server memakai kuantitas default. Tes lapisan layanan **tidak** menangkapnya karena memanggil fungsi langsung. | Kunci form diberi prefix (`done[m12]`, `qc[m12][…]`, `ret[m12][…]`, `qty[l12]`) + helper `ui.idMap`. | `test/robustness.test.js` "Regresi form", UI T-12/T-17/T-18/T-20/T-22. |
| 2 | Tombol **Approve** revisi dan diskon tampil untuk peran Sales. Server memang menolak (403), tetapi tampilan menyesatkan. | Kondisi tampilan memakai hak "lihat" bukan hak "setujui". | Tombol hanya tampil untuk Owner; Sales melihat "Menunggu Owner". | T-38 mengirim approve langsung sebagai Sales → 403. |
| 3 | Desain awal: Sales boleh mengubah harga satuan pada quotation. Diskon 0% terlihat patuh SR-07, padahal harga diturunkan 20%. | Kontrol hanya melihat kolom diskon. | Kontrol memakai **diskon efektif** terhadap harga katalog. | Tes layanan "SR-07 … Menurunkan harga satuan juga dihitung sebagai diskon efektif". |
| 4 | Kartu credit exposure pada SO Confirmed menampilkan angka tanpa pesanan itu sendiri. | Exposure dihitung dengan mengecualikan pesanan saat ini untuk semua status. | Pengecualian hanya untuk Quotation (Draft). | Pemeriksaan visual screenshot S-05. |

## Batas tanggung jawab AI (jujur)

- AI **tidak** dapat menggantikan kontribusi individu: rubrik menilai riwayat commit, output peran, peer assessment, dan jawaban demo setiap anggota. Lihat [CONTRIBUTIONS.md](CONTRIBUTIONS.md).
- AI **tidak** membuat akun hosting; deployment dilakukan anggota tim (lihat [DEPLOYMENT.md](DEPLOYMENT.md)).
- Keputusan konflik adalah draf; pemegang keputusan tetap M1 (Product Owner).
- Video demo, presentasi, dan Refleksi 1–2 harus dibuat dan dibawakan oleh tim.
