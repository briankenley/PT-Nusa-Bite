# Cara Berkontribusi (untuk semua anggota)

Tujuan dokumen ini: setiap anggota bekerja dan **commit dari akun GitHub sendiri**, sehingga riwayat commit mencerminkan kontribusi nyata (rubrik menilai kontribusi, riwayat commit, output peran, peer assessment, dan jawaban demo). Pembagian tugas per anggota ada di [docs/team/README.md](docs/team/README.md).

> **Aturan kejujuran:** commit hanya pekerjaanmu sendiri. Jangan commit atas nama teman, jangan memakai `git commit --author` untuk orang lain, dan jangan mengklaim kode yang dibuat AI sebagai karya pribadi tanpa mencatatnya di [docs/AI_USAGE.md](docs/AI_USAGE.md). Memakai AI diperbolehkan (Bagian 13 handout) **asal dicatat dan kamu paham isinya**.

## 0. Persiapan akun (sekali saja)

1. Buat akun GitHub (bila belum) dan kirim **username**-mu ke pemilik repositori.
2. Terima undangan kolaborator dari email / <https://github.com/notifications>.
3. Pastikan commit tercatat atas namamu: email Git harus sama dengan email terverifikasi di akun GitHub-mu atau alamat *noreply*-mu. Cara cek dan mengaturnya: [Setting your commit email address](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address).

## 1. Pilih cara kerja

| Cara | Cocok untuk | Perlu instal? |
|---|---|---|
| **A. Edit di website GitHub** | Tugas dokumen (`docs/*.md`) | Tidak |
| **B. GitHub Desktop** | Semua tugas, paling mudah untuk pemula | GitHub Desktop + Node.js + MySQL |
| **C. Command line (git)** | Yang sudah terbiasa terminal | Git + Node.js + MySQL |

### A. Edit langsung di GitHub (dokumen)
1. Buka file di GitHub, klik ikon pensil ✏️ (*Edit this file*).
2. Ubah isinya.
3. Klik **Commit changes…** → pilih **Create a new branch** → nama branch `docs/m1-role-assignment` (sesuaikan) → **Propose changes**.
4. Isi template Pull Request → **Create pull request**.

### B. GitHub Desktop
1. Instal [GitHub Desktop](https://desktop.github.com/) dan login dengan akun GitHub-mu. Panduan: [Setting up GitHub Desktop](https://docs.github.com/en/desktop/installing-and-configuring-github-desktop/setting-up-github-desktop).
2. **File → Clone repository** → pilih `briankenley/PT-Nusa-Bite`.
3. **Current branch → New branch** → nama sesuai pola di bawah (berangkat dari `main`).
4. Kerjakan perubahan di editor (mis. VS Code), kembali ke GitHub Desktop, tulis ringkasan commit → **Commit to <branch>** → **Push origin** → **Create Pull Request**.

### C. Command line
```bash
git clone https://github.com/briankenley/PT-Nusa-Bite.git
cd PT-Nusa-Bite
git config user.name "Nama Lengkap"
git config user.email "email-terverifikasi-di-github@contoh.com"
git switch main && git pull
git switch -c feat/m2-inventory-adjustment
# … ubah file …
git add -A && git commit -m "M2: tambah inventory adjustment (F-07, SR-04)"
git push -u origin feat/m2-inventory-adjustment
```
Lalu buka GitHub → **Compare & pull request**.

## 2. Pola nama branch dan commit

| Jenis | Pola branch | Contoh pesan commit |
|---|---|---|
| Dokumen | `docs/m<N>-<topik>` | `M1: isi Role Assignment Sheet [skip render]` |
| Fitur | `feat/m<N>-<topik>` | `M2: inventory adjustment dengan jurnal 602/120 (F-07, SR-04)` |
| Perbaikan | `fix/m<N>-<topik>` | `M3: perbaiki tampilan counter di layar sempit (S-18)` |
| Tes | `test/m<N>-<topik>` | `M4: tes AR aging untuk invoice parsial (F-15)` |

- Sebut ID **F-xx / SR-xx / S-xx / T-xx** di pesan commit agar mudah ditelusuri saat defense.
- Commit kecil dan sering ("commit setiap fitur yang bekerja" — Bagian 8 handout).
- **Perubahan yang hanya dokumen**: tambahkan `[skip render]` di pesan commit atau judul Pull Request agar Render tidak deploy ulang. Sumber: [Render — Deploying on Render](https://render.com/docs/deploys).

## 3. Menjalankan aplikasi dan tes di komputer sendiri (untuk tugas kode)

1. Instal [Node.js 22 LTS](https://nodejs.org/en/download) dan [MySQL 8.4 LTS](https://dev.mysql.com/downloads/mysql/) (Windows: *MySQL Installer*). XAMPP memakai MariaDB, bukan MySQL — belum diuji.
2. Buat database lokal (di MySQL Command Line Client / Workbench):
   ```sql
   CREATE DATABASE nusabite CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE DATABASE nusabite_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'nusabite'@'localhost' IDENTIFIED BY 'nusabite';
   GRANT ALL ON nusabite.* TO 'nusabite'@'localhost';
   GRANT ALL ON nusabite_test.* TO 'nusabite'@'localhost';
   ```
3. Di folder proyek: salin `.env.example` menjadi `.env`, lalu
   ```bash
   npm install
   npm run db:reset
   npm start            # http://localhost:3000
   npm test             # wajib lulus sebelum membuat Pull Request
   npm run lint
   ```
4. Tes UI (opsional, lebih lama): `npx playwright install chromium`, jalankan `npm start` di satu terminal, lalu `npm run evidence -- T-09 T-10` di terminal lain.

> ⚠️ **Jangan pernah** mengarahkan `.env` lokal ke database produksi Aiven lalu menjalankan `npm run evidence` atau `npm run db:reset` — keduanya **menghapus seluruh data** dan memulihkan baseline. Bila butuh database cloud untuk latihan, buat database terpisah (mis. `nusabite_dev`) di layanan Aiven yang sama dan pakai URI database itu.

## 4. Pull Request dan review

1. Isi template PR (otomatis muncul): apa yang diubah, F/SR/T terkait, bukti tes, catatan AI.
2. Tunggu pemeriksaan otomatis **Tes otomatis / test** (GitHub Actions, ±5–15 menit) menjadi ✅. Pemeriksaan ini menjalankan lint, `npm test`, 38 skenario UI, dan tes UI anggota di MySQL sementara (bukan database produksi), jadi anggota yang mengedit lewat browser (github.dev) tetap punya bukti lulus/gagal. Screenshot hasilnya: **Details → Summary → Artifacts → bukti-screenshot**.
3. Minta review minimal **satu anggota lain** (pemilik modul terkait atau M4 untuk QA).
4. Setelah disetujui dan CI hijau, pemilik repositori / M4 melakukan **merge**. Jangan merge PR sendiri tanpa review.
5. Setelah merge kode (bukan dokumen), Render otomatis deploy ulang. Cek `/healthz` dan reset baseline bila perlu.

## 5. Yang tidak boleh di-commit

- File `.env`, password, Service URI database, CA certificate, token. (`.gitignore` sudah menolak `.env`.)
- Folder `node_modules/`.
