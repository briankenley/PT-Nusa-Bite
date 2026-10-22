# Team Agreement — Group 04 · 24SI2 · FastFood

> Draf untuk disepakati bersama; ubah sesuai kebutuhan tim lalu simpan di repositori (wajib menurut Bagian 1 handout).

## 1. Ritme rapat
- Stand-up singkat (15 menit) setiap _hari/jam_ melalui _kanal_.
- Rapat checkpoint mingguan sebelum tenggat Minggu 1–4 (lihat Bagian 9 handout).
- Notulen ringkas dicatat di `docs/` atau di issue GitHub.

## 2. Pengambilan keputusan
- Keputusan aturan bisnis dan konflik SR: **M1 (A)** setelah konsultasi anggota terkait; dicatat di `DECISION_LOG.md`.
- Keputusan teknis (struktur data, deployment): pemilik modul + M2/M4; bila buntu, M1 memutuskan.
- Setiap keputusan mencantumkan SR, alternatif, pihak yang dirugikan, dan bukti T-xx.

## 3. Cara kerja kode
- Setiap anggota bekerja di branch sendiri (`feat/<modul>-<nama>`), commit dari **akun GitHub sendiri**, lalu Pull Request ke branch utama.
- Commit setiap fitur yang bekerja; pesan commit menyebut F-xx/T-xx.
- Sebelum merge: `npm run lint`, `npm test` lulus; untuk perubahan UI jalankan `npm run evidence` (atau tes T-xx terkait).
- Semua penggunaan AI dicatat di `AI_USAGE.md` (alat, bagian yang dibantu, cara verifikasi).

## 4. Definition of Done
Fitur selesai bila: aturan SR ditegakkan di server, data persisten, tes T-xx terkait lulus dengan bukti, log audit tercatat, dan pemilik modul dapat menjelaskan logikanya secara live.

## 5. Konsekuensi keterlambatan
- Terlambat 1× tanpa kabar: diingatkan di kanal tim.
- Terlambat 2×: tugas dibagi ulang oleh M1 dan dicatat di `ROLE_ASSIGNMENT.md` (Perubahan ownership).
- Kontribusi dinilai bersama lewat peer assessment sesuai rubrik.

## 6. Tanda tangan
| Member | Nama | Setuju (tanggal) |
|---|---|---|
| M1 | | |
| M2 | | |
| M3 | | |
| M4 | | |
