-- Skema database ERP PT NusaBite Cepat Saji (MySQL 8.0+)
-- Semua tabel memiliki PRIMARY KEY (wajib di Aiven: sql_require_primary_key=ON).
-- Nominal uang disimpan sebagai BIGINT Rupiah utuh (tanpa desimal).

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS messages, audit_logs, payslips, employee_history, employees,
  reconciliations, payments, invoice_lines, invoices, journal_lines, journal_entries,
  stock_moves, pickings, purchase_order_lines, purchase_orders, sale_revisions,
  sale_order_lines, sale_orders, crm_opportunities, crm_leads, stock_quants,
  vendor_pricelist, products, locations, partners, accounts, taxes, payment_terms,
  sequences, users, company;
SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE company (
  id INT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  short_name VARCHAR(40) NOT NULL,
  currency CHAR(3) NOT NULL,
  city VARCHAR(60) NOT NULL,
  schema_hash CHAR(40) NOT NULL,
  baseline_at DATETIME(3) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(40) NOT NULL,
  full_name VARCHAR(120) NOT NULL,
  role ENUM('sales','warehouse','finance','hr','cashier','owner') NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB;

-- Penomoran dokumen (SR-12). Baris dikunci FOR UPDATE saat mengambil nomor.
CREATE TABLE sequences (
  code VARCHAR(40) PRIMARY KEY,
  prefix VARCHAR(30) NOT NULL,
  padding TINYINT NOT NULL,
  next_number INT NOT NULL
) ENGINE=InnoDB;

CREATE TABLE payment_terms (
  code VARCHAR(10) PRIMARY KEY,
  description VARCHAR(60) NOT NULL,
  due_days INT NOT NULL
) ENGINE=InnoDB;

CREATE TABLE taxes (
  code VARCHAR(10) PRIMARY KEY,
  name VARCHAR(60) NOT NULL,
  rate_pct DECIMAL(5,2) NOT NULL,
  base VARCHAR(60) NOT NULL,
  usage_note VARCHAR(60) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE accounts (
  code VARCHAR(10) PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  account_type VARCHAR(30) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE partners (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL,
  name VARCHAR(120) NOT NULL,
  partner_type ENUM('company','person') NOT NULL,
  is_customer TINYINT(1) NOT NULL DEFAULT 0,
  is_vendor TINYINT(1) NOT NULL DEFAULT 0,
  city VARCHAR(60) NULL,
  credit_limit BIGINT NOT NULL DEFAULT 0,
  payment_term_code VARCHAR(10) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_partners_code (code),
  CONSTRAINT fk_partner_term FOREIGN KEY (payment_term_code) REFERENCES payment_terms(code),
  CONSTRAINT chk_partner_credit CHECK (credit_limit >= 0)
) ENGINE=InnoDB;

CREATE TABLE locations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL,
  name VARCHAR(80) NOT NULL,
  loc_type VARCHAR(30) NOT NULL,
  usage_type ENUM('internal','vendor','customer','inventory','rejected','damaged') NOT NULL,
  city VARCHAR(60) NULL,
  UNIQUE KEY uq_locations_code (code)
) ENGINE=InnoDB;

-- Variant SKU (SR-21): SKU unik dan kombinasi produk+ukuran+warna+satuan unik.
CREATE TABLE products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(30) NOT NULL,
  name VARCHAR(80) NOT NULL,
  size VARCHAR(30) NOT NULL,
  color VARCHAR(30) NOT NULL,
  uom VARCHAR(20) NOT NULL,
  sales_price BIGINT NOT NULL,
  standard_cost BIGINT NOT NULL,
  default_vendor_id INT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_products_sku (sku),
  UNIQUE KEY uq_products_variant (name, size, color, uom),
  CONSTRAINT fk_product_vendor FOREIGN KEY (default_vendor_id) REFERENCES partners(id),
  CONSTRAINT chk_product_price CHECK (sales_price >= 0 AND standard_cost >= 0)
) ENGINE=InnoDB;

CREATE TABLE vendor_pricelist (
  id INT AUTO_INCREMENT PRIMARY KEY,
  vendor_id INT NOT NULL,
  product_id INT NOT NULL,
  uom VARCHAR(20) NOT NULL,
  unit_price BIGINT NOT NULL,
  min_qty INT NOT NULL DEFAULT 1,
  UNIQUE KEY uq_pricelist (vendor_id, product_id, min_qty),
  CONSTRAINT fk_pl_vendor FOREIGN KEY (vendor_id) REFERENCES partners(id),
  CONSTRAINT fk_pl_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB;

-- Stok per SKU per lokasi. Available = on_hand - reserved, tidak boleh negatif (SR-04).
CREATE TABLE stock_quants (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  location_id INT NOT NULL,
  on_hand INT NOT NULL DEFAULT 0,
  reserved INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_quant (product_id, location_id),
  CONSTRAINT fk_quant_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_quant_location FOREIGN KEY (location_id) REFERENCES locations(id),
  CONSTRAINT chk_quant_onhand CHECK (on_hand >= 0),
  CONSTRAINT chk_quant_reserved CHECK (reserved >= 0),
  CONSTRAINT chk_quant_available CHECK (reserved <= on_hand)
) ENGINE=InnoDB;

CREATE TABLE crm_leads (
  id INT AUTO_INCREMENT PRIMARY KEY,
  number VARCHAR(20) NOT NULL,
  name VARCHAR(120) NOT NULL,
  partner_id INT NULL,
  description VARCHAR(255) NULL,
  state ENUM('new','converted','lost') NOT NULL DEFAULT 'new',
  created_by INT NULL,
  created_at DATETIME(3) NOT NULL,
  converted_by INT NULL,
  converted_at DATETIME(3) NULL,
  UNIQUE KEY uq_leads_number (number),
  CONSTRAINT fk_lead_partner FOREIGN KEY (partner_id) REFERENCES partners(id)
) ENGINE=InnoDB;

-- Satu lead hanya boleh menjadi satu opportunity (SR-22): UNIQUE(lead_id).
CREATE TABLE crm_opportunities (
  id INT AUTO_INCREMENT PRIMARY KEY,
  number VARCHAR(20) NOT NULL,
  lead_id INT NOT NULL,
  name VARCHAR(120) NOT NULL,
  partner_id INT NULL,
  stage ENUM('new','qualified','proposition','won','lost') NOT NULL DEFAULT 'new',
  expected_revenue BIGINT NOT NULL DEFAULT 0,
  created_by INT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_opp_number (number),
  UNIQUE KEY uq_opp_lead (lead_id),
  CONSTRAINT fk_opp_lead FOREIGN KEY (lead_id) REFERENCES crm_leads(id),
  CONSTRAINT fk_opp_partner FOREIGN KEY (partner_id) REFERENCES partners(id)
) ENGINE=InnoDB;

CREATE TABLE sale_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  number VARCHAR(20) NOT NULL,
  partner_id INT NOT NULL,
  opportunity_id INT NULL,
  location_id INT NOT NULL,
  state ENUM('draft','sale','cancel') NOT NULL DEFAULT 'draft',
  is_counter TINYINT(1) NOT NULL DEFAULT 0,
  order_date DATE NOT NULL,
  payment_term_code VARCHAR(10) NOT NULL,
  amount_untaxed BIGINT NOT NULL DEFAULT 0,
  amount_tax BIGINT NOT NULL DEFAULT 0,
  amount_total BIGINT NOT NULL DEFAULT 0,
  discount_approval ENUM('none','pending','approved') NOT NULL DEFAULT 'none',
  approved_by INT NULL,
  approved_at DATETIME(3) NULL,
  note VARCHAR(255) NULL,
  created_by INT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  confirmed_by INT NULL,
  confirmed_at DATETIME(3) NULL,
  UNIQUE KEY uq_so_number (number),
  CONSTRAINT fk_so_partner FOREIGN KEY (partner_id) REFERENCES partners(id),
  CONSTRAINT fk_so_opp FOREIGN KEY (opportunity_id) REFERENCES crm_opportunities(id),
  CONSTRAINT fk_so_location FOREIGN KEY (location_id) REFERENCES locations(id)
) ENGINE=InnoDB;

CREATE TABLE sale_order_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  seq INT NOT NULL,
  product_id INT NOT NULL,
  qty INT NOT NULL,
  list_price BIGINT NOT NULL,
  unit_price BIGINT NOT NULL,
  discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  tax_code VARCHAR(10) NOT NULL,
  subtotal BIGINT NOT NULL,
  tax_amount BIGINT NOT NULL,
  total BIGINT NOT NULL,
  qty_delivered INT NOT NULL DEFAULT 0,
  qty_returned INT NOT NULL DEFAULT 0,
  qty_invoiced INT NOT NULL DEFAULT 0,
  qty_credited INT NOT NULL DEFAULT 0,
  qty_cancelled INT NOT NULL DEFAULT 0,
  KEY ix_sol_order (order_id),
  CONSTRAINT fk_sol_order FOREIGN KEY (order_id) REFERENCES sale_orders(id),
  CONSTRAINT fk_sol_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_sol_tax FOREIGN KEY (tax_code) REFERENCES taxes(code),
  CONSTRAINT chk_sol_qty CHECK (qty > 0),
  CONSTRAINT chk_sol_price CHECK (unit_price >= 0 AND list_price >= 0),
  CONSTRAINT chk_sol_disc CHECK (discount_pct >= 0 AND discount_pct <= 100),
  CONSTRAINT chk_sol_delivered CHECK (qty_delivered >= 0 AND qty_delivered + qty_cancelled <= qty),
  CONSTRAINT chk_sol_returned CHECK (qty_returned >= 0 AND qty_returned <= qty_delivered),
  CONSTRAINT chk_sol_invoiced CHECK (qty_invoiced >= 0 AND qty_invoiced <= qty_delivered),
  CONSTRAINT chk_sol_credited CHECK (qty_credited >= 0 AND qty_credited <= qty_invoiced)
) ENGINE=InnoDB;

