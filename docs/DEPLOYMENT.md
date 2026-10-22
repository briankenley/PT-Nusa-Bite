# Deployment — URL publik (gratis)

Analogi singkat: aplikasi ini seperti **restoran** (Render menjalankan "dapur"/kode) dan **gudang arsip** (Aiven menyimpan "buku catatan"/database MySQL). Keduanya terpisah supaya data tidak hilang walau dapur tutup sementara.

| Komponen | Layanan yang disarankan | Kenapa |
|---|---|---|
| Aplikasi web (Node.js) | [Render](https://render.com/docs/free) — Free web service | Gratis; tersambung langsung ke GitHub; HTTPS otomatis. Catatan: tidur setelah 15 menit tanpa pengunjung, bangun ±1 menit saat dibuka. |
| Database MySQL | [Aiven for MySQL](https://aiven.io/docs/products/mysql/concepts/mysql-free-tier) — Free plan | MySQL 8 asli, 1 GB, tanpa batas waktu. Catatan: layanan yang lama tidak dipakai bisa dimatikan Aiven (bisa dinyalakan lagi). |

> ⚠️ Jangan memakai **Render Postgres/disk gratis** untuk data: database gratis Render kedaluwarsa 30 hari dan disk web service gratis terhapus saat restart. Aplikasi ini tidak menyimpan apa pun di disk; semua data ada di MySQL.

## Langkah 1 — Buat database MySQL di Aiven (±10 menit)

1. Buka <https://console.aiven.io/signup> dan daftar (bisa memakai akun Google/GitHub).
2. Klik **Create service** → pilih **MySQL** → pilih plan **Free** → region terdekat (mis. Singapore bila tersedia) → **Create service**.
3. Tunggu status **Running** (beberapa menit).
4. Di halaman **Overview** layanan, bagian **Connection information**:
   - Salin **Service URI** — bentuknya `mysql://avnadmin:PASSWORD@mysql-xxxx.aivencloud.com:12345/defaultdb?ssl-mode=REQUIRED`.
   - Klik **CA certificate → Download/Show** dan salin seluruh isinya (diawali `-----BEGIN CERTIFICATE-----`).
5. Simpan kedua nilai itu di catatan sementara. **Jangan** dimasukkan ke repositori.

Sumber: [Aiven TLS/SSL certificates](https://aiven.io/docs/platform/concepts/tls-ssl-certificates), [Get started with Aiven for MySQL](https://help.aiven.io/en/articles/2820646-getting-started-with-aiven-for-mysql).

## Langkah 2 — Deploy aplikasi di Render (±10 menit)

1. Buka <https://dashboard.render.com/register> dan daftar dengan **GitHub** (akun pemilik repositori `briankenley/PT-Nusa-Bite`).
2. Klik **New + → Blueprint** → pilih repositori `PT-Nusa-Bite` → pilih branch yang berisi kode ini.
3. Render membaca file `render.yaml` dan meminta nilai rahasia:
   - `DATABASE_URL` = **Service URI** dari Aiven.
   - `DB_SSL_CA` = isi **CA certificate** dari Aiven (tempel apa adanya, termasuk baris BEGIN/END).
   - `SESSION_SECRET` dibuat otomatis oleh Render.
4. Klik **Apply / Deploy**. Tunggu log menampilkan `NusaBite ERP berjalan di …`.
5. Pada deploy pertama aplikasi otomatis **membuat tabel dan mengisi baseline seed** (log: `Tabel belum ada: membuat skema dan baseline seed…`).
6. Buka URL `https://nusabite-erp-xxxx.onrender.com` → login `owner.demo` / `demo1234`.

Sumber: [Render Blueprint YAML Reference](https://render.com/docs/blueprint-spec), [Health Checks](https://render.com/docs/health-checks), [Setting Your Node.js Version](https://render.com/docs/node-version) (repositori memakai `.node-version` = 22.22.0).

## Langkah 3 — Verifikasi setelah deploy (wajib sebelum dikirim ke dosen)

| Cek | Cara | Hasil yang benar |
|---|---|---|
| Kesehatan | buka `/healthz` | `{"ok":true}` |
| Data baseline | login owner → Inventory → Stock | Total 773 unit, valuasi Rp5.422.000 |
| Persisten | buat Quotation, tekan refresh, logout/login | Quotation tetap ada |
| Peran | login `sales.demo`, buka `/accounting/entries` | 403 + tercatat di Audit |
| Reset | Owner → Settings → Reset ke baseline | Data kembali ke baseline |

## Variabel lingkungan

| Variabel | Wajib | Keterangan |
|---|---|---|
| `DATABASE_URL` | ya (cloud) | URI MySQL. Alternatif: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`. |
| `DB_SSL` | ya untuk Aiven | `true` mengaktifkan TLS. |
| `DB_SSL_CA` | disarankan | Sertifikat CA agar sertifikat server diverifikasi. Tanpa ini koneksi tetap terenkripsi tetapi tidak diverifikasi. |
| `SESSION_SECRET` | ya | Teks acak panjang untuk menandatangani cookie sesi. |
| `NODE_ENV` | ya | `production` (cookie `Secure`, pesan error disembunyikan). |
| `DEMO_PASSWORD` | tidak | Password semua akun uji pada seed (default `demo1234`). |
| `ALLOW_RESET` | tidak | `true` agar Owner dapat memulihkan baseline untuk pengujian; set `false` bila tidak diinginkan. |

## Alternatif

- **Lokal dengan Docker**: `docker compose up --build` lalu buka <http://localhost:3000>. (Dockerfile & compose disertakan; belum diuji di lingkungan pembuat karena Docker daemon tidak tersedia di sana.)
- **TiDB Cloud Starter** (kompatibel MySQL) bisa dipakai sebagai pengganti Aiven; uji dulu karena TiDB tidak 100% identik dengan MySQL. Sumber: [TiDB Cloud cluster tiers](https://docs.pingcap.com/tidbcloud/select-cluster-tier).

## Masalah umum

| Gejala | Penyebab | Solusi |
|---|---|---|
| Log `Database belum dapat dihubungi … ENOTFOUND …aivencloud.com` | Layanan Aiven masih **Building / Setting up vm** sehingga nama host belum terdaftar di DNS, atau URI salah ketik | Tunggu status Aiven **Running** (biasanya beberapa menit). Aplikasi mencoba ulang otomatis dan pulih sendiri; halaman menampilkan "Database sedang disiapkan" (HTTP 503) sementara itu. Bila status sudah Running tetapi masih ENOTFOUND, salin ulang Service URI. |
| Log `ECONNREFUSED` / `ETIMEDOUT` / `Access denied` | Port, password, atau layanan dimatikan | Salin ulang Service URI; nyalakan layanan Aiven bila *Powered off*. |
| `self signed certificate` / TLS error | CA tidak cocok | Tempel ulang CA certificate di `DB_SSL_CA` tanpa spasi tambahan. |
| Login selalu kembali ke halaman login di lokal dengan `NODE_ENV=production` | Cookie `Secure` hanya dikirim lewat HTTPS | Di lokal jangan set `NODE_ENV=production`, atau akses lewat HTTPS. |
| Halaman lambat dibuka pertama kali | Render free sedang tidur | Tunggu ±1 menit; buka URL sebelum demo. |
