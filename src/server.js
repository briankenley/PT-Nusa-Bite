'use strict';
const config = require('./config');
const { createApp } = require('./app');
const db = require('./db');
const { resetBaseline } = require('./seed');

async function ensureDatabase() {
  // Deploy pertama: bila tabel belum ada, buat skema dan isi baseline seed.
  try {
    await db.query('SELECT 1 FROM company LIMIT 1');
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      console.log('Tabel belum ada: membuat skema dan baseline seed…');
      await resetBaseline({ recreate: true });
    } else {
      throw err;
    }
  }
}

// Server langsung mendengarkan port; koneksi database dicoba ulang di latar belakang
// (mis. layanan MySQL cloud masih "Building" atau sedang dinyalakan kembali).
const readiness = { ready: false, attempt: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectWithRetry() {
  for (;;) {
    readiness.attempt += 1;
    try {
      await ensureDatabase();
      readiness.ready = true;
      console.log(`Database siap (percobaan ${readiness.attempt}).`);
      return;
    } catch (err) {
      const wait = Math.min(30, 2 ** Math.min(readiness.attempt, 5));
      console.error(`Database belum dapat dihubungi (percobaan ${readiness.attempt}): ${err.code || ''} ${err.message}. Coba lagi dalam ${wait} detik…`);
      await sleep(wait * 1000);
    }
  }
}

createApp({ readiness }).listen(config.port, () => {
  console.log(`NusaBite ERP berjalan di http://localhost:${config.port}`);
  connectWithRetry();
});
