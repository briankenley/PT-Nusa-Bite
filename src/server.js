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

ensureDatabase()
  .then(() => {
    createApp().listen(config.port, () => console.log(`NusaBite ERP berjalan di http://localhost:${config.port}`));
  })
  .catch((err) => {
    console.error('Gagal terhubung ke database:', err.message);
    process.exit(1);
  });
