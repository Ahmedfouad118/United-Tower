-- ==========================================================================
-- United Tower ERP — Database Schema v2 (SQLite / node:sqlite)
-- Double-entry ledger + deferred-revenue engine + analytic cost centers
-- (Property / Unit) + multilingual masters (AR / EN / UR).
-- ==========================================================================
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------- Users & granular permissions ----------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'viewer',   -- admin | accountant | viewer
  lang          TEXT NOT NULL DEFAULT 'ar',        -- ar | en | ur
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- per-user, per-module permission matrix (admin bypasses all)
CREATE TABLE IF NOT EXISTS user_permissions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module     TEXT NOT NULL,          -- e.g. customers, contracts, invoices, vendors, finance...
  can_view   INTEGER NOT NULL DEFAULT 0,
  can_add    INTEGER NOT NULL DEFAULT 0,
  can_edit   INTEGER NOT NULL DEFAULT 0,
  can_delete INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, module)
);

-- which buildings a (non-admin) user may see/enter data for. Admin sees all.
CREATE TABLE IF NOT EXISTS user_buildings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  UNIQUE(user_id, building_id)
);

-- ---------- Chart of accounts (multilingual, editable) --------------------
-- type: asset | liability | equity | income | expense
-- normal_balance: D | C
CREATE TABLE IF NOT EXISTS accounts (
  code           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,         -- English (default/back-compat)
  name_ar        TEXT,
  name_ur        TEXT,
  type           TEXT NOT NULL,
  normal_balance TEXT NOT NULL,
  parent_code    TEXT REFERENCES accounts(code),
  is_group       INTEGER NOT NULL DEFAULT 0,   -- header account (no postings)
  is_active      INTEGER NOT NULL DEFAULT 1
);

-- ---------- Settings & translations ---------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ---------- Categories master (customers / vendors / expense / unit) -------
CREATE TABLE IF NOT EXISTS categories (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  entity  TEXT NOT NULL,               -- customer | vendor | expense | unit
  name    TEXT NOT NULL,
  name_ar TEXT, name_ur TEXT,
  notes   TEXT
);

-- ---------- Payment methods master ----------------------------------------
CREATE TABLE IF NOT EXISTS payment_methods (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL, name_ar TEXT, name_ur TEXT,
  kind         TEXT NOT NULL DEFAULT 'bank',  -- cash | bank | cheque | card | online
  gl_account   TEXT REFERENCES accounts(code),
  active       INTEGER NOT NULL DEFAULT 1
);

-- ---------- Banks master (accounts + full details) ------------------------
CREATE TABLE IF NOT EXISTS banks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL, name_ar TEXT, name_ur TEXT,
  branch        TEXT,
  account_no    TEXT,
  iban          TEXT,
  swift         TEXT,
  currency      TEXT DEFAULT 'OMR',
  gl_account    TEXT REFERENCES accounts(code),  -- ledger account for this bank
  opening_balance REAL DEFAULT 0,
  notes         TEXT,
  active        INTEGER NOT NULL DEFAULT 1
);

-- ---------- Buildings (properties = primary cost center) ------------------
CREATE TABLE IF NOT EXISTS buildings (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  code      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL, name_ar TEXT, name_ur TEXT,
  address   TEXT,
  owner     TEXT,
  purchase_value REAL DEFAULT 0,       -- for ROI
  notes     TEXT,
  active    INTEGER NOT NULL DEFAULT 1
);

-- ---------- Flats / Units (sub cost center) -------------------------------
CREATE TABLE IF NOT EXISTS flats (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  building_id INTEGER REFERENCES buildings(id),
  unit_type   TEXT,                    -- studio | 1BR | 2BR | shop | office
  floor       TEXT,
  bedrooms    INTEGER,
  base_rent   REAL DEFAULT 0,
  category_id INTEGER REFERENCES categories(id),
  notes       TEXT
);

-- ---------- Tenants / Customers -------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT,
  name        TEXT NOT NULL, name_ar TEXT,
  phone       TEXT, email TEXT, civil_id TEXT,
  category_id INTEGER REFERENCES categories(id),
  opening_balance REAL DEFAULT 0,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Vendors / Suppliers -------------------------------------------
CREATE TABLE IF NOT EXISTS vendors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT,
  name        TEXT NOT NULL, name_ar TEXT,
  phone       TEXT, email TEXT, tax_no TEXT,
  category_id INTEGER REFERENCES categories(id),
  opening_balance REAL DEFAULT 0,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Contracts (leases) --------------------------------------------
