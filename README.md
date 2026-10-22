# NusaBite ERP — PT NusaBite Cepat Saji

Aplikasi web ERP untuk studi kasus **24SI2 · Group 04 · F&B Fast Food** (Pekanbaru, IDR, PBJT 10%). Modul inti: **Sales, CRM, Purchase, Inventory, Accounting, Invoicing** + **Employees**. Simulasi payroll adalah kemampuan lintas Employees–Accounting, dan Quick Counter adalah mode transaksi Sales (bukan aplikasi POS). Strukturnya meniru Odoo Web 17 (app switcher, List/Kanban/Form, Search/Filters/Group By, statusbar, smart buttons, log notes), tetapi implementasinya orisinal, tanpa kode atau aset Odoo.

| | |
|---|---|
| Stack | Node.js 22 · Express 5 · EJS · **MySQL 8** (mysql2) |
| Data | Baseline seed persis Bagian 4 handout: 773 unit / Rp5.422.000, saldo pembuka Rp43.722.000, S00007 · PO00007 · L00007 |
| Pengujian | `npm test` → 49 tes layanan (T-01…T-38 + race condition + regresi) · `npm run evidence` → **38/38 skenario lewat UI** dengan screenshot ([hasil](docs/TEST_RESULTS.md)) |
| Deployment | Render (web) + Aiven (MySQL) — [panduan](docs/DEPLOYMENT.md) |

## Akun uji (password `demo1234`)

| Username | Peran | Hak utama |
|---|---|---|
| `sales.demo` | Sales | Customer, CRM, Quotation/SO (diskon ≤ 10%), Quick Counter |
| `warehouse.demo` | Warehouse | Delivery, Receipt + QC, Internal Transfer, Return, RFQ/PO, SKU |
| `finance.demo` | Finance | Invoice, Credit Note, Vendor Bill, Payment, Journal/Ledger, credit limit, harga/cost, posting payroll |
| `hr.demo` | HR | Employees & tarif gaji (dengan riwayat), payslip |
| `cashier.demo` | Cashier | Quick Counter Order di OUTLET-SUD |
| `owner.demo` | Owner | Semua hak + persetujuan diskon/revisi + reset baseline |

## Menjalankan di komputer sendiri (langkah demi langkah)

**Pilihan A — tanpa Docker**

1. Pasang [Node.js 22 LTS](https://nodejs.org/en/download) dan [MySQL 8](https://dev.mysql.com/downloads/mysql/).
2. Buat database dan user (di MySQL client):
   ```sql
   CREATE DATABASE nusabite CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'nusabite'@'localhost' IDENTIFIED BY 'nusabite';
   GRANT ALL ON nusabite.* TO 'nusabite'@'localhost';
   ```
3. Di folder proyek:
   ```bash
   cp .env.example .env      # sesuaikan bila user/password berbeda
   npm install
   npm run db:reset          # membuat tabel + baseline seed
   npm start                 # buka http://localhost:3000
   ```

**Pilihan B — Docker**: `docker compose up --build` lalu buka <http://localhost:3000> (tabel dan seed dibuat otomatis saat start pertama).

## Menjalankan pengujian

```bash
# 1) Tes layanan + database (memakai database terpisah nusabite_test)
mysql -uroot -e "CREATE DATABASE nusabite_test; GRANT ALL ON nusabite_test.* TO 'nusabite'@'localhost';"
npm test

# 2) Tes UI T-01…T-38 + screenshot bukti (server harus berjalan; data aplikasi akan di-reset ke baseline)
npx playwright install chromium   # sekali saja
npm start &                       # terminal lain
npm run evidence                  # menulis docs/TEST_RESULTS.md dan docs/evidence/*.jpg
npm run evidence -- T-09 T-10     # menjalankan sebagian tes

npm run lint
```

## Paket penyerahan (Bagian 10 handout)

| Item | Lokasi | Status |
|---|---|---|
| Working application (URL publik, akun uji, data persisten) | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Siap di-deploy; **URL dibuat oleh tim** (perlu akun Render & Aiven) |
| README cara menjalankan | file ini | ✅ |
| Diagram arsitektur dan data | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | ✅ |
| Decision Log seluruh konflik | [docs/DECISION_LOG.md](docs/DECISION_LOG.md) | ✅ draf — wajib ditinjau M1 |
| Hasil semua T (expected, actual, pass/fail, evidence) | [docs/TEST_RESULTS.md](docs/TEST_RESULTS.md) · [docs/evidence/](docs/evidence/) | ✅ 38/38 |
| Matriks SR → F → S → T | [docs/TRACEABILITY.md](docs/TRACEABILITY.md) | ✅ |
| AI-tool usage note | [docs/AI_USAGE.md](docs/AI_USAGE.md) | ✅ |
| Role Assignment Sheet | [docs/ROLE_ASSIGNMENT.md](docs/ROLE_ASSIGNMENT.md) | Template — isi nama |
| Team Agreement | [docs/TEAM_AGREEMENT.md](docs/TEAM_AGREEMENT.md) | Template — sepakati |
| Kontribusi tiap anggota + history commit | [docs/CONTRIBUTIONS.md](docs/CONTRIBUTIONS.md) | **Harus diisi tim** |
| Video demo ≤ 10 menit & presentasi | [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) | Naskah; **direkam & dibawakan tim** |

Nama berkas penyerahan: `Group04_24SI2_FastFood_<ItemName>` (contoh `Group04_24SI2_FastFood_TestResults`).

## Keputusan utama atas konflik

| ID | Konflik | Keputusan | Konstanta |
|---|---|---|---|
| D-01 | SR-01 vs SR-02 | Invoice hanya kuantitas Delivery Done | `INVOICE_POLICY` |
| D-02 | SR-03 vs SR-04 | Available tidak boleh negatif, juga untuk kasir | `ALLOW_COUNTER_NEGATIVE_BELOW` |
| D-03 | SR-05 vs SR-06 | Vendor Bill ≤ accepted quantity | `BILL_POLICY` |
| D-04 | SR-07 + SR-08 | Diskon efektif ≤ 10% bebas, > 10% Owner; Confirmed terkunci, koreksi via Revisi | `MAX_SALES_DISCOUNT_PCT` |
| D-05 | SR-16 vs SR-17 | Gaji pokok proporsional kehadiran, tunjangan penuh bila hadir ≥ 1 hari | `PAYROLL_POLICY` |
| D-06 | SR-20 | Overpayment ditolak | `ALLOW_OVERPAYMENT` |

Detail, pihak yang dirugikan, dan bukti: [docs/DECISION_LOG.md](docs/DECISION_LOG.md).

## Catatan integritas akademik

Kode ini dibuat dengan bantuan alat AI (Claude Code) dan dicatat di [docs/AI_USAGE.md](docs/AI_USAGE.md). Handout mengizinkan AI dengan pencatatan, tetapi **setiap anggota wajib memahami dan dapat menjelaskan modulnya secara live**, dan nilai individu bergantung pada kontribusi nyata serta riwayat commit masing-masing.
