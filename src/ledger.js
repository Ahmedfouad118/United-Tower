// ==========================================================================
// Double-entry ledger engine + analytic cost centers (building / unit).
// All monetary events funnel through postJournal() so the books always balance.
// ==========================================================================
const { db } = require('./db');

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000; // OMR = 3 decimals

// Account map (real-estate deferred-revenue model)
const ACC = {
  PETTY_CASH:      '10000',
  BANK_MAIN:       '10400',
  TENANT_RECV:     '11100', // Tenant / Contracts Receivable
  AR:              '11000',
  INPUT_VAT:       '11600',
  AP:              '20000', // Accounts Payable (vendors)
  DEPOSITS_HELD:   '21000', // Security Deposits Held (liability)
  ACCRUED_EXP:     '23000',
  DEFERRED_REV:    '23100', // Deferred / Unearned Rent Revenue (liability)
  VAT_PAYABLE:     '23200', // Output VAT
  RENT_INCOME:     '40000', // Realized Rent Income
  SERVICE_INCOME:  '40500', // Services (parking/laundry/maintenance)
  OTHER_INCOME:    '41000',
  SALARIES_EXP:    '77000',
  MAINT_EXP:       '70000',
  DEPRECIATION:    '71000',
  COMMISSION_EXP:  '65000',
};

/**
 * Post a balanced journal.
 * lines: {account_code,debit?,credit?,building_id?,flat_id?,tenant_id?,vendor_id?,memo?}
 */
function postJournal(head, lines) {
  const clean = lines
    .map((l) => ({
      account_code: String(l.account_code),
      debit: r2(l.debit || 0),
      credit: r2(l.credit || 0),
      building_id: l.building_id || null,
      flat_id: l.flat_id || null,
      tenant_id: l.tenant_id || null,
      vendor_id: l.vendor_id || null,
      memo: l.memo || null,
    }))
    .filter((l) => l.debit !== 0 || l.credit !== 0);

  const totD = r2(clean.reduce((s, l) => s + l.debit, 0));
  const totC = r2(clean.reduce((s, l) => s + l.credit, 0));
  if (clean.length < 2) throw new Error('Journal must have at least 2 lines');
  if (Math.abs(totD - totC) > 0.005)
    throw new Error(`Unbalanced journal: debit ${totD} != credit ${totC}`);

  const j = db
    .prepare(
      `INSERT INTO journals (jdate,jtype,reference,memo,memo_ar,source_table,source_id,created_by)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(head.jdate, head.jtype, head.reference || null, head.memo || null, head.memo_ar || null,
      head.source_table || null, head.source_id || null, head.created_by || null);
  const jid = Number(j.lastInsertRowid);
  const ins = db.prepare(
    `INSERT INTO journal_lines (journal_id,account_code,debit,credit,building_id,flat_id,tenant_id,vendor_id,memo)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  for (const l of clean)
    ins.run(jid, l.account_code, l.debit, l.credit, l.building_id, l.flat_id, l.tenant_id, l.vendor_id, l.memo);
  return jid;
}

function deleteJournal(jid) {
  if (!jid) return;
  db.prepare('DELETE FROM journal_lines WHERE journal_id = ?').run(jid);
  db.prepare('DELETE FROM journals WHERE id = ?').run(jid);
}

function accountBalance(code, upto) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(l.debit),0) d, COALESCE(SUM(l.credit),0) c
       FROM journal_lines l JOIN journals j ON j.id = l.journal_id
       WHERE l.account_code = ? ${upto ? 'AND j.jdate <= ?' : ''}`
    )
    .get(...(upto ? [code, upto] : [code]));
  return { debit: r2(row.d), credit: r2(row.c), balance: r2(row.d - row.c) };
}

module.exports = { postJournal, deleteJournal, accountBalance, r2, ACC };
