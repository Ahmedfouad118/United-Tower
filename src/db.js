const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.UT_DB || path.join(DATA_DIR, 'app.db');
// make sure the database directory exists (e.g. /data volume on hosted deploys)
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
console.log('[UT] database file:', DB_PATH);
const db = new DatabaseSync(DB_PATH);

function init() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schema);
  // idempotent column migrations for existing databases
  const migrations = [
    "ALTER TABLE contracts ADD COLUMN contract_type TEXT DEFAULT 'residential'",
    'ALTER TABLE contracts ADD COLUMN attachment TEXT',
    'ALTER TABLE vendor_bills ADD COLUMN attachment TEXT',
  ];
  for (const m of migrations) { try { db.exec(m); } catch (e) { /* column exists */ } }
  migrateBudgetVersions();
}

// budgets.version was added after the table already existed on some databases —
// SQLite can't ALTER a UNIQUE constraint in place, so rebuild the table when the
// column is missing, defaulting every existing row to version=1.
function migrateBudgetVersions() {
  const cols = db.prepare("PRAGMA table_info(budgets)").all();
  if (cols.some((c) => c.name === 'version')) return;
  db.exec(`
    ALTER TABLE budgets RENAME TO budgets_old_v1;
    CREATE TABLE budgets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      building_id INTEGER NOT NULL DEFAULT 0,
      year        INTEGER NOT NULL,
      month       INTEGER NOT NULL,
      account_code TEXT NOT NULL REFERENCES accounts(code),
      amount      REAL NOT NULL DEFAULT 0,
      version     INTEGER NOT NULL DEFAULT 1,
      notes       TEXT,
      updated_by  INTEGER REFERENCES users(id),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(building_id, year, month, account_code, version)
    );
    INSERT INTO budgets (id,building_id,year,month,account_code,amount,version,notes,updated_by,updated_at)
      SELECT id,building_id,year,month,account_code,amount,1,notes,updated_by,updated_at FROM budgets_old_v1;
    DROP TABLE budgets_old_v1;
  `);
}

module.exports = { db, init, DB_PATH };
