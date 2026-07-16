// Excel import endpoints. Accepts .xlsx/.xls, maps flexible column headers,
// upserts tenants/flats/contracts and posts payments/expenses through services.
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { db } = require('./db');
const { authMiddleware, requireRole } = require('./auth');
const svc = require('./services');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = express.Router();
router.use(authMiddleware, requireRole('admin', 'accountant'));

const norm = (s) => String(s == null ? '' : s).trim();
const pick = (row, keys) => {
  for (const k of Object.keys(row)) {
    const kn = k.toLowerCase().trim();
    if (keys.some((want) => kn === want || kn.includes(want))) return row[k];
  }
  return undefined;
};
// Excel serial or string -> YYYY-MM-DD
const toDate = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    const d = XLSX.SSF ? XLSX.SSF.parse_date_code(v) : null;
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = norm(v);
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let [_, a, b, y] = m; if (y.length === 2) y = '20' + y;
    return `${y}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`; // m/d/y
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
};
const num = (v) => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };

function sheetRows(buf) {
  const wb = XLSX.read(buf, { cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}
function upsertTenant(name) {
  name = norm(name); if (!name) return null;
  const ex = db.prepare('SELECT id FROM tenants WHERE name=?').get(name);
  if (ex) return ex.id;
  return Number(db.prepare('INSERT INTO tenants (name) VALUES (?)').run(name).lastInsertRowid);
}
function upsertFlat(code) {
  code = norm(code); if (!code) return null;
  const ex = db.prepare('SELECT id FROM flats WHERE code=?').get(code);
  if (ex) return ex.id;
  return Number(db.prepare('INSERT INTO flats (code) VALUES (?)').run(code).lastInsertRowid);
}

// ---- Preview (dry run) ----------------------------------------------------
router.post('/:type/preview', upload.single('file'), (req, res) => {
  try {
    const rows = sheetRows(req.file.buffer);
    res.json({ count: rows.length, columns: Object.keys(rows[0] || {}), sample: rows.slice(0, 5) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Commit ---------------------------------------------------------------
router.post('/:type', upload.single('file'), (req, res) => {
  const type = req.params.type;
  let rows;
  try { rows = sheetRows(req.file.buffer); } catch (e) { return res.status(400).json({ error: e.message }); }
  const result = { inserted: 0, skipped: 0, errors: [] };
  const backfill = req.body.backfill === 'true' || req.body.backfill === true;

  // ---- Journals: group rows by Ref, post balanced entries ----
  if (type === 'journals') {
    const { postJournal } = require('./ledger');
    const groups = {};
    for (const row of rows) {
      const refv = norm(pick(row, ['ref', 'reference', 'مرجع'])) || ('IMP-' + (toDate(pick(row, ['date'])) || ''));
      (groups[refv] = groups[refv] || []).push(row);
    }
    for (const [refv, grp] of Object.entries(groups)) {
      try {
        const bName = norm(pick(grp[0], ['building', 'بناية']));
        const bid = bName ? db.prepare('SELECT id FROM buildings WHERE name=? OR name_ar=? OR code=?').get(bName, bName, bName)?.id : null;
        const lines = grp.map((r) => ({
          account_code: norm(pick(r, ['account code', 'account', 'كود', 'الحساب'])),
          debit: num(pick(r, ['debit', 'مدين'])), credit: num(pick(r, ['credit', 'دائن'])),
          building_id: bid, memo: norm(pick(r, ['memo', 'بيان'])),
        })).filter((l) => l.account_code && (l.debit || l.credit));
        if (lines.length < 2) { result.skipped++; continue; }
        postJournal({ jdate: toDate(pick(grp[0], ['date', 'تاريخ'])) || new Date().toISOString().slice(0, 10), jtype: 'manual', reference: refv, memo: norm(pick(grp[0], ['memo', 'بيان'])), created_by: req.user.id }, lines);
        result.inserted++;
      } catch (e) { result.errors.push({ ref: refv, error: e.message }); }
    }
    return res.json(result);
  }

  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        if (type === 'tenants') {
          const name = pick(row, ['tenant name', 'tenant', 'name', 'customer', 'اسم']);
          if (!norm(name)) { result.skipped++; continue; }
          upsertTenant(name); result.inserted++;
        } else if (type === 'flats') {
          const code = pick(row, ['u no', 'flat', 'unit', 'f/s', 'code', 'شقة']);
          if (!norm(code)) { result.skipped++; continue; }
          upsertFlat(code); result.inserted++;
        } else if (type === 'contracts') {
          const tenant = pick(row, ['tenant name', 'tenant', 'name', 'اسم']);
          const flat = pick(row, ['u no', 'flat', 'unit', 'f/s', 'شقة']);
          if (!norm(tenant) || !norm(flat)) { result.skipped++; continue; }
          const tid = upsertTenant(tenant), fid = upsertFlat(flat);
          const start = toDate(pick(row, ['per-frm', 'start', 'from', 'بداية']));
          const end = toDate(pick(row, ['per-to', 'end', 'to', 'نهاية']));
          const rent = num(pick(row, ['rent amount', 'rent', 'إيجار']));
          const cno = norm(pick(row, ['agreement no', 'contract no', 'رقم العقد']));
          const remarks = norm(pick(row, ['remarks', 'ملاحظات']));
          const vat = norm(remarks).toUpperCase().includes('VAT') ? 5 : 0;
          const r = db.prepare(
            `INSERT INTO contracts (contract_no,flat_id,tenant_id,start_date,end_date,monthly_rent,vat_percent,remarks)
             VALUES (?,?,?,?,?,?,?,?)`).run(cno || null, fid, tid, start, end, rent, vat, remarks || null);
          if (backfill && start && end) {
            const c = db.prepare('SELECT * FROM contracts WHERE id=?').get(Number(r.lastInsertRowid));
            svc.backfillInvoices(c, null, new Date().toISOString().slice(0, 7), req.user.id);
          }
          result.inserted++;
        } else if (type === 'payments') {
          const tenant = pick(row, ['payee', 'tenant', 'name', 'اسم']);
          const flat = pick(row, ['flat', 'u no', 'unit', 'شقة']);
          const amount = Math.abs(num(pick(row, ['total reverived', 'total received', 'amount', 'مبلغ', 'rental amount'])));
          const date = toDate(pick(row, ['date', 'تاريخ']));
          if (!norm(tenant) || amount <= 0) { result.skipped++; continue; }
          const tid = upsertTenant(tenant), fid = flat ? upsertFlat(flat) : null;
          svc.recordPayment({ pdate: date || new Date().toISOString().slice(0, 10), tenant_id: tid, flat_id: fid, amount, method: 'bank' }, req.user.id);
          result.inserted++;
        } else if (type === 'expenses') {
          const desc = norm(pick(row, ['description', 'memo', 'بيان', 'وصف']));
          const amount = num(pick(row, ['amount', 'debit', 'مبلغ']));
          const date = toDate(pick(row, ['date', 'تاريخ']));
          const code = norm(pick(row, ['account', 'code', 'كود'])) || '89000';
          if (amount <= 0) { result.skipped++; continue; }
          svc.recordVendorBill({ bdate: date || new Date().toISOString().slice(0, 10), expense_code: code, description: desc, amount, paid: 0 }, req.user.id);
          result.inserted++;
        } else if (type === 'vendor-bills') {
          const vName = norm(pick(row, ['vendor', 'مورد']));
          const amount = num(pick(row, ['amount', 'مبلغ']));
          const code = norm(pick(row, ['account code', 'account', 'كود'])) || '89000';
          if (amount <= 0) { result.skipped++; continue; }
          let vid = null;
          if (vName) { const ex = db.prepare('SELECT id FROM vendors WHERE name=?').get(vName); vid = ex ? ex.id : Number(db.prepare('INSERT INTO vendors (name) VALUES (?)').run(vName).lastInsertRowid); }
          const vatp = num(pick(row, ['vat %', 'vat', 'ضريبة']));
          svc.recordVendorBill({ bdate: toDate(pick(row, ['date'])) || new Date().toISOString().slice(0, 10), vendor_id: vid, expense_code: code, description: norm(pick(row, ['description', 'بيان'])), amount, vat_amount: Math.round(amount * vatp) / 100, paid: 0 }, req.user.id);
          result.inserted++;
        } else if (type === 'invoices') {
          const tenant = pick(row, ['tenant', 'name', 'اسم']); const flat = pick(row, ['unit', 'flat', 'u no', 'شقة']);
          const rent = num(pick(row, ['rent', 'إيجار'])); const period = norm(pick(row, ['period', 'شهر'])) || new Date().toISOString().slice(0, 7);
          if (!norm(tenant) || rent <= 0) { result.skipped++; continue; }
          const tid = upsertTenant(tenant); const fid = flat ? upsertFlat(flat) : null;
          const bid = fid ? db.prepare('SELECT building_id FROM flats WHERE id=?').get(fid)?.building_id : null;
          svc.issueAdHocInvoice({ tenant_id: tid, flat_id: fid, building_id: bid, period: period.slice(0, 7), rent, vat_percent: num(pick(row, ['vat %', 'vat'])) }, req.user.id);
          result.inserted++;
        } else if (type === 'journals') {
          // journals handled in bulk after the loop
        } else {
          return res.status(400).json({ error: 'unknown import type' });
        }
      } catch (rowErr) {
        result.errors.push({ row: i + 2, error: rowErr.message });
      }
    }
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