-- Perubahan harga/diskon setelah Confirmed hanya lewat dokumen revisi (SR-08).
CREATE TABLE sale_revisions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  number VARCHAR(30) NOT NULL,
  order_id INT NOT NULL,
  line_id INT NOT NULL,
  old_unit_price BIGINT NOT NULL,
  new_unit_price BIGINT NOT NULL,
  old_discount DECIMAL(5,2) NOT NULL,
  new_discount DECIMAL(5,2) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  state ENUM('pending','applied','rejected') NOT NULL DEFAULT 'pending',
  requested_by INT NOT NULL,
  requested_at DATETIME(3) NOT NULL,
  decided_by INT NULL,
  decided_at DATETIME(3) NULL,
  UNIQUE KEY uq_rev_number (number),
  CONSTRAINT fk_rev_order FOREIGN KEY (order_id) REFERENCES sale_orders(id),
  CONSTRAINT fk_rev_line FOREIGN KEY (line_id) REFERENCES sale_order_lines(id)
) ENGINE=InnoDB;

CREATE TABLE purchase_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  number VARCHAR(20) NOT NULL,
  partner_id INT NOT NULL,
  state ENUM('draft','purchase','cancel') NOT NULL DEFAULT 'draft',
  order_date DATE NOT NULL,
  dest_location_id INT NOT NULL,
  amount_untaxed BIGINT NOT NULL DEFAULT 0,
  amount_tax BIGINT NOT NULL DEFAULT 0,
  amount_total BIGINT NOT NULL DEFAULT 0,
  note VARCHAR(255) NULL,
  created_by INT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  confirmed_by INT NULL,
  confirmed_at DATETIME(3) NULL,
  UNIQUE KEY uq_po_number (number),
  CONSTRAINT fk_po_partner FOREIGN KEY (partner_id) REFERENCES partners(id),
  CONSTRAINT fk_po_location FOREIGN KEY (dest_location_id) REFERENCES locations(id)
) ENGINE=InnoDB;

