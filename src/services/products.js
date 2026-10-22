'use strict';
const { q, q1, getPool } = require('../db');
const { run } = require('../lib/action');
const { requirePerm, can } = require('../lib/acl');
const { BusinessError, AccessError, NotFoundError } = require('../lib/errors');
const { nowStr } = require('../lib/time');
const { toInt, rp } = require('../lib/money');
const audit = require('../lib/audit');

async function listProducts() {
  const rows = await q(getPool(), `SELECT p.*, v.code AS vendor_code, v.name AS vendor_name,
      COALESCE(SUM(CASE WHEN l.code = 'WH-PKU' THEN sq.on_hand END), 0) AS wh_on_hand,
      COALESCE(SUM(CASE WHEN l.code = 'OUTLET-SUD' THEN sq.on_hand END), 0) AS outlet_on_hand,
      COALESCE(SUM(sq.on_hand), 0) AS on_hand,
      COALESCE(SUM(sq.reserved), 0) AS reserved
    FROM products p
    LEFT JOIN partners v ON v.id = p.default_vendor_id
    LEFT JOIN stock_quants sq ON sq.product_id = p.id
    LEFT JOIN locations l ON l.id = sq.location_id
    GROUP BY p.id ORDER BY p.id`);
  return rows.map((r) => ({
    ...r,
    on_hand: Number(r.on_hand), reserved: Number(r.reserved), wh_on_hand: Number(r.wh_on_hand), outlet_on_hand: Number(r.outlet_on_hand),
    available: Number(r.on_hand) - Number(r.reserved), value: Number(r.on_hand) * r.standard_cost,
  }));
}

async function getProduct(id) {
  const pool = getPool();
  const p = await q1(pool, `SELECT p.*, v.code AS vendor_code, v.name AS vendor_name FROM products p
    LEFT JOIN partners v ON v.id = p.default_vendor_id WHERE p.id = ?`, [id]);
  if (!p) throw new NotFoundError('Produk tidak ditemukan');
  p.quants = await q(pool, `SELECT sq.*, l.code AS location_code, l.name AS location_name, (sq.on_hand - sq.reserved) AS available
    FROM stock_quants sq JOIN locations l ON l.id = sq.location_id WHERE sq.product_id = ? ORDER BY l.id`, [id]);
  p.pricelist = await q(pool, `SELECT pl.*, v.code AS vendor_code, v.name AS vendor_name FROM vendor_pricelist pl
    JOIN partners v ON v.id = pl.vendor_id WHERE pl.product_id = ?`, [id]);
  p.moves = await q(pool, `SELECT m.*, s.code AS src_code, d.code AS dest_code, pk.number AS picking_number
    FROM stock_moves m JOIN locations s ON s.id = m.src_location_id JOIN locations d ON d.id = m.dest_location_id
    LEFT JOIN pickings pk ON pk.id = m.picking_id
    WHERE m.product_id = ? AND m.state = 'done' ORDER BY m.done_at DESC, m.id DESC LIMIT 30`, [id]);
  return p;
}

function normalize(data) {
  return {
    sku: String(data.sku || '').trim().toUpperCase(),
    name: String(data.name || '').trim(),
    size: String(data.size || '').trim(),
    color: String(data.color || '').trim(),
    uom: String(data.uom || '').trim(),
    sales_price: toInt(data.sales_price, 0),
    standard_cost: toInt(data.standard_cost, 0),
    default_vendor_id: data.default_vendor_id ? Number(data.default_vendor_id) : null,
  };
}

async function assertUniqueVariant(conn, d, excludeId = 0) {
  const sku = await q1(conn, 'SELECT id FROM products WHERE sku = ? AND id <> ?', [d.sku, excludeId]);
  if (sku) {
    throw new BusinessError(`SKU ${d.sku} sudah ada di katalog. Variant SKU harus unik (SR-21).`, { rule: 'SR-21', docNumber: d.sku });
  }
  const combo = await q1(conn, 'SELECT sku FROM products WHERE name = ? AND size = ? AND color = ? AND uom = ? AND id <> ?',
    [d.name, d.size, d.color, d.uom, excludeId]);
  if (combo) {
    throw new BusinessError(`Kombinasi ${d.name} / ${d.size} / ${d.color} / ${d.uom} sudah terdaftar sebagai ${combo.sku}. Rekaman ganda ditolak (SR-21).`, {
      rule: 'SR-21', docNumber: d.sku, detail: { existing_sku: combo.sku },
    });
  }
}

