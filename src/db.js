const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.UT_DB || path.join(DATA_DIR, 'app.db');
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
}

module.exports = { db, init, DB_PATH };