-- qty_received = kuantitas ACCEPTED (lolos QC). Bill tidak boleh melebihi accepted (SR-06).
CREATE TABLE purchase_order_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  seq INT NOT NULL,
  product_id INT NOT NULL,
  qty INT NOT NULL,
  unit_price BIGINT NOT NULL,
  tax_code VARCHAR(10) NOT NULL,
  subtotal BIGINT NOT NULL,
  tax_amount BIGINT NOT NULL,
  total BIGINT NOT NULL,
  qty_received INT NOT NULL DEFAULT 0,
  qty_rejected INT NOT NULL DEFAULT 0,
  qty_billed INT NOT NULL DEFAULT 0,
  KEY ix_pol_order (order_id),
  CONSTRAINT fk_pol_order FOREIGN KEY (order_id) REFERENCES purchase_orders(id),
  CONSTRAINT fk_pol_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_pol_tax FOREIGN KEY (tax_code) REFERENCES taxes(code),
  CONSTRAINT chk_pol_qty CHECK (qty > 0),
  CONSTRAINT chk_pol_received CHECK (qty_received >= 0 AND qty_rejected >= 0 AND qty_received + qty_rejected <= qty),
  CONSTRAINT chk_pol_billed CHECK (qty_billed >= 0 AND qty_billed <= qty_received)
) ENGINE=InnoDB;

