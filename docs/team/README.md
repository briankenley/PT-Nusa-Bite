# Pembagian Kerja Tim — M1 · M2 · M3 · M4

Basis aplikasi (kode, tes, dokumen awal) dibuat dengan bantuan AI dan **dicatat terbuka** di [AI_USAGE.md](../AI_USAGE.md) serta di riwayat commit. Itu diizinkan oleh Bagian 13 handout. Yang dinilai per individu adalah **kontribusi nyata, riwayat commit, output peran, peer assessment, dan jawaban demo**. Karena itu setiap anggota mendapat paket kerja yang menghasilkan output dan commit atas namanya sendiri:

1. **Kepemilikan** — modul, fitur, layar, tes, dan file yang menjadi tanggung jawabmu (kamu yang menjawab pertanyaan dosen tentang ini).
2. **Tugas wajib** — dokumen peran, uji manual di URL produksi, catatan pemahaman modul dengan kata-kata sendiri.
3. **Tugas pengembangan** — satu perbaikan/fitur kecil di modulmu, lengkap dengan tes.
4. **Latihan Q&A** — pertanyaan yang kemungkinan ditanyakan dosen.

| Paket | Peran | Modul | Fitur | Tes | Layar |
|---|---|---|---|---|---|
| [M1](M1.md) | Product Owner, Project Manager & Business Analyst | Sales; CRM | F-02, F-04, F-05, F-06, F-10 | T-03, 04, 07, 08, 09, 10, 38 | S-02, S-04, S-05 |
| [M2](M2.md) | Lead AI Developer | Purchase; Inventory | F-03, F-07, F-08, F-11, F-12, F-17 (+F-23) | T-05, 06, 11–18 | S-03, S-06, S-07, S-08, S-09 |
| [M3](M3.md) | UI/UX Lead | Employees; Sales co-owner (Quick Counter) | F-18, F-19, F-20, F-21 | T-29–36 | S-15, S-16, S-17, S-18 (+ konsistensi semua layar) |
| [M4](M4.md) | QA & Deployment Lead | Accounting; Invoicing | F-01, F-09, F-13, F-14, F-15, F-16, F-22 | T-01, 02, 19–28, 37, 38 | S-01, S-10–S-14, S-19 |

Sumber pembagian: tabel *Peran dan tanggung jawab kelompok* dan *RACI Matrix* di Bagian 1 handout. Modul **Sales** dimiliki bersama M1 dan M3 (co-owned), sehingga **keduanya wajib punya commit nyata di modul Sales** (handout: "Modul co-owned harus dibangun oleh dua kontributor nyata").

## Peta struktur repositori per pemilik

| Area | M1 | M2 | M3 | M4 |
|---|---|---|---|---|
| `src/services/` | `sales.js`, `crm.js`, `contacts.js`, `exposure.js` | `stock.js`, `purchase.js`, `products.js`, `reorder.js` | `employees.js`, `payroll.js`, `counter.js`, `dashboard.js` | `accounting.js`, `invoicing.js`, `auditsvc.js`, `auth.js` |
| `src/routes/` | `sales.js`, `crm.js`, `contacts.js` | `inventory.js`, `purchase.js`, `products.js` | `employees.js`, `payroll.js`, `counter.js`, `dashboard.js` | `accounting.js`, `invoicing.js`, `audit.js`, `auth.js`, `home.js` |
| `views/pages/` | `so_form`, `so_edit`, `proforma`, `lead_form`, `opportunity_form`, `contact_form` | `picking_form`, `return_new`, `transfer_new`, `inventory_overview`, `po_form`, `po_edit`, `product_form` | `employee_form`, `payroll_list`, `payslip_form`, `counter`, `counter_receipt`, `dashboard`, `home`, `login`, `list_page` | `invoice_form`, `entry_form`, `entry_new`, `ledger`, `trial_balance`, `taxes`, `accounting_overview`, `trace`, `settings`, `error` |
| Inti / bersama | `src/policies.js` (keputusan konflik) | `src/schema.sql`, `src/seed.js`, `src/db.js`, `src/lib/sequence.js` | `views/partials/*`, `public/css/app.css`, `public/js/app.js`, `src/lib/apps.js`, `src/lib/listview.js`, `src/lib/ui.js` | `src/lib/acl.js`, `src/lib/audit.js`, `src/lib/action.js`, `src/lib/errors.js`, `src/lib/money.js` |
| Tes & deploy | — | `test/flows.js` (bersama M4) | — | `test/*`, `e2e/*`, `render.yaml`, `Dockerfile`, `docker-compose.yml` |
| Dokumen | `DECISION_LOG.md`, `ROLE_ASSIGNMENT.md`, `TEAM_AGREEMENT.md`, `TRACEABILITY.md` | `ARCHITECTURE.md` | `DEMO_SCRIPT.md`, `WIREFRAME_CHECK.md` (baru) | `TEST_RESULTS.md`, `DEFECT_LOG.md` (baru), `DEPLOYMENT.md`, `CONTRIBUTIONS.md` |
| Semua | Mencatat penggunaan AI masing-masing di `AI_USAGE.md` dan mengisi baris sendiri di `CONTRIBUTIONS.md` | | | |

