'use strict';
const { tx } = require('../db');
const audit = require('./audit');
const { BusinessError, AccessError, translateDbError } = require('./errors');

/**
 * Jalankan aksi bisnis dalam satu transaksi. Bila ditolak (aturan bisnis / hak akses / constraint DB),
 * transaksi di-rollback lalu upaya tersebut tetap dicatat di audit log (result = rejected/denied).
 */
async function run(ctx, meta, fn) {
  try {
    return await tx((conn) => fn(conn));
  } catch (raw) {
    const err = translateDbError(raw);
    if (err instanceof BusinessError || err instanceof AccessError) {
      await audit.logOutside(ctx, {
        action: meta.action,
        docType: meta.docType,
        docId: meta.docId,
        docNumber: err.docNumber || meta.docNumber,
        result: err instanceof AccessError ? 'denied' : 'rejected',
        message: err.message,
        detail: { rule: err.rule || null, ...(err.detail || {}), ...(meta.detail || {}) },
      });
    }
    throw err;
  }
}

module.exports = { run };