async function createProduct(ctx, data) {
  const d = normalize(data);
  return run(ctx, { action: 'PRODUCT_CREATE', docType: 'product', docNumber: d.sku }, async (conn) => {
    requirePerm(ctx, 'products.edit', d.sku);
    for (const f of ['sku', 'name', 'size', 'color', 'uom']) {
      if (!d[f]) throw new BusinessError(`Field ${f} wajib diisi untuk Variant SKU (SR-21).`, { rule: 'SR-21', docNumber: d.sku });
    }
    if (!/^[A-Z0-9-]{2,30}$/.test(d.sku)) throw new BusinessError('Format SKU: huruf besar, angka, dan tanda minus.', { rule: 'SR-21', docNumber: d.sku });
    if ((d.sales_price || d.standard_cost) && !can(ctx.user.role, 'products.edit_price')) {
      throw new AccessError('Harga jual dan standard cost hanya boleh diisi Finance/Owner (SR-13).', { perm: 'products.edit_price', docNumber: d.sku });
    }
    if (d.sales_price < 0 || d.standard_cost < 0) throw new BusinessError('Harga dan biaya tidak boleh negatif.', { rule: 'SR-13' });
    await assertUniqueVariant(conn, d);
    const now = nowStr();
    const [r] = await conn.query(`INSERT INTO products (sku, name, size, color, uom, sales_price, standard_cost, default_vendor_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [d.sku, d.name, d.size, d.color, d.uom, d.sales_price, d.standard_cost, d.default_vendor_id, now, now]);
    const internals = await q(conn, "SELECT id FROM locations WHERE usage_type = 'internal'");
    for (const l of internals) await q(conn, 'INSERT INTO stock_quants (product_id, location_id, on_hand, reserved) VALUES (?, ?, 0, 0)', [r.insertId, l.id]);
    if (d.default_vendor_id) {
      await q(conn, 'INSERT INTO vendor_pricelist (vendor_id, product_id, uom, unit_price, min_qty) VALUES (?, ?, ?, ?, 1)', [d.default_vendor_id, r.insertId, d.uom, d.standard_cost]);
    }
    await audit.log(conn, ctx, { action: 'PRODUCT_CREATE', docType: 'product', docId: r.insertId, docNumber: d.sku, message: `SKU ${d.sku} dibuat`, detail: d });
    await audit.note(conn, ctx, 'product', r.insertId, `SKU dibuat: ${d.name} ${d.size} ${d.color} (${d.uom}).`);
    return r.insertId;
  });
}

async function updateProduct(ctx, id, data) {
  return run(ctx, { action: 'PRODUCT_UPDATE', docType: 'product', docId: id }, async (conn) => {
    requirePerm(ctx, 'products.edit');
    const p = await q1(conn, 'SELECT * FROM products WHERE id = ? FOR UPDATE', [id]);
    if (!p) throw new NotFoundError('Produk tidak ditemukan');
    const d = normalize({ ...p, ...data });
    if (data.sku !== undefined && d.sku !== p.sku) {
      throw new BusinessError(`SKU ${p.sku} adalah identitas tetap dan tidak boleh diubah (SR-21).`, { rule: 'SR-21', docNumber: p.sku });
    }
    const priceChanged = d.sales_price !== p.sales_price || d.standard_cost !== p.standard_cost;
    if (priceChanged) requirePerm(ctx, 'products.edit_price', p.sku);
    if (d.standard_cost !== p.standard_cost) {
      const st = await q1(conn, 'SELECT COALESCE(SUM(on_hand), 0) AS qty FROM stock_quants WHERE product_id = ?', [id]);
      if (Number(st.qty) > 0) {
        throw new BusinessError(`Standard cost ${p.sku} tidak dapat diubah selama masih ada ${st.qty} unit stok, karena valuasi persediaan akan berubah tanpa jurnal revaluasi (SR-13).`, {
          rule: 'SR-13', docNumber: p.sku,
        });
      }
    }
    await assertUniqueVariant(conn, d, id);
    const changes = {};
    for (const f of ['name', 'size', 'color', 'uom', 'sales_price', 'standard_cost', 'default_vendor_id']) {
      if (String(d[f] ?? '') !== String(p[f] ?? '')) changes[f] = { old: p[f], new: d[f] };
    }
    if (!Object.keys(changes).length) return id;
    await q(conn, `UPDATE products SET name = ?, size = ?, color = ?, uom = ?, sales_price = ?, standard_cost = ?, default_vendor_id = ?, updated_at = ? WHERE id = ?`,
      [d.name, d.size, d.color, d.uom, d.sales_price, d.standard_cost, d.default_vendor_id, nowStr(), id]);
    await audit.log(conn, ctx, { action: 'PRODUCT_UPDATE', docType: 'product', docId: id, docNumber: p.sku, message: `Perubahan ${Object.keys(changes).join(', ')}`, detail: changes });
    await audit.note(conn, ctx, 'product', id, `Diubah: ${Object.entries(changes).map(([k, v]) => `${k} ${k.includes('price') || k.includes('cost') ? `${rp(v.old)} → ${rp(v.new)}` : `${v.old} → ${v.new}`}`).join('; ')}`);
    return id;
  });
}

module.exports = { listProducts, getProduct, createProduct, updateProduct };