"Pemilik" berarti penanggung jawab dan reviewer utama, bukan satu-satunya orang yang boleh mengubah file. Perubahan di file milik orang lain wajib di-review pemiliknya.

## Fase 0 — Disiapkan pemilik repositori (sekali, ±15 menit)

1. **Undang kolaborator**: GitHub → repositori → **Settings → Collaborators → Add people** → masukkan username M1–M4 → role **Write**. Sumber: [Inviting collaborators to a personal repository](https://docs.github.com/articles/inviting-collaborators-to-a-personal-repository).
2. **Buat branch `main`** dari kode yang sekarang: tab **Code** → dropdown branch → ketik `main` → **Create branch: main from `claude/affectionate-ride-ohb3lc`**.
3. Jadikan default: **Settings → General → Default branch → `main`**.
4. (Disarankan) **Settings → Branches → Add rule** untuk `main`: *Require a pull request before merging* + *Require approvals: 1*.
5. **Render**: service `nusabite-erp` → **Settings → Build & Deploy → Branch** → ubah ke `main`. Di bagian yang sama, **Build Filters → Ignored Paths**: `docs/**`, `*.md`, `test/**`, `e2e/**` agar perubahan dokumen/tes tidak memicu deploy ulang.
6. Bagikan ke tim: link repositori, URL aplikasi `https://nusabite-erp.onrender.com`, dan akun uji (`*.demo` / `demo1234`). **Jangan** membagikan password akun Render/Aiven atau Service URI database di chat.

Setelah itu setiap anggota mengikuti [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Urutan kerja yang disarankan

| Fase | Isi | Siapa | Selesai bila |
|---|---|---|---|
| 0 | Akses repo, branch `main`, Render ke `main` | Pemilik repo | Semua anggota bisa membuat branch dan PR |
| 1 | Dokumen peran (Role Assignment, Team Agreement) + rapat keputusan | M1 (A), semua | PR dokumen M1 di-merge, semua tanda tangan |
| 2 | Uji manual di URL produksi per modul + catatan pemahaman modul | Semua (paralel) | Tiap anggota punya file uji manual + catatan modul di `docs/team/` |
| 3 | Tugas pengembangan (satu per anggota) dengan tes | Semua (paralel) | `npm test` lulus, PR di-review, di-merge |
| 4 | Regresi penuh, defect log, hasil tes final, URL di README | M4 (A/R), M2 (R) | `npm test` + `npm run evidence` lulus 100% pada `main` |
| 5 | Video demo ≤ 10 menit & latihan presentasi 15 + 10 menit | M1 (A), M3 & M4 (R) | Video direkam; tiap anggota bisa menjawab Q&A modulnya |

**Urutan merge** untuk menghindari konflik: dokumen dulu, lalu fitur yang menyentuh file berbeda boleh paralel; perubahan di file bersama (`src/lib/apps.js`, `src/lib/acl.js`, `src/schema.sql`, `README.md`) dikoordinasikan di grup dan di-merge satu per satu. M4 menjalankan regresi setelah setiap merge kode.

## Aturan yang berlaku untuk semua paket

- Kerjakan sendiri; bila memakai AI, catat di `AI_USAGE.md` (alat, bagian yang dibantu, cara kamu memverifikasi) — ini juga bahan **Refleksi 2**.
- Setiap perubahan kode harus disertai tes yang lulus (`npm test`) dan tidak merusak T-01…T-38.
- Setelah uji manual di URL produksi, Owner melakukan **Settings → Reset ke baseline** agar data kembali bersih.
- Isi baris kontribusimu di [CONTRIBUTIONS.md](../CONTRIBUTIONS.md) dengan hash commit / nomor PR yang benar-benar kamu buat.