-- status: active | expired | vacated | terminated
CREATE TABLE IF NOT EXISTS contracts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_no   TEXT,
  building_id   INTEGER REFERENCES buildings(id),
  flat_id       INTEGER NOT NULL REFERENCES flats(id),
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id),
  start_date    TEXT NOT NULL,
  end_date      TEXT NOT NULL,
  monthly_rent  REAL NOT NULL,
  vat_percent   REAL NOT NULL DEFAULT 5,
  deposit       REAL DEFAULT 0,        -- security deposit held
  deposit_journal INTEGER REFERENCES journals(id),
  status        TEXT NOT NULL DEFAULT 'active',
  terminated_on TEXT,
  settled_amount REAL,
  remarks       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Journals (double-entry) with analytic dimensions --------------
CREATE TABLE IF NOT EXISTS journals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  jdate        TEXT NOT NULL,
  jtype        TEXT NOT NULL,          -- invoice | recognition | receipt | payment | expense | deposit | opening | manual | adjustment
  reference    TEXT,
  memo         TEXT, memo_ar TEXT,
  source_table TEXT,
  source_id    INTEGER,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_id   INTEGER NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
  account_code TEXT NOT NULL REFERENCES accounts(code),
  debit        REAL NOT NULL DEFAULT 0,
  credit       REAL NOT NULL DEFAULT 0,
  building_id  INTEGER REFERENCES buildings(id),  -- analytic: property
  flat_id      INTEGER REFERENCES flats(id),      -- analytic: unit
  tenant_id    INTEGER REFERENCES tenants(id),
  vendor_id    INTEGER REFERENCES vendors(id),
  memo         TEXT
);
CREATE INDEX IF NOT EXISTS idx_lines_journal  ON journal_lines(journal_id);
CREATE INDEX IF NOT EXISTS idx_lines_account  ON journal_lines(account_code);
CREATE INDEX IF NOT EXISTS idx_lines_tenant   ON journal_lines(tenant_id);
CREATE INDEX IF NOT EXISTS idx_lines_vendor   ON journal_lines(vendor_id);
CREATE INDEX IF NOT EXISTS idx_lines_building ON journal_lines(building_id);
CREATE INDEX IF NOT EXISTS idx_lines_flat     ON journal_lines(flat_id);

-- ---------- Customer invoices (monthly rent / services) -------------------
-- Deferred-revenue model:
--   issue    : Dr Tenant Receivable / Cr Deferred Revenue (+ VAT payable)
--   recognize: Dr Deferred Revenue  / Cr Realized Rent Income (period portion)
--   collect  : Dr Bank/Cash         / Cr Tenant Receivable
-- status: draft | issued | partial | paid | recognized | cancelled
CREATE TABLE IF NOT EXISTS invoices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no    TEXT,
  contract_id   INTEGER REFERENCES contracts(id),
  building_id   INTEGER REFERENCES buildings(id),
  flat_id       INTEGER REFERENCES flats(id),
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id),
  period        TEXT,                  -- YYYY-MM (rent period covered)
  idate         TEXT NOT NULL,         -- issue date
  due_date      TEXT NOT NULL,
  rent_amount   REAL NOT NULL DEFAULT 0,
  service_amount REAL NOT NULL DEFAULT 0,
  vat_amount    REAL NOT NULL DEFAULT 0,
  total         REAL NOT NULL,
  paid_amount   REAL NOT NULL DEFAULT 0,
  recognized_amount REAL NOT NULL DEFAULT 0,  -- portion moved to realized income
  status        TEXT NOT NULL DEFAULT 'issued',
  issue_journal INTEGER REFERENCES journals(id),
  recog_journal INTEGER REFERENCES journals(id),
  memo          TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(contract_id, period)
);
CREATE INDEX IF NOT EXISTS idx_inv_tenant ON invoices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_inv_period ON invoices(period);
CREATE INDEX IF NOT EXISTS idx_inv_status ON invoices(status);

-- ---------- Receipts (سند قبض) --------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_no     TEXT,
  pdate          TEXT NOT NULL,
  tenant_id      INTEGER NOT NULL REFERENCES tenants(id),
  building_id    INTEGER REFERENCES buildings(id),
  flat_id        INTEGER REFERENCES flats(id),
  contract_id    INTEGER REFERENCES contracts(id),
  amount         REAL NOT NULL,
  applied_amount REAL NOT NULL DEFAULT 0,
  advance_amount REAL NOT NULL DEFAULT 0,
  method_id      INTEGER REFERENCES payment_methods(id),
  method         TEXT NOT NULL DEFAULT 'bank',
  cash_account   TEXT NOT NULL DEFAULT '10400',
  cheque_no      TEXT, cheque_due TEXT, cheque_status TEXT,
  bank_id        INTEGER REFERENCES banks(id),
  memo           TEXT,
  journal_id     INTEGER REFERENCES journals(id),
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pay_tenant ON payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pay_date   ON payments(pdate);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  amount     REAL NOT NULL
);

