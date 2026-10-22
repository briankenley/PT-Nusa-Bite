'use strict';

/** Pelanggaran aturan bisnis (SR-xx). Transaksi dibatalkan dan upaya dicatat di audit log. */
class BusinessError extends Error {
  constructor(message, { rule = null, detail = null, docNumber = null } = {}) {
    super(message);
    this.name = 'BusinessError';
    this.rule = rule;
    this.detail = detail;
    this.docNumber = docNumber;
    this.status = 422;
  }
}

/** Pengguna tidak memiliki hak untuk aksi ini (SR-13). */
class AccessError extends Error {
  constructor(message, { perm = null, docNumber = null } = {}) {
    super(message);
    this.name = 'AccessError';
    this.rule = 'SR-13';
    this.perm = perm;
    this.docNumber = docNumber;
    this.status = 403;
  }
}

class NotFoundError extends Error {
  constructor(message = 'Data tidak ditemukan') {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

// Constraint database adalah lapisan pengaman terakhir bila logika aplikasi terlewat.
const CONSTRAINT_RULES = {
  uq_partners_code: ['SR-12', 'ID kontak sudah dipakai'],
  uq_products_sku: ['SR-21', 'SKU sudah dipakai'],
  uq_products_variant: ['SR-21', 'Kombinasi produk, ukuran, warna, dan satuan sudah ada'],
  uq_opp_lead: ['SR-22', 'Lead sudah pernah dikonversi menjadi Opportunity'],
  uq_je_event: ['SR-12', 'Kejadian bisnis ini sudah pernah diposting'],
  uq_payslip_period: ['SR-12', 'Payslip karyawan untuk periode ini sudah ada'],
  uq_employee_code: ['SR-15', 'Employee ID sudah dipakai'],
  chk_quant_available: ['SR-04', 'Available stock tidak boleh negatif'],
  chk_quant_onhand: ['SR-04', 'On Hand tidak boleh negatif'],
  chk_sol_invoiced: ['SR-02', 'Kuantitas ditagih melebihi kuantitas terkirim'],
  chk_sol_returned: ['SR-10', 'Kuantitas retur melebihi kuantitas terkirim'],
  chk_pol_billed: ['SR-06', 'Kuantitas Bill melebihi accepted quantity'],
  chk_pol_received: ['SR-19', 'Kuantitas diterima melebihi kuantitas PO'],
  chk_move_qc: ['SR-19', 'Accepted + Rejected harus sama dengan Received'],
  chk_inv_residual: ['SR-20', 'Pembayaran melebihi sisa tagihan'],
  chk_je_balanced: ['SR-12', 'Jurnal tidak seimbang'],
};

/** Ubah error MySQL (duplikat / CHECK) menjadi BusinessError yang bisa dibaca pengguna. */
function translateDbError(err) {
  if (!err || !err.code) return err;
  if (err.code === 'ER_DUP_ENTRY' || err.code === 'ER_CHECK_CONSTRAINT_VIOLATED') {
    const keyMatch = String(err.sqlMessage || err.message).match(/(?:key|constraint) '(?:[\w]+\.)?([\w]+)'/i);
    const key = keyMatch ? keyMatch[1] : null;
    const [rule, text] = CONSTRAINT_RULES[key] || ['SR-12', 'Data melanggar constraint database'];
    const dup = String(err.sqlMessage || '').match(/Duplicate entry '([^']*)'/);
    return new BusinessError(`${text}${dup ? ` (${dup[1]})` : ''}. Ditolak oleh database [${key || err.code}].`, {
      rule,
      detail: { constraint: key, db_code: err.code },
    });
  }
  return err;
}

module.exports = { BusinessError, AccessError, NotFoundError, translateDbError };