-- Dokumen gudang: out = Delivery Order, in = Receipt, int = Internal Transfer, ret = Return.
CREATE TABLE pickings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  number VARCHAR(30) NOT NULL,
  picking_type ENUM('out','in','int','ret') NOT NULL,
  state ENUM('draft','ready','qc','done','cancel') NOT NULL DEFAULT 'draft',
  partner_id INT NULL,
  src_location_id INT NOT NULL,
  dest_location_id INT NOT NULL,
  sale_order_id INT NULL,
  purchase_order_id INT NULL,
  return_of_id INT NULL,
  backorder_of_id INT NULL,
  scheduled_date DATE NOT NULL,
  note VARCHAR(255) NULL,
  created_by INT NULL,
  created_at DATETIME(3) NOT NULL,
  done_by INT NULL,
  done_at DATETIME(3) NULL,
  UNIQUE KEY uq_picking_number (number),
  KEY ix_picking_so (sale_order_id),
  KEY ix_picking_po (purchase_order_id),
  CONSTRAINT fk_pick_partner FOREIGN KEY (partner_id) REFERENCES partners(id),
  CONSTRAINT fk_pick_src FOREIGN KEY (src_location_id) REFERENCES locations(id),
  CONSTRAINT fk_pick_dest FOREIGN KEY (dest_location_id) REFERENCES locations(id),
  CONSTRAINT fk_pick_so FOREIGN KEY (sale_order_id) REFERENCES sale_orders(id),
  CONSTRAINT fk_pick_po FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id),
  CONSTRAINT fk_pick_return FOREIGN KEY (return_of_id) REFERENCES pickings(id),
  CONSTRAINT fk_pick_backorder FOREIGN KEY (backorder_of_id) REFERENCES pickings(id)
) ENGINE=InnoDB;