-- ---------- Vendor bills + payments (سند صرف) -----------------------------
CREATE TABLE IF NOT EXISTS vendor_bills (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_no      TEXT,
  bdate        TEXT NOT NULL,
  vendor_id    INTEGER REFERENCES vendors(id),
  building_id  INTEGER REFERENCES buildings(id),
  flat_id      INTEGER REFERENCES flats(id),
  expense_code TEXT NOT NULL REFERENCES accounts(code),
  description  TEXT,
  amount       REAL NOT NULL,
  vat_amount   REAL NOT NULL DEFAULT 0,
  total        REAL NOT NULL,
  paid_amount  REAL NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'unpaid',   -- unpaid | partial | paid
  journal_id   INTEGER REFERENCES journals(id),
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vendor_payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_no  TEXT,
  pdate       TEXT NOT NULL,
  vendor_id   INTEGER REFERENCES vendors(id),
  amount      REAL NOT NULL,
  method      TEXT DEFAULT 'bank',
  cash_account TEXT DEFAULT '10400',
  bank_id     INTEGER REFERENCES banks(id),
  cheque_no   TEXT, cheque_due TEXT, cheque_status TEXT,
  memo        TEXT,
  journal_id  INTEGER REFERENCES journals(id),
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vendor_payment_allocations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES vendor_payments(id) ON DELETE CASCADE,
  bill_id    INTEGER NOT NULL REFERENCES vendor_bills(id),
  amount     REAL NOT NULL
);

-- ---------- Employees & payroll -------------------------------------------
CREATE TABLE IF NOT EXISTS employees (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL, name_ar TEXT,
  job_title TEXT,
  salary    REAL NOT NULL DEFAULT 0,
  active    INTEGER NOT NULL DEFAULT 1,
  notes     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payroll_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  period      TEXT NOT NULL,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  amount      REAL NOT NULL,
  paid        INTEGER NOT NULL DEFAULT 0,
  journal_id  INTEGER REFERENCES journals(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(period, employee_id)
);

-- ---------- Cheques register ----------------------------------------------
CREATE TABLE IF NOT EXISTS cheques (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  direction   TEXT NOT NULL,           -- incoming | outgoing
  cheque_no   TEXT,
  bank_id     INTEGER REFERENCES banks(id),
  party       TEXT,
  amount      REAL NOT NULL,
  issue_date  TEXT,
  due_date    TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | cleared | bounced | cancelled
  source_table TEXT, source_id INTEGER,
  journal_id  INTEGER REFERENCES journals(id)
);

-- ---------- Fixed assets + depreciation -----------------------------------
CREATE TABLE IF NOT EXISTS assets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT,
  name          TEXT NOT NULL, name_ar TEXT,
  building_id   INTEGER REFERENCES buildings(id),
  category      TEXT,                       -- building | furniture | equipment | vehicle
  cost          REAL NOT NULL DEFAULT 0,
  salvage_value REAL NOT NULL DEFAULT 0,
  life_years    REAL NOT NULL DEFAULT 5,
  purchase_date TEXT,
  accum_depreciation REAL NOT NULL DEFAULT 0,
  asset_account TEXT DEFAULT '15500',        -- asset GL
  expense_account TEXT DEFAULT '71000',      -- depreciation expense
  accum_account TEXT DEFAULT '17500',        -- accumulated depreciation
  status        TEXT NOT NULL DEFAULT 'active', -- active | disposed
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS depreciation_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id   INTEGER NOT NULL REFERENCES assets(id),
  period     TEXT NOT NULL,
  amount     REAL NOT NULL,
  journal_id INTEGER REFERENCES journals(id),
  UNIQUE(asset_id, period)
);

-- ---------- Bank reconciliation -------------------------------------------
CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_id      INTEGER REFERENCES banks(id),
  bank_account TEXT,
  txn_date     TEXT NOT NULL,
  description  TEXT,
  debit        REAL DEFAULT 0,         -- money out of bank
  credit       REAL DEFAULT 0,         -- money into bank
  reconciled   INTEGER NOT NULL DEFAULT 0,
  journal_line_id INTEGER REFERENCES journal_lines(id)
);
