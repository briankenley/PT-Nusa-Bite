'use strict';
// Pemakaian: npm run db:reset  (membuat ulang tabel lalu memulihkan baseline seed)
const { resetBaseline } = require('../seed');
const { closePool } = require('../db');

resetBaseline({ recreate: process.argv.includes('--keep-schema') ? false : true })
  .then(() => console.log('Baseline seed dipulihkan.'))
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => closePool());