CREATE TABLE stock_moves (
  id INT AUTO_INCREMENT PRIMARY KEY,
  picking_id INT NULL,
  product_id INT NOT NULL,
  src_location_id INT NOT NULL,
  dest_location_id INT NOT NULL,
  qty_demand INT NOT NULL,
  qty_reserved INT NOT NULL DEFAULT 0,
  qty_done INT NOT NULL DEFAULT 0,
  qty_received INT NOT NULL DEFAULT 0,
  qty_accepted INT NOT NULL DEFAULT 0,
  qty_rejected INT NOT NULL DEFAULT 0,
  qty_sellable INT NOT NULL DEFAULT 0,
  qty_damaged INT NOT NULL DEFAULT 0,
  unit_cost BIGINT NOT NULL DEFAULT 0,
  value BIGINT NOT NULL DEFAULT 0,
  state ENUM('draft','ready','done','cancel') NOT NULL DEFAULT 'draft',
  sale_line_id INT NULL,
  purchase_line_id INT NULL,
  origin_move_id INT NULL,
  ref VARCHAR(60) NULL,
  created_at DATETIME(3) NOT NULL,
  done_at DATETIME(3) NULL,
  KEY ix_move_picking (picking_id),
  KEY ix_move_product (product_id),
  CONSTRAINT fk_move_picking FOREIGN KEY (picking_id) REFERENCES pickings(id),
  CONSTRAINT fk_move_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_move_src FOREIGN KEY (src_location_id) REFERENCES locations(id),
  CONSTRAINT fk_move_dest FOREIGN KEY (dest_location_id) REFERENCES locations(id),
  CONSTRAINT fk_move_sol FOREIGN KEY (sale_line_id) REFERENCES sale_order_lines(id),
  CONSTRAINT fk_move_pol FOREIGN KEY (purchase_line_id) REFERENCES purchase_order_lines(id),
  CONSTRAINT fk_move_origin FOREIGN KEY (origin_move_id) REFERENCES stock_moves(id),
  CONSTRAINT chk_move_qty CHECK (qty_demand >= 0 AND qty_reserved >= 0 AND qty_done >= 0 AND qty_reserved <= qty_demand),
  CONSTRAINT chk_move_qc CHECK (qty_accepted + qty_rejected = qty_received),
  CONSTRAINT chk_move_return CHECK (qty_sellable + qty_damaged <= qty_demand)
) ENGINE=InnoDB;

CREATE TABLE journal_entries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  number VARCHAR(30) NULL,
  journal VARCHAR(10) NOT NULL,
  entry_date DATE NOT NULL,
  ref VARCHAR(160) NULL,
  source_type VARCHAR(30) NULL,
  source_id INT NULL,
  -- Satu kejadian bisnis hanya boleh menghasilkan satu jurnal (SR-12).
  event_key VARCHAR(80) NULL,
  state ENUM('draft','posted') NOT NULL DEFAULT 'draft',
  total_debit BIGINT NOT NULL DEFAULT 0,
  total_credit BIGINT NOT NULL DEFAULT 0,
  created_by INT NULL,
  created_at DATETIME(3) NOT NULL,
  posted_by INT NULL,
  posted_at DATETIME(3) NULL,
  UNIQUE KEY uq_je_number (number),
  UNIQUE KEY uq_je_event (event_key),
  KEY ix_je_source (source_type, source_id),
  CONSTRAINT chk_je_balanced CHECK (total_debit = total_credit)
) ENGINE=InnoDB;

CREATE TABLE journal_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entry_id INT NOT NULL,
  account_code VARCHAR(10) NOT NULL,
  partner_id INT NULL,
  label VARCHAR(160) NULL,
  debit BIGINT NOT NULL DEFAULT 0,
  credit BIGINT NOT NULL DEFAULT 0,
  KEY ix_jl_entry (entry_id),
  KEY ix_jl_account (account_code),
  CONSTRAINT fk_jl_entry FOREIGN KEY (entry_id) REFERENCES journal_entries(id),
  CONSTRAINT fk_jl_account FOREIGN KEY (account_code) REFERENCES accounts(code),
  CONSTRAINT fk_jl_partner FOREIGN KEY (partner_id) REFERENCES partners(id),
  CONSTRAINT chk_jl_amount CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0))
) ENGINE=InnoDB;

-- out_invoice = Customer Invoice, out_refund = Credit Note, in_invoice = Vendor Bill.
CREATE TABLE invoices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  number VARCHAR(30) NULL,
  move_type ENUM('out_invoice','out_refund','in_invoice') NOT NULL,
  partner_id INT NOT NULL,
  sale_order_id INT NULL,
  purchase_order_id INT NULL,
  origin_invoice_id INT NULL,
  return_picking_id INT NULL,
  state ENUM('draft','posted','cancel') NOT NULL DEFAULT 'draft',
  payment_state ENUM('not_paid','partial','paid') NOT NULL DEFAULT 'not_paid',
  invoice_date DATE NULL,
  due_date DATE NULL,
  payment_term_code VARCHAR(10) NOT NULL,
  amount_untaxed BIGINT NOT NULL DEFAULT 0,
  amount_tax BIGINT NOT NULL DEFAULT 0,
  amount_total BIGINT NOT NULL DEFAULT 0,
  amount_residual BIGINT NOT NULL DEFAULT 0,
  journal_entry_id INT NULL,
  note VARCHAR(255) NULL,
  created_by INT NULL,
  created_at DATETIME(3) NOT NULL,
  posted_by INT NULL,
  posted_at DATETIME(3) NULL,
  UNIQUE KEY uq_invoice_number (number),
  KEY ix_inv_so (sale_order_id),
  KEY ix_inv_po (purchase_order_id),
  CONSTRAINT fk_inv_partner FOREIGN KEY (partner_id) REFERENCES partners(id),
  CONSTRAINT fk_inv_so FOREIGN KEY (sale_order_id) REFERENCES sale_orders(id),
  CONSTRAINT fk_inv_po FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id),
  CONSTRAINT fk_inv_origin FOREIGN KEY (origin_invoice_id) REFERENCES invoices(id),
  CONSTRAINT fk_inv_return FOREIGN KEY (return_picking_id) REFERENCES pickings(id),
  CONSTRAINT fk_inv_je FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  CONSTRAINT chk_inv_residual CHECK (amount_residual >= 0 AND amount_residual <= amount_total)
) ENGINE=InnoDB;

CREATE TABLE invoice_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  invoice_id INT NOT NULL,
  seq INT NOT NULL,
  product_id INT NOT NULL,
  sale_line_id INT NULL,
  purchase_line_id INT NULL,
  qty INT NOT NULL,
  unit_price BIGINT NOT NULL,
  discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  tax_code VARCHAR(10) NOT NULL,
  subtotal BIGINT NOT NULL,
  tax_amount BIGINT NOT NULL,
  total BIGINT NOT NULL,
  KEY ix_il_invoice (invoice_id),
  CONSTRAINT fk_il_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id),
  CONSTRAINT fk_il_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_il_sol FOREIGN KEY (sale_line_id) REFERENCES sale_order_lines(id),
  CONSTRAINT fk_il_pol FOREIGN KEY (purchase_line_id) REFERENCES purchase_order_lines(id),
  CONSTRAINT chk_il_qty CHECK (qty > 0)
) ENGINE=InnoDB;

CREATE TABLE payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  number VARCHAR(30) NOT NULL,
  payment_type ENUM('inbound','outbound') NOT NULL,
  partner_id INT NOT NULL,
  invoice_id INT NOT NULL,
  amount BIGINT NOT NULL,
  method ENUM('bank','cash') NOT NULL,
  payment_date DATE NOT NULL,
  state ENUM('draft','posted') NOT NULL DEFAULT 'posted',
  journal_entry_id INT NULL,
  memo VARCHAR(160) NULL,
  created_by INT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_payment_number (number),
  KEY ix_pay_invoice (invoice_id),
  CONSTRAINT fk_pay_partner FOREIGN KEY (partner_id) REFERENCES partners(id),
  CONSTRAINT fk_pay_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id),
  CONSTRAINT fk_pay_je FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  CONSTRAINT chk_pay_amount CHECK (amount > 0)
) ENGINE=InnoDB;

-- Jejak pengurangan saldo invoice oleh pembayaran atau credit note.
CREATE TABLE reconciliations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  invoice_id INT NOT NULL,
  source_type ENUM('payment','credit_note') NOT NULL,
  source_id INT NOT NULL,
  amount BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_recon_source (source_type, source_id, invoice_id),
  CONSTRAINT fk_recon_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id),
  CONSTRAINT chk_recon_amount CHECK (amount > 0)
) ENGINE=InnoDB;

CREATE TABLE employees (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(10) NOT NULL,
  name VARCHAR(120) NOT NULL,
  job_title VARCHAR(60) NOT NULL,
  location_id INT NOT NULL,
  start_date DATE NOT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  base_salary BIGINT NOT NULL,
  fixed_allowance BIGINT NOT NULL,
  planned_days INT NOT NULL DEFAULT 22,
  attended_days INT NOT NULL DEFAULT 22,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_employee_code (code),
  CONSTRAINT fk_emp_location FOREIGN KEY (location_id) REFERENCES locations(id),
  CONSTRAINT chk_emp_salary CHECK (base_salary >= 0 AND fixed_allowance >= 0),
  CONSTRAINT chk_emp_days CHECK (planned_days > 0 AND attended_days >= 0 AND attended_days <= planned_days)
) ENGINE=InnoDB;

-- Riwayat perubahan data karyawan dan tarif gaji (SR-15).
CREATE TABLE employee_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  field VARCHAR(40) NOT NULL,
  old_value VARCHAR(120) NULL,
  new_value VARCHAR(120) NULL,
  changed_by INT NULL,
  changed_by_name VARCHAR(40) NOT NULL,
  changed_at DATETIME(3) NOT NULL,
  KEY ix_eh_employee (employee_id),
  CONSTRAINT fk_eh_employee FOREIGN KEY (employee_id) REFERENCES employees(id)
) ENGINE=InnoDB;

-- Satu payslip per karyawan per periode (idempotensi SR-12).
CREATE TABLE payslips (
  id INT AUTO_INCREMENT PRIMARY KEY,
  number VARCHAR(30) NOT NULL,
  employee_id INT NOT NULL,
  period CHAR(7) NOT NULL,
  planned_days INT NOT NULL,
  attended_days INT NOT NULL,
  base_salary BIGINT NOT NULL,
  fixed_allowance BIGINT NOT NULL,
  base_paid BIGINT NOT NULL,
  allowance_paid BIGINT NOT NULL,
  gross BIGINT NOT NULL,
  net BIGINT NOT NULL,
  state ENUM('draft','approved','posted','paid') NOT NULL DEFAULT 'draft',
  journal_entry_id INT NULL,
  payment_entry_id INT NULL,
  created_by INT NULL,
  created_at DATETIME(3) NOT NULL,
  approved_by INT NULL,
  approved_at DATETIME(3) NULL,
  posted_by INT NULL,
  posted_at DATETIME(3) NULL,
  paid_by INT NULL,
  paid_at DATETIME(3) NULL,
  UNIQUE KEY uq_payslip_number (number),
  UNIQUE KEY uq_payslip_period (employee_id, period),
  CONSTRAINT fk_ps_employee FOREIGN KEY (employee_id) REFERENCES employees(id),
  CONSTRAINT fk_ps_je FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  CONSTRAINT fk_ps_pay FOREIGN KEY (payment_entry_id) REFERENCES journal_entries(id),
  CONSTRAINT chk_ps_days CHECK (attended_days >= 0 AND attended_days <= planned_days)
) ENGINE=InnoDB;

-- Audit log minimum: actor, time, action, document (SR-13), termasuk upaya yang ditolak.
CREATE TABLE audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  ts DATETIME(3) NOT NULL,
  user_id INT NULL,
  username VARCHAR(40) NOT NULL,
  role VARCHAR(20) NOT NULL,
  action VARCHAR(60) NOT NULL,
  doc_type VARCHAR(40) NULL,
  doc_id INT NULL,
  doc_number VARCHAR(40) NULL,
  result ENUM('ok','denied','rejected') NOT NULL,
  message VARCHAR(500) NULL,
  detail JSON NULL,
  KEY ix_audit_doc (doc_type, doc_id),
  KEY ix_audit_number (doc_number),
  KEY ix_audit_ts (ts)
) ENGINE=InnoDB;

-- Log notes / chatter per dokumen.
CREATE TABLE messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  doc_type VARCHAR(40) NOT NULL,
  doc_id INT NOT NULL,
  author_id INT NULL,
  author_name VARCHAR(60) NOT NULL,
  kind ENUM('note','system') NOT NULL,
  body VARCHAR(1000) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY ix_msg_doc (doc_type, doc_id)
) ENGINE=InnoDB;
