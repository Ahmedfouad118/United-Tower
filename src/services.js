// ==========================================================================
// Real-estate ERP services — deferred-revenue accounting engine.
//   Issue invoice   : Dr Tenant Receivable / Cr Deferred Revenue (+ Cr VAT)
//   Recognize (mth) : Dr Deferred Revenue  / Cr Realized Rent Income
//   Collect receipt : Dr Bank/Cash         / Cr Tenant Receivable (advance -> Customer Advance)
//   Vendor bill     : Dr Expense (+Input VAT) / Cr Accounts Payable
//   Vendor payment  : Dr Accounts Payable   / Cr Bank
// Every posting carries building_id + flat_id analytic dimensions.
// ==========================================================================
const { db } = require('./db');
const { postJournal, deleteJournal, r2, ACC } = require('./ledger');
const CFG = require('./config');

const CUSTOMER_ADVANCE = '21500';   // legacy customer advances (kept as-is)
const DEFERRED_ADVANCE = '23100';   // NEW prepaid rent / advances land here
const ADV_ACCOUNTS = [DEFERRED_ADVANCE, CUSTOMER_ADVANCE]; // consume 23100 first
const TENANT_RECV_ACCS = ['11000', '11100'];

const firstOfMonth = (period) => `${period}-01`;
const currentMonth = () => new Date().toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);
const periodOf = (d) => String(d).slice(0, 7);
const addMonths = (period, n) => {
  let [y, m] = period.split('-').map(Number);
  m += n; y += Math.floor((m - 1) / 12); m = ((m - 1) % 12 + 12) % 12 + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
};
const nextInvoiceNo = () => {
  const n = (db.prepare('SELECT COUNT(*) c FROM invoices').get().c) + 1;
  return 'INV-' + String(n).padStart(6, '0');
};
const nextVoucher = (prefix, table) => {
  const n = (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c) + 1;
  return prefix + '-' + String(n).padStart(6, '0');
};

// advance held in a specific account (credit-debit) for a tenant
function advanceBalanceIn(code, tenant_id) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(l.credit),0)-COALESCE(SUM(l.debit),0) bal
     FROM journal_lines l WHERE l.account_code=? AND l.tenant_id=?`).get(code, tenant_id);
  return r2(row.bal);
}
// total advance across BOTH advance accounts (old 21500 + new 23100)
function tenantAdvanceBalance(tenant_id) {
  return r2(ADV_ACCOUNTS.reduce((s, code) => s + advanceBalanceIn(code, tenant_id), 0));
}
// net receivable owed by a tenant (opening balance + all invoices), in 11000/11100
function tenantReceivableBalance(tenant_id) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(l.debit),0)-COALESCE(SUM(l.credit),0) bal
     FROM journal_lines l WHERE l.account_code IN (${TENANT_RECV_ACCS.map(() => '?').join(',')}) AND l.tenant_id=?`)
    .get(...TENANT_RECV_ACCS, tenant_id);
  return r2(row.bal);
}

// ---- Issue a monthly rent invoice (deferred revenue) ----------------------
// Pro-rate the FIRST and LAST (partial) month by days — effective from Apr 2026
// (Q1 2026 is closed). Grace: entry on day 1-3 counts as a full month. Middle
// months are always full. Rule: rent × (daysInMonth − entryDay) / daysInMonth
// for the first month; rent × endDay / daysInMonth for the last month.
// Exported so any report checking invoices against their contract reuses the
// exact same rule the generator applied, instead of re-deriving it and drifting.
const PRORATE_FROM = '2026-04';
// From Sep 2026 a contract that starts or ends around the middle of the month (day 13–17)
// is charged exactly half a month instead of a day-count share.
const HALF_MONTH_FROM = '2026-09';
const isMidMonth = (period, day) => period >= HALF_MONTH_FROM && day >= 13 && day <= 17;
function expectedRentForPeriod(contract, period) {
  let rent = r2(contract.monthly_rent);
  if (period >= PRORATE_FROM && contract.start_date && contract.end_date) {
    const startP = periodOf(contract.start_date), endP = periodOf(contract.end_date);
    const dim = (p) => new Date(Number(p.slice(0, 4)), Number(p.slice(5, 7)), 0).getDate();
    const sd = Number(contract.start_date.slice(8, 10)), ed = Number(contract.end_date.slice(8, 10));
    const d = dim(period), base = r2(contract.monthly_rent);
    if (period === startP && period === endP) {          // short contract within one month
      const days = Math.max(0, Math.min(d, ed) - (sd > 3 ? sd : 0));
      rent = r2(base * days / d);
    } else if (period === startP && sd > 3) {             // first (partial) month
      rent = isMidMonth(period, sd) ? r2(base / 2) : r2(base * (d - sd) / d);
    } else if (period === endP && ed < d) {               // last (partial) month
      rent = isMidMonth(period, ed) ? r2(base / 2) : r2(base * ed / d);
    }
  }
  return rent;
}

function issueInvoiceForContract(contract, period, created_by, opts = {}) {
  const existing = db.prepare('SELECT id FROM invoices WHERE contract_id=? AND period=?').get(contract.id, period);
  if (existing) return { skipped: true, reason: 'exists', id: existing.id };
  // one invoice per UNIT per month — prevents double billing when a contract is
  // renewed and the old + new contracts overlap within the same month.
  if (contract.flat_id) {
    const dup = db.prepare("SELECT id FROM invoices WHERE flat_id=? AND period=? AND status!='cancelled'").get(contract.flat_id, period);
    if (dup) return { skipped: true, reason: 'unit-period-exists', id: dup.id };
  }

  const start = periodOf(contract.start_date), end = periodOf(contract.end_date);
  if (period < start || period > end) return { skipped: true, reason: 'out-of-window' };
  if ((contract.status === 'terminated' || contract.status === 'vacated')) {
    const cut = contract.terminated_on ? periodOf(contract.terminated_on) : end;
    if (period > cut) return { skipped: true, reason: 'after-termination' };
  }

  const rent = expectedRentForPeriod(contract, period);
  const vat = r2((rent * (contract.vat_percent || 0)) / 100);
  const total = r2(rent + vat);
  const invNo = nextInvoiceNo();
  const due = firstOfMonth(period);

  // Narration: "إيجار {الشهر} - وحدة {رقم} - {اسم العميل}"
  const tName = (db.prepare('SELECT name FROM tenants WHERE id=?').get(contract.tenant_id) || {}).name || '';
  const fCode = contract.flat_id ? ((db.prepare('SELECT code FROM flats WHERE id=?').get(contract.flat_id) || {}).code || '') : '';
  const narr = `إيجار ${period}${fCode ? ' - وحدة ' + fCode : ''}${tName ? ' - ' + tName : ''}`;

  // Simple accrual: the invoice IS the accrual entry (Dr Receivable / Cr Rental
  // Income + VAT). No separate deferred/recognition step. Collection settles it.
  const jid = postJournal(
    { jdate: due, jtype: 'invoice', reference: invNo, memo: `Rent accrual ${period}`,
      memo_ar: narr, source_table: 'invoices', created_by },
    [
      { account_code: ACC.TENANT_RECV, debit: total, building_id: contract.building_id, flat_id: contract.flat_id, tenant_id: contract.tenant_id, memo: narr },
      { account_code: ACC.RENT_INCOME, credit: rent, building_id: contract.building_id, flat_id: contract.flat_id, tenant_id: contract.tenant_id },
      ...(vat > 0 ? [{ account_code: CFG.acct('output_vat'), credit: vat, tenant_id: contract.tenant_id, memo: 'VAT 5%' }] : []),
    ]
  );

  const res = db.prepare(
    `INSERT INTO invoices (invoice_no,contract_id,building_id,flat_id,tenant_id,period,idate,due_date,
      rent_amount,service_amount,vat_amount,total,recognized_amount,status,issue_journal,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(invNo, contract.id, contract.building_id, contract.flat_id, contract.tenant_id, period, due, due,
      rent, 0, vat, total, rent, 'issued', jid, created_by || null);
  const invId = Number(res.lastInsertRowid);
  db.prepare('UPDATE journals SET source_id=? WHERE id=?').run(invId, jid);

  if (!opts.skipAdvance) applyAdvanceToInvoice(invId, created_by);
  return { id: invId, invoice_no: invNo, journal_id: jid, total };
}

// Ad-hoc invoice (no contract) — used by Excel import of historical invoices.
function issueAdHocInvoice({ tenant_id, flat_id, building_id, period, rent, vat_percent = 0 }, created_by) {
  const r = r2(rent), vat = r2((r * (vat_percent || 0)) / 100), total = r2(r + vat);
  const invNo = nextInvoiceNo();
  const due = firstOfMonth(period || currentMonth());
  const tName = (db.prepare('SELECT name FROM tenants WHERE id=?').get(tenant_id) || {}).name || '';
  const fCode = flat_id ? ((db.prepare('SELECT code FROM flats WHERE id=?').get(flat_id) || {}).code || '') : '';
  const narr = `إيجار ${period}${fCode ? ' - وحدة ' + fCode : ''}${tName ? ' - ' + tName : ''}`;
  const jid = postJournal(
    { jdate: due, jtype: 'invoice', reference: invNo, memo: `Rent accrual ${period}`, memo_ar: narr, source_table: 'invoices', created_by },
    [
      { account_code: ACC.TENANT_RECV, debit: total, building_id, flat_id, tenant_id, memo: narr },
      { account_code: ACC.RENT_INCOME, credit: r, building_id, flat_id, tenant_id },
      ...(vat > 0 ? [{ account_code: CFG.acct('output_vat'), credit: vat, tenant_id, memo: 'VAT' }] : []),
    ]);
  const res = db.prepare(`INSERT INTO invoices (invoice_no,building_id,flat_id,tenant_id,period,idate,due_date,rent_amount,vat_amount,total,recognized_amount,status,issue_journal,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(invNo, building_id || null, flat_id || null, tenant_id, period, due, due, r, vat, total, r, 'issued', jid, created_by || null);
  const invId = Number(res.lastInsertRowid);
  db.prepare('UPDATE journals SET source_id=? WHERE id=?').run(invId, jid);
  applyAdvanceToInvoice(invId, created_by);
  return { id: invId };
}

// Customer opening balance -> a tenant-tagged receivable so it appears in the
// customer statement and receivables. Positive = customer owes us.
function setTenantOpening(tenant_id, amount, created_by) {
  amount = r2(amount || 0);
  try { db.prepare("INSERT OR IGNORE INTO accounts (code,name,name_ar,type,normal_balance) VALUES ('39999','Opening Balance Equity','حقوق ملكية افتتاحية','equity','C')").run(); } catch {}
  const ref = 'OB-CUST-' + tenant_id;
  const ex = db.prepare("SELECT id FROM journals WHERE reference=?").get(ref);
  if (ex) deleteJournal(ex.id);
  if (Math.abs(amount) < 0.005) return;
  const date = (db.prepare("SELECT value FROM settings WHERE key='opening_date'").get() || {}).value || '2025-12-31';
  const tName = (db.prepare('SELECT name FROM tenants WHERE id=?').get(tenant_id) || {}).name || '';
  const narr = `رصيد افتتاحي${tName ? ' - ' + tName : ''}`;
  // Positive = customer owes us -> Receivable (11100). Negative = customer holds
  // a credit with us -> a prepaid/advance in 23100 on its own (NOT a negative
  // receivable), so it never nets against other debit balances.
  const lines = amount > 0
    ? [{ account_code: ACC.TENANT_RECV, debit: amount, tenant_id, memo: narr }, { account_code: '39999', credit: amount, memo: narr }]
    : [{ account_code: '39999', debit: -amount, memo: narr }, { account_code: DEFERRED_ADVANCE, credit: -amount, tenant_id, memo: `رصيد افتتاحي دائن (دفعة مقدمة)${tName ? ' - ' + tName : ''}` }];
  postJournal({ jdate: date, jtype: 'opening', reference: ref, memo: 'Customer opening balance', memo_ar: narr, source_table: 'tenants', source_id: tenant_id, created_by }, lines);
}

// Vendor opening balance -> a vendor-tagged payable (Cr AP / Dr Opening Equity)
// Positive = we owe the vendor. Mirrors setTenantOpening for customers.
function setVendorOpening(vendor_id, amount, created_by) {
  amount = r2(amount || 0);
  try { db.prepare("INSERT OR IGNORE INTO accounts (code,name,name_ar,type,normal_balance) VALUES ('39999','Opening Balance Equity','حقوق ملكية افتتاحية','equity','C')").run(); } catch {}
  const ref = 'OB-VEND-' + vendor_id;
  const ex = db.prepare("SELECT id FROM journals WHERE reference=?").get(ref);
  if (ex) deleteJournal(ex.id);
  if (Math.abs(amount) < 0.005) return;
  const date = (db.prepare("SELECT value FROM settings WHERE key='opening_date'").get() || {}).value || '2025-12-31';
  const vpAcc = CFG.acct('vendor_payable');   // 23000 by config (كان 20000)
  const vName = (db.prepare('SELECT name FROM vendors WHERE id=?').get(vendor_id) || {}).name || '';
  const narr = `رصيد افتتاحي مورد${vName ? ' - ' + vName : ''}`;
  const lines = amount > 0
    ? [{ account_code: '39999', debit: amount, memo: narr }, { account_code: vpAcc, credit: amount, vendor_id, memo: narr }]
    : [{ account_code: vpAcc, debit: -amount, vendor_id, memo: `رصيد افتتاحي مورد مدين${vName ? ' - ' + vName : ''}` }, { account_code: '39999', credit: -amount, memo: narr }];
  postJournal({ jdate: date, jtype: 'opening', reference: ref, memo: 'Vendor opening balance', memo_ar: narr, source_table: 'vendors', source_id: vendor_id, created_by }, lines);
}

function issueInvoicesForPeriod(period, created_by, opts = {}) {
  const contracts = db.prepare("SELECT * FROM contracts").all();
  const noAdv = new Set(opts.skipAdvanceContracts || []);
  let created = 0, skipped = 0;
  for (const c of contracts) {
    const r = issueInvoiceForContract(c, period, created_by, { skipAdvance: noAdv.has(c.id) });
    if (r.skipped) skipped++; else created++;
  }
  return { period, created, skipped };
}

function backfillInvoices(contract, fromPeriod, toPeriod, created_by) {
  let p = fromPeriod || periodOf(contract.start_date);
  let n = 0;
  while (p <= toPeriod) {
    const r = issueInvoiceForContract(contract, p, created_by);
    if (!r.skipped) n++;
    p = addMonths(p, 1);
  }
  return n;
}

// Recognize deferred rent -> realized income (called when the month arrives)
function recognizeInvoice(invId, created_by) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(invId);
  if (!inv) return;
  const toRecognize = r2(inv.rent_amount - inv.recognized_amount);
  if (toRecognize <= 0) return;
  const jid = postJournal(
    { jdate: firstOfMonth(inv.period), jtype: 'recognition', reference: `REC-${inv.invoice_no}`,
      memo: `Revenue recognition ${inv.period}`, memo_ar: `تحقق إيراد ${inv.period}`,
      source_table: 'invoices', source_id: invId, created_by },
    [
      { account_code: ACC.DEFERRED_REV, debit: toRecognize, building_id: inv.building_id, flat_id: inv.flat_id, tenant_id: inv.tenant_id },
      { account_code: ACC.RENT_INCOME, credit: toRecognize, building_id: inv.building_id, flat_id: inv.flat_id, tenant_id: inv.tenant_id },
    ]
  );
  db.prepare('UPDATE invoices SET recognized_amount=?, recog_journal=? WHERE id=?').run(inv.rent_amount, jid, invId);
}

function recognizeRevenueForPeriod(period, created_by) {
  const rows = db.prepare("SELECT id FROM invoices WHERE period<=? AND recognized_amount < rent_amount AND status!='cancelled'").all(period);
  for (const r of rows) recognizeInvoice(r.id, created_by);
  return { period, recognized: rows.length };
}

// Consume a tenant's prepaid advance to settle a freshly-issued invoice
function applyAdvanceToInvoice(invId, created_by) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(invId);
  if (!inv || inv.status === 'paid') return;
  const remaining = r2(inv.total - inv.paid_amount);
  if (remaining <= 0) return;
  const adv = tenantAdvanceBalance(inv.tenant_id);
  if (adv <= 0) return;
  const apply = r2(Math.min(adv, remaining));
  // consume the advance from 23100 first, then any legacy 21500 balance
  const from23 = r2(Math.min(advanceBalanceIn(DEFERRED_ADVANCE, inv.tenant_id), apply));
  const from21 = r2(apply - from23);
  const advLines = [];
  if (from23 > 0) advLines.push({ account_code: DEFERRED_ADVANCE, debit: from23, tenant_id: inv.tenant_id, flat_id: inv.flat_id || null });
  if (from21 > 0) advLines.push({ account_code: CUSTOMER_ADVANCE, debit: from21, tenant_id: inv.tenant_id, flat_id: inv.flat_id || null });
  const jid = postJournal(
    { jdate: inv.due_date, jtype: 'adjustment', reference: `ADV-${inv.invoice_no}`,
      memo: `Apply advance to ${inv.period}`, memo_ar: `استخدام دفعة مقدمة ${inv.period}`,
      source_table: 'invoices', source_id: invId, created_by },
    [
      ...advLines,
      { account_code: ACC.TENANT_RECV, credit: apply, tenant_id: inv.tenant_id, building_id: inv.building_id, flat_id: inv.flat_id },
    ]
  );
  const paid = r2(inv.paid_amount + apply);
  db.prepare('UPDATE invoices SET paid_amount=?, status=? WHERE id=?')
    .run(paid, paid >= inv.total - 0.005 ? 'paid' : 'partial', invId);
}

// ---- Receipt (سند قبض) ----------------------------------------------------
function recordPayment(input, created_by) {
  const { pdate, tenant_id, building_id, flat_id, contract_id, amount, method = 'bank',
    cash_account = '10400', bank_id, cheque_no, cheque_due, cheque_status, memo, method_id } = input;
  const total = r2(amount);
  if (total <= 0) throw new Error('Amount must be positive');
  // A receipt tagged with a unit must belong to a tenant who actually holds that
  // unit under a currently active contract — otherwise the unit shown on the
  // customer's statement is misleading (money stays on the tenant either way,
  // since allocation is tenant-based, but the unit tag itself must be real).
  if (flat_id) {
    const active = db.prepare("SELECT 1 FROM contracts WHERE tenant_id=? AND flat_id=? AND status='active'").get(tenant_id, flat_id);
    if (!active) throw new Error('لا يوجد عقد ساري لهذا العميل على هذه الوحدة — راجع الوحدة أو اسم العميل');
  }

  let invoices = db.prepare(
    `SELECT * FROM invoices WHERE tenant_id=? ${contract_id ? 'AND contract_id=?' : ''}
       AND status NOT IN ('paid','cancelled') ORDER BY due_date ASC`)
    .all(...(contract_id ? [tenant_id, contract_id] : [tenant_id]));
  // invoice_ids: settle exactly these invoices (in this order) instead of oldest-first
  const explicit = Array.isArray(input.invoice_ids) && input.invoice_ids.length;
  if (explicit) {
    const byId = new Map(invoices.map((i) => [i.id, i]));
    invoices = input.invoice_ids.map((id) => byId.get(Number(id))).filter(Boolean);
  }

  // Settle the OLD debt first: the opening/other receivable that isn't tied to an
  // invoice (dated before any invoice) is the oldest, so it gets paid before the
  // current-month invoices. Any excess beyond total owed becomes a prepaid advance.
  const invoiceDue = r2(invoices.reduce((s, inv) => s + Math.max(0, r2(inv.total - inv.paid_amount)), 0));
  const netReceivable = tenantReceivableBalance(tenant_id);
  const openingDue = explicit ? 0 : r2(Math.max(0, r2(netReceivable - invoiceDue))); // opening balance / misc — oldest

  let left = total;
  const toOpening = r2(Math.min(left, openingDue)); // pay down the old balance first
  left = r2(left - toOpening);
  const allocs = [];
  for (const inv of invoices) {              // then the current invoices, oldest-first
    if (left <= 0) break;
    const need = r2(inv.total - inv.paid_amount);
    if (need <= 0) continue;
    const take = r2(Math.min(need, left));
    allocs.push({ inv, amount: take }); left = r2(left - take);
  }
  const applied = r2(total - left);   // total that reduces the receivable (11100)
  const advance = r2(left);           // excess -> prepaid rent (23100)
  const vno = input.voucher_no || nextVoucher('RCV', 'payments');

  const pay = db.prepare(
    `INSERT INTO payments (voucher_no,pdate,tenant_id,building_id,flat_id,contract_id,amount,applied_amount,advance_amount,
      method_id,method,cash_account,bank_id,cheque_no,cheque_due,cheque_status,memo,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(vno, pdate, tenant_id, building_id || null, flat_id || null, contract_id || null, total, applied, advance,
      method_id || null, method, cash_account, bank_id || null, cheque_no || null, cheque_due || null,
      method === 'cheque' ? (cheque_status || 'pending') : null, memo || null, created_by || null);
  const payId = Number(pay.lastInsertRowid);

  const insAlloc = db.prepare('INSERT INTO payment_allocations (payment_id,invoice_id,amount) VALUES (?,?,?)');
  for (const al of allocs) {
    insAlloc.run(payId, al.inv.id, al.amount);
    const paid = r2(al.inv.paid_amount + al.amount);
    db.prepare('UPDATE invoices SET paid_amount=?, status=? WHERE id=?')
      .run(paid, paid >= al.inv.total - 0.005 ? 'paid' : 'partial', al.inv.id);
  }

  // Descriptive narration: "قبض من {عميل} - وحدة {رقم} - {الشهور المسددة}"
  const tName = (db.prepare('SELECT name FROM tenants WHERE id=?').get(tenant_id) || {}).name || '';
  const fCode = flat_id ? ((db.prepare('SELECT code FROM flats WHERE id=?').get(flat_id) || {}).code || '') : '';
  const periods = [...new Set(allocs.map((a) => a.inv.period).filter(Boolean))].join('، ');
  const monthsTxt = periods || (advance > 0 ? 'دفعة مقدمة' : periodOf(pdate));
  const narr = `قبض من ${tName}${fCode ? ' - وحدة ' + fCode : ''} - ${monthsTxt}`;

  const lines = [{ account_code: cash_account, debit: total, tenant_id, building_id: building_id || null, flat_id: flat_id || null,
    memo: (method === 'cheque' ? `شيك ${cheque_no || ''} — ` : '') + narr }];
  if (applied > 0) lines.push({ account_code: ACC.TENANT_RECV, credit: applied, tenant_id, building_id: building_id || null, flat_id: flat_id || null, memo: `سداد ${tName}${fCode ? ' - وحدة ' + fCode : ''}${periods ? ' - ' + periods : ''}` });
  if (advance > 0) lines.push({ account_code: DEFERRED_ADVANCE, credit: advance, tenant_id, flat_id: flat_id || null, memo: `دفعة مقدمة ${tName}${fCode ? ' - وحدة ' + fCode : ''}` });

  const jid = postJournal(
    { jdate: pdate, jtype: 'receipt', reference: vno, memo: memo || narr,
      memo_ar: narr, source_table: 'payments', source_id: payId, created_by }, lines);
  db.prepare('UPDATE payments SET journal_id=? WHERE id=?').run(jid, payId);

  if (method === 'cheque' && cheque_no) {
    db.prepare(`INSERT INTO cheques (direction,cheque_no,bank_id,party,amount,issue_date,due_date,status,source_table,source_id,journal_id)
      VALUES ('incoming',?,?,?,?,?,?,?, 'payments',?,?)`)
      .run(cheque_no, bank_id || null, String(tenant_id), total, pdate, cheque_due || null, cheque_status || 'pending', payId, jid);
  }
  return { id: payId, voucher_no: vno, applied, advance, journal_id: jid };
}

function deletePayment(payId) {
  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(payId);
  if (!p) return;
  for (const al of db.prepare('SELECT * FROM payment_allocations WHERE payment_id=?').all(payId)) {
    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(al.invoice_id);
    if (inv) {
      const paid = r2(inv.paid_amount - al.amount);
      db.prepare('UPDATE invoices SET paid_amount=?, status=? WHERE id=?')
        .run(paid, paid <= 0.005 ? 'issued' : 'partial', inv.id);
    }
  }
  db.prepare('DELETE FROM payment_allocations WHERE payment_id=?').run(payId);
  db.prepare('DELETE FROM cheques WHERE source_table=? AND source_id=?').run('payments', payId);
  deleteJournal(p.journal_id);
  db.prepare('DELETE FROM payments WHERE id=?').run(payId);
}

// ---- Security deposit -----------------------------------------------------
function recordDeposit(contract, created_by) {
  if (!contract.deposit || contract.deposit <= 0) return null;
  const jid = postJournal(
    { jdate: contract.start_date, jtype: 'deposit', reference: `DEP-${contract.id}`,
      memo: 'Security deposit received', memo_ar: 'تأمين مستلم', source_table: 'contracts', source_id: contract.id, created_by },
    [
      { account_code: ACC.BANK_MAIN, debit: r2(contract.deposit), tenant_id: contract.tenant_id, building_id: contract.building_id, flat_id: contract.flat_id },
      { account_code: ACC.DEPOSITS_HELD, credit: r2(contract.deposit), tenant_id: contract.tenant_id, building_id: contract.building_id, flat_id: contract.flat_id },
    ]);
  db.prepare('UPDATE contracts SET deposit_journal=? WHERE id=?').run(jid, contract.id);
  return jid;
}

// ---- Vendor bill (Dr expense / Cr AP) -------------------------------------
function recordVendorBill(input, created_by) {
  const { bdate, vendor_id, building_id, flat_id, expense_code, description, amount, vat_amount = 0, paid = 0, pay_account, attachment } = input;
  const amt = r2(amount), vat = r2(vat_amount), total = r2(amt + vat);
  const billNo = input.bill_no || nextVoucher('BILL', 'vendor_bills');
  const res = db.prepare(
    `INSERT INTO vendor_bills (bill_no,bdate,vendor_id,building_id,flat_id,expense_code,description,amount,vat_amount,total,paid_amount,status,attachment,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(billNo, bdate, vendor_id || null, building_id || null, flat_id || null, expense_code, description || null,
      amt, vat, total, paid ? total : 0, paid ? 'paid' : 'unpaid', attachment || null, created_by || null);
  const bid = Number(res.lastInsertRowid);
  const credit = paid ? (pay_account || CFG.acct('bank')) : CFG.acct('vendor_payable');
  const jid = postJournal(
    { jdate: bdate, jtype: 'expense', reference: billNo, memo: description || 'Vendor bill',
      memo_ar: 'فاتورة مورد', source_table: 'vendor_bills', source_id: bid, created_by },
    [
      { account_code: expense_code, debit: amt, vendor_id: vendor_id || null, building_id: building_id || null, flat_id: flat_id || null, memo: description || 'Expense' },
      ...(vat > 0 ? [{ account_code: CFG.acct('input_vat'), debit: vat, vendor_id: vendor_id || null, memo: 'Input VAT' }] : []),
      { account_code: credit, credit: total, vendor_id: vendor_id || null, memo: paid ? 'Paid' : 'Payable' },
    ]);
  db.prepare('UPDATE vendor_bills SET journal_id=? WHERE id=?').run(jid, bid);
  return { id: bid, bill_no: billNo, journal_id: jid };
}

// Delete a vendor bill (reverses its journal). Blocked if a payment settled it.
function deleteVendorBill(billId) {
  const b = db.prepare('SELECT * FROM vendor_bills WHERE id=?').get(billId);
  if (!b) return;
  const al = db.prepare('SELECT COUNT(*) n FROM vendor_payment_allocations WHERE bill_id=?').get(billId);
  if (al && al.n > 0) throw new Error('لا يمكن حذف/تعديل فاتورة عليها سند صرف — احذف سند الصرف أولاً');
  if (b.journal_id) deleteJournal(b.journal_id);
  db.prepare('DELETE FROM vendor_bills WHERE id=?').run(billId);
}
// Edit = reverse the old bill then re-create with the same bill number.
function updateVendorBill(billId, input, created_by) {
  const b = db.prepare('SELECT * FROM vendor_bills WHERE id=?').get(billId);
  if (!b) throw new Error('Bill not found');
  deleteVendorBill(billId);
  return recordVendorBill({ ...input, bill_no: input.bill_no || b.bill_no }, created_by);
}

// ---- Vendor payment (سند صرف) --------------------------------------------
function recordVendorPayment(input, created_by) {
  const { pdate, vendor_id, amount, method = 'bank', cash_account = '10400', bank_id, cheque_no, cheque_due, memo } = input;
  const total = r2(amount);
  if (total <= 0) throw new Error('Amount must be positive');
  const bills = db.prepare("SELECT * FROM vendor_bills WHERE vendor_id=? AND status!='paid' ORDER BY bdate ASC").all(vendor_id);
  let left = total; const allocs = [];
  for (const b of bills) {
    if (left <= 0) break;
    const need = r2(b.total - b.paid_amount);
    if (need <= 0) continue;
    const take = r2(Math.min(need, left));
    allocs.push({ bill: b, amount: take }); left = r2(left - take);
  }
  const vno = input.voucher_no || nextVoucher('PAY', 'vendor_payments');
  const res = db.prepare(
    `INSERT INTO vendor_payments (voucher_no,pdate,vendor_id,amount,method,cash_account,bank_id,cheque_no,cheque_due,memo,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(vno, pdate, vendor_id, total, method, cash_account, bank_id || null, cheque_no || null, cheque_due || null, memo || null, created_by || null);
  const payId = Number(res.lastInsertRowid);
  const insAlloc = db.prepare('INSERT INTO vendor_payment_allocations (payment_id,bill_id,amount) VALUES (?,?,?)');
  for (const al of allocs) {
    insAlloc.run(payId, al.bill.id, al.amount);
    const paid = r2(al.bill.paid_amount + al.amount);
    db.prepare('UPDATE vendor_bills SET paid_amount=?, status=? WHERE id=?')
      .run(paid, paid >= al.bill.total - 0.005 ? 'paid' : 'partial', al.bill.id);
  }
  const jid = postJournal(
    { jdate: pdate, jtype: 'payment', reference: vno, memo: memo || 'Payment voucher',
      memo_ar: 'سند صرف', source_table: 'vendor_payments', source_id: payId, created_by },
    [
      { account_code: CFG.acct('vendor_payable'), debit: total, vendor_id, memo: 'Settle payable' },
      { account_code: cash_account, credit: total, vendor_id, memo: method === 'cheque' ? `Cheque ${cheque_no || ''}` : 'Payment' },
    ]);
  db.prepare('UPDATE vendor_payments SET journal_id=? WHERE id=?').run(jid, payId);
  if (method === 'cheque' && cheque_no)
    db.prepare(`INSERT INTO cheques (direction,cheque_no,bank_id,party,amount,issue_date,due_date,status,source_table,source_id,journal_id)
      VALUES ('outgoing',?,?,?,?,?,?, 'pending','vendor_payments',?,?)`)
      .run(cheque_no, bank_id || null, String(vendor_id), total, pdate, cheque_due || null, payId, jid);
  return { id: payId, voucher_no: vno, journal_id: jid };
}

// ---- Payroll --------------------------------------------------------------
function runPayroll(period, created_by) {
  const emps = db.prepare('SELECT * FROM employees WHERE active=1').all();
  let n = 0;
  for (const e of emps) {
    if (db.prepare('SELECT id FROM payroll_runs WHERE period=? AND employee_id=?').get(period, e.id)) continue;
    const jid = postJournal(
      { jdate: firstOfMonth(period), jtype: 'expense', reference: `PAY-${period}-${e.id}`,
        memo: `Salary ${e.name} ${period}`, memo_ar: `راتب ${period}`, source_table: 'payroll_runs', created_by },
      [
        { account_code: ACC.SALARIES_EXP, debit: r2(e.salary), memo: `Salary ${e.name}` },
        { account_code: ACC.ACCRUED_EXP, credit: r2(e.salary), memo: 'Salary payable' },
      ]);
    const res = db.prepare('INSERT INTO payroll_runs (period,employee_id,amount,journal_id) VALUES (?,?,?,?)').run(period, e.id, r2(e.salary), jid);
    db.prepare('UPDATE journals SET source_id=? WHERE id=?').run(Number(res.lastInsertRowid), jid);
    n++;
  }
  return { period, posted: n };
}

// ---- Fixed-asset depreciation (straight line) ----------------------------
// Accum-depreciation account defaults to the category's dedicated COA account
// (land/non-depreciable categories are excluded — life_years<=0 = never depreciates).
const CATEGORY_ACCUM_ACCOUNTS = { building: '17500', furniture: '17000', equipment: '17100', vehicle: '17200' };
function runDepreciation(period, created_by) {
  const assets = db.prepare("SELECT * FROM assets WHERE status='active'").all();
  let posted = 0;
  for (const a of assets) {
    if (a.category === 'land' || !a.life_years || a.life_years <= 0) continue; // non-depreciable (e.g. land)
    if (db.prepare('SELECT id FROM depreciation_runs WHERE asset_id=? AND period=?').get(a.id, period)) continue;
    const depreciable = r2(a.cost - a.salvage_value);
    const remaining = r2(depreciable - a.accum_depreciation);
    if (remaining <= 0) continue;
    const monthly = r2(Math.min(remaining, depreciable / (a.life_years * 12)));
    if (monthly <= 0) continue;
    const jid = postJournal(
      { jdate: firstOfMonth(period), jtype: 'expense', reference: `DEP-${a.id}-${period}`,
        memo: `Depreciation ${a.name} ${period}`, memo_ar: `إهلاك ${period}`, source_table: 'depreciation_runs', created_by },
      [
        { account_code: a.expense_account || CFG.acct('depreciation_expense'), debit: monthly, building_id: a.building_id, memo: `Depreciation ${a.name}` },
        { account_code: a.accum_account || CATEGORY_ACCUM_ACCOUNTS[a.category] || '17300', credit: monthly, building_id: a.building_id },
      ]);
    db.prepare('INSERT INTO depreciation_runs (asset_id,period,amount,journal_id) VALUES (?,?,?,?)').run(a.id, period, monthly, jid);
    db.prepare('UPDATE assets SET accum_depreciation=? WHERE id=?').run(r2(a.accum_depreciation + monthly), a.id);
    posted++;
  }
  return { period, posted };
}

// ---- Municipality tax (tax share split out of the rent receivable) --------
// The rent invoice already keeps the tax out of income (it is credited to the
// tax provision, not to 40000), and the real PeachTree GL moves it with a plain
// Dr 11000 / Cr 11100. So the split is a pure receivable reclass — no income
// effect. Each tax month of each unit is tracked in tax_dues; collections are
// settled Dr 11100 / Cr 11000 on the date the money actually came in (derived
// from the payment allocations) so 11000 always equals "tax not yet paid".
//   • "tax last" rule (same as the VAT report): of an invoice's outstanding
//     amount, the tax is the part that stays unpaid until everything else is paid.
const TAX_TABLES = ['tax_dues', 'tax_due_payments'];

function invPaidAsOf(invoiceId, d) {
  const a = db.prepare(`SELECT COALESCE(SUM(al.amount),0) s FROM payment_allocations al JOIN payments p ON p.id=al.payment_id
    WHERE al.invoice_id=? AND p.pdate<=?`).get(invoiceId, d).s;
  const b = db.prepare(`SELECT COALESCE(SUM(l.credit),0) s FROM journal_lines l JOIN journals j ON j.id=l.journal_id
    WHERE j.source_table='invoices' AND j.source_id=? AND j.jtype='adjustment' AND l.account_code='11100' AND j.jdate<=?`).get(invoiceId, d).s;
  return a + b;
}
const invVatPaidAsOf = (inv, d) => r2(inv.vat_amount - Math.min(inv.vat_amount, Math.max(0, inv.total - invPaidAsOf(inv.id, d))));

// One journal (Dr 11000 / Cr 11100) per date covering every unit in `entries`:
// [{flat_id, tenant_id, period, amount, opening?, invoice_id?, base_paid?}]
function postTaxSplit(jdate, entries, memo, created_by) {
  const rows = entries.filter((e) => r2(e.amount) > 0);
  if (!rows.length) return null;
  const byFlat = new Map();
  for (const e of rows) {
    const k = `${e.flat_id}|${e.tenant_id || ''}`;
    const g = byFlat.get(k) || { flat_id: e.flat_id, tenant_id: e.tenant_id || null, amt: 0 };
    g.amt = r2(g.amt + e.amount); byFlat.set(k, g);
  }
  const flatInfo = db.prepare('SELECT code, building_id FROM flats WHERE id=?');
  const lines = [];
  for (const g of byFlat.values()) {
    const f = flatInfo.get(g.flat_id);
    if (!f) throw new Error('Unit not found');
    const narr = `${memo || 'فصل الضريبة عن الإيجار'} — ${String(f.code).trim()}`;
    lines.push({ account_code: '11000', debit: g.amt, building_id: f.building_id, flat_id: g.flat_id, tenant_id: g.tenant_id, memo: narr });
    lines.push({ account_code: '11100', credit: g.amt, building_id: f.building_id, flat_id: g.flat_id, tenant_id: g.tenant_id, memo: narr });
  }
  const total = r2(rows.reduce((s, e) => s + e.amount, 0));
  const jid = postJournal(
    { jdate, jtype: 'adjustment', reference: `TAX-SPLIT-${jdate}`, memo: 'Tax split from rent receivable',
      memo_ar: memo || 'فصل الضريبة عن الإيجار', source_table: 'tax_dues', created_by }, lines);
  const ins = db.prepare('INSERT INTO tax_dues (flat_id,tenant_id,building_id,period,amount,is_opening,invoice_id,base_paid,journal_id) VALUES (?,?,?,?,?,?,?,?,?)');
  for (const e of rows) {
    const f = flatInfo.get(e.flat_id);
    ins.run(e.flat_id, e.tenant_id || null, f.building_id, e.period, r2(e.amount), e.opening ? 1 : 0, e.invoice_id || null, r2(e.base_paid || 0), jid);
  }
  return { journal_id: jid, amount: total, rows: rows.length };
}

// Manual split of a unit's tax for a range of tax months (also used for older,
// pre-invoice tax: opening=true).
function splitTaxFromRent({ jdate, flat_id, tenant_id, items, memo }, created_by) {
  if (!jdate) throw new Error('Date is required');
  const rows = (items || []).map((i) => ({ flat_id, tenant_id, period: String(i.period || ''), amount: r2(i.amount), opening: i.opening }))
    .filter((i) => i.amount > 0);
  if (!rows.length) throw new Error('No tax amounts');
  if (rows.some((i) => !/^\d{4}-\d{2}$/.test(i.period))) throw new Error('period must be YYYY-MM');
  const r = postTaxSplit(jdate, rows, memo, created_by);
  return r;
}

// Split the tax of commercial invoices in a period range that were not split yet.
//   asOf given  → only the part still unpaid on that date (catch-up of a closed period)
//   asOf empty  → the full tax of each invoice, dated on `jdate` or the invoice date
function splitInvoiceTax({ from_period, to_period, jdate, asOf }, created_by) {
  const invs = db.prepare(
    `SELECT i.* FROM invoices i JOIN flats f ON f.id=i.flat_id
     WHERE f.unit_type='Commercial' AND i.status!='cancelled' AND i.vat_amount>0 AND i.period>=? AND i.period<=?
       AND NOT EXISTS (SELECT 1 FROM tax_dues d WHERE d.invoice_id=i.id)
     ORDER BY i.idate, i.id`).all(from_period || '0000-00', to_period || '9999-99');
  const groups = new Map();
  for (const inv of invs) {
    const base = asOf ? invVatPaidAsOf(inv, asOf) : 0;
    const amount = r2(inv.vat_amount - base);
    if (amount <= 0.0005) continue;
    const d = jdate || inv.idate;
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push({ flat_id: inv.flat_id, tenant_id: inv.tenant_id, period: inv.period, amount, invoice_id: inv.id, base_paid: base });
  }
  const out = [];
  for (const [d, entries] of groups) { const r = postTaxSplit(d, entries, null, created_by); if (r) out.push({ jdate: d, ...r }); }
  return { journals: out.length, amount: r2(out.reduce((s, x) => s + x.amount, 0)) };
}

function taxDueRemaining(tenant_id, flat_id, asOfDate) {
  return db.prepare(
    `SELECT d.*, d.amount - COALESCE((SELECT SUM(p.amount) FROM tax_due_payments p WHERE p.due_id=d.id ${asOfDate ? 'AND p.pay_date<=?' : ''}),0) remaining
     FROM tax_dues d WHERE d.tenant_id=? ${flat_id ? 'AND d.flat_id=?' : ''}
     ORDER BY d.period, d.id`).all(...[...(asOfDate ? [asOfDate] : []), tenant_id, ...(flat_id ? [flat_id] : [])]);
}

// Book settlements [{due, date, amount}] as Dr 11100 / Cr 11000, one journal per tenant+date.
function postTaxSettlements(list, created_by, memo) {
  const groups = new Map();
  for (const s of list) { const k = `${s.due.tenant_id}|${s.date}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
  const ins = db.prepare('INSERT INTO tax_due_payments (due_id,pay_date,amount,journal_id) VALUES (?,?,?,?)');
  let n = 0;
  for (const [k, items] of groups) {
    const [tenant, date] = k.split('|');
    const byFlat = new Map();
    for (const s of items) { const g = byFlat.get(s.due.flat_id) || { flat_id: s.due.flat_id, building_id: s.due.building_id, a: 0 }; g.a = r2(g.a + s.amount); byFlat.set(s.due.flat_id, g); }
    const narr = memo || 'تسوية سداد ضريبة ضمن مقبوضات الإيجار';
    const lines = [];
    for (const g of byFlat.values()) {
      lines.push({ account_code: '11100', debit: g.a, building_id: g.building_id, flat_id: g.flat_id, tenant_id: Number(tenant) || null, memo: narr });
      lines.push({ account_code: '11000', credit: g.a, building_id: g.building_id, flat_id: g.flat_id, tenant_id: Number(tenant) || null, memo: narr });
    }
    const jid = postJournal({ jdate: date, jtype: 'adjustment', reference: `TAX-SETTLE-${tenant}-${date}`, memo: narr, memo_ar: narr,
      source_table: 'tax_due_payments', created_by }, lines);
    for (const s of items) ins.run(s.due.id, date, r2(s.amount), jid);
    n++;
  }
  return n;
}

// Derive tax settlements from the real payments, up to `upTo`:
//  • invoice tax: settled by the payments/advances applied to that invoice (tax last)
//  • older tax (opening): settled once the tenant's opening-balance part of 11100
//    (11100 balance − unpaid invoices) drops below what is still owed
function taxAutoSettle({ upTo } = {}, created_by) {
  const end = upTo || today();
  const settled = (dueId) => db.prepare('SELECT COALESCE(SUM(amount),0) s FROM tax_due_payments WHERE due_id=?').get(dueId).s;
  const list = [];
  // 1) invoice-linked dues
  const dues = db.prepare('SELECT * FROM tax_dues WHERE invoice_id IS NOT NULL ORDER BY id').all();
  for (const d of dues) {
    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(d.invoice_id);
    if (!inv) continue;
    const dates = new Set();
    for (const r of db.prepare(`SELECT p.pdate x FROM payment_allocations al JOIN payments p ON p.id=al.payment_id WHERE al.invoice_id=?`).all(inv.id)) dates.add(r.x);
    for (const r of db.prepare(`SELECT j.jdate x FROM journals j WHERE j.source_table='invoices' AND j.source_id=? AND j.jtype='adjustment'`).all(inv.id)) dates.add(r.x);
    let have = settled(d.id);
    for (const dt of [...dates].filter((x) => x <= end).sort()) {
      const cum = Math.min(d.amount, Math.max(0, r2(invVatPaidAsOf(inv, dt) - d.base_paid)));
      if (cum > have + 0.0005) { list.push({ due: d, date: dt, amount: r2(cum - have) }); have = cum; }
    }
  }
  // 2) older (opening) tax per tenant
  const tenants = db.prepare('SELECT DISTINCT tenant_id FROM tax_dues WHERE is_opening=1 AND tenant_id IS NOT NULL').all().map((x) => x.tenant_id);
  for (const t of tenants) {
    const old = db.prepare('SELECT * FROM tax_dues WHERE tenant_id=? AND is_opening=1 ORDER BY period, id').all(t);
    const O = r2(old.reduce((s, d) => s + d.amount, 0));
    const from = db.prepare('SELECT MIN(j.jdate) m FROM tax_dues d JOIN journals j ON j.id=d.journal_id WHERE d.tenant_id=? AND d.is_opening=1').get(t).m;
    const dates = db.prepare(`SELECT DISTINCT j.jdate x FROM journal_lines l JOIN journals j ON j.id=l.journal_id
      WHERE l.account_code='11100' AND l.tenant_id=? AND l.credit>0 AND j.jdate>? AND j.jdate<=?
        AND COALESCE(j.source_table,'') NOT IN ('tax_dues','tax_due_payments') ORDER BY j.jdate`).all(t, from, end).map((x) => x.x);
    const invs = db.prepare("SELECT * FROM invoices WHERE tenant_id=? AND status!='cancelled'").all(t);
    let target = old.reduce((s, d) => s + settled(d.id), 0);
    for (const dt of dates) {
      const ar = db.prepare(`SELECT COALESCE(SUM(l.debit-l.credit),0) b FROM journal_lines l JOIN journals j ON j.id=l.journal_id
        WHERE l.account_code='11100' AND l.tenant_id=? AND j.jdate<=? AND COALESCE(j.source_table,'') NOT IN ('tax_dues','tax_due_payments')`).get(t, dt).b;
      const unpaidInv = invs.filter((i) => i.due_date <= dt).reduce((s, i) => s + Math.max(0, i.total - invPaidAsOf(i.id, dt)), 0);
      const owedOld = Math.min(O, Math.max(0, r2(ar - unpaidInv)));
      const want = r2(O - owedOld);
      if (want > target + 0.0005) {
        let need = r2(want - target);
        for (const d of old) { const room = r2(d.amount - settled(d.id) - list.filter((x) => x.due.id === d.id).reduce((s, x) => s + x.amount, 0)); if (need <= 0 || room <= 0) continue; const a = r2(Math.min(room, need)); list.push({ due: d, date: dt, amount: a }); need = r2(need - a); }
        target = want;
      }
    }
  }
  const journals = postTaxSettlements(list, created_by);
  return { settlements: list.length, journals, amount: r2(list.reduce((s, x) => s + x.amount, 0)) };
}

// Collecting a tenant's tax dues by hand, applied oldest tax-month first.
//   mode 'cash'   — new money received: Dr bank/cash / Cr 11000
//   mode 'settle' — the tenant already paid it inside a rent receipt (sits as a
//                   credit on 11100): Dr 11100 / Cr 11000, no cash movement
function recordTaxPayment({ pdate, tenant_id, flat_id, amount, mode = 'cash', cash_account = '10400', memo }, created_by) {
  let left = r2(amount);
  if (!pdate || !tenant_id) throw new Error('Date and tenant are required');
  if (left <= 0) throw new Error('Amount must be positive');
  const open = taxDueRemaining(tenant_id, flat_id).filter((d) => r2(d.remaining) > 0);
  const owed = r2(open.reduce((s, d) => s + d.remaining, 0));
  if (left > owed + 0.0005) throw new Error(`Amount exceeds the tax owed (${owed})`);
  const alloc = [];
  for (const d of open) { if (left <= 0.0005) break; const a = r2(Math.min(left, d.remaining)); alloc.push({ d, a }); left = r2(left - a); }
  const narr = memo || (mode === 'settle' ? 'تسوية سداد ضريبة ضمن مقبوضات الإيجار' : 'تحصيل ضريبة');
  const debitAcc = mode === 'settle' ? '11100' : cash_account;
  const byFlat = new Map();
  for (const x of alloc) { const k = x.d.flat_id || 0; byFlat.set(k, { flat_id: x.d.flat_id, building_id: x.d.building_id, a: r2((byFlat.get(k) ? byFlat.get(k).a : 0) + x.a) }); }
  const lines = [];
  for (const g of byFlat.values()) {
    lines.push({ account_code: debitAcc, debit: g.a, building_id: g.building_id, flat_id: g.flat_id, tenant_id, memo: narr });
    lines.push({ account_code: '11000', credit: g.a, building_id: g.building_id, flat_id: g.flat_id, tenant_id, memo: narr });
  }
  const jid = postJournal(
    { jdate: pdate, jtype: mode === 'settle' ? 'adjustment' : 'receipt', reference: `TAXRCV-${tenant_id}-${pdate}`,
      memo: narr, memo_ar: narr, source_table: 'tax_due_payments', created_by }, lines);
  const ins = db.prepare('INSERT INTO tax_due_payments (due_id,pay_date,amount,journal_id) VALUES (?,?,?,?)');
  for (const x of alloc) ins.run(x.d.id, pdate, x.a, jid);
  return { journal_id: jid, amount: r2(amount), applied: alloc.length };
}

function deleteTaxPayment(journal_id) {
  db.prepare('DELETE FROM tax_due_payments WHERE journal_id=?').run(journal_id);
  deleteJournal(journal_id);
  return { deleted: journal_id };
}
function deleteTaxSplit(journal_id) {
  const used = db.prepare('SELECT COUNT(*) n FROM tax_due_payments WHERE due_id IN (SELECT id FROM tax_dues WHERE journal_id=?)').get(journal_id).n;
  if (used) throw new Error('Tax payments already applied to this split — delete them first');
  db.prepare('DELETE FROM tax_dues WHERE journal_id=?').run(journal_id);
  deleteJournal(journal_id);
  return { deleted: journal_id };
}

// ---- Contract lifecycle ---------------------------------------------------
function terminateContract(contractId, date, settledAmount, created_by) {
  const c = db.prepare('SELECT * FROM contracts WHERE id=?').get(contractId);
  if (!c) throw new Error('Contract not found');
  db.prepare('UPDATE contracts SET status=?, terminated_on=?, settled_amount=? WHERE id=?')
    .run('terminated', date, settledAmount ?? null, contractId);
  const cut = periodOf(date);
  const future = db.prepare("SELECT * FROM invoices WHERE contract_id=? AND period>? AND status!='paid'").all(contractId, cut);
  for (const inv of future) {
    if (inv.issue_journal) deleteJournal(inv.issue_journal);
    if (inv.recog_journal) deleteJournal(inv.recog_journal);
    db.prepare('UPDATE invoices SET status=?, issue_journal=NULL, recog_journal=NULL WHERE id=?').run('cancelled', inv.id);
  }
  return { terminated: contractId, cancelled: future.length };
}

// ---- VAT settlement (quarterly filing) ------------------------------------
// Output & input VAT share ONE provision account (20000 by config). The net
// balance of that account for the period = what is owed to the authority, and
// settlement clears it to the bank (Dr 20000 / Cr 10400). If output & input are
// two different accounts, it closes each against the bank instead.
function settleVAT(input, created_by) {
  const { from, to } = input;
  const pay_account = input.pay_account || CFG.acct('bank');
  const date = input.pdate || to || today();
  const OUT = CFG.acct('output_vat'), IN = CFG.acct('input_vat');
  const bal = (code) => db.prepare(
    `SELECT COALESCE(SUM(l.debit),0) d, COALESCE(SUM(l.credit),0) c
       FROM journal_lines l JOIN journals j ON j.id=l.journal_id
      WHERE l.account_code=? AND j.jtype!='vat_settlement' ${from ? 'AND j.jdate>=?' : ''} ${to ? 'AND j.jdate<=?' : ''}`)
    .get(...[code, ...(from ? [from] : []), ...(to ? [to] : [])]);
  // Net for the period comes from the LEDGER movement on the output/input VAT
  // account(s) — not just the invoice/vendor-bill documents — so a VAT amount
  // posted via a manual journal entry is still cleared correctly by the settlement.
  let output_vat, input_vat;
  if (OUT === IN) { const b = bal(OUT); output_vat = r2(b.c); input_vat = r2(b.d); }
  else { const o = bal(OUT), i = bal(IN); output_vat = r2(o.c - o.d); input_vat = r2(i.d - i.c); }
  const net = r2(output_vat - input_vat);
  if (Math.abs(net) < 0.005 && Math.abs(output_vat) < 0.005) throw new Error('لا توجد ضريبة للتسوية في هذه الفترة');
  const ref = `VAT-${from || '~'}_${to || '~'}`;
  if (db.prepare('SELECT id FROM journals WHERE reference=?').get(ref)) throw new Error('تم عمل تسوية لهذه الفترة من قبل: ' + ref);
  const lines = [];
  if (OUT === IN) {
    // clear the provision's net balance to the bank
    if (net > 0.005) { lines.push({ account_code: OUT, debit: net, memo: 'تسوية صافي الضريبة' }); lines.push({ account_code: pay_account, credit: net, memo: 'سداد صافي الضريبة للجهاز' }); }
    else if (net < -0.005) { lines.push({ account_code: OUT, credit: -net, memo: 'تسوية صافي الضريبة' }); lines.push({ account_code: pay_account, debit: -net, memo: 'استرداد ضريبة' }); }
  } else {
    if (Math.abs(output_vat) > 0.005) lines.push({ account_code: OUT, debit: output_vat, memo: 'تقفيل ضريبة المخرجات' });
    if (Math.abs(input_vat) > 0.005) lines.push({ account_code: IN, credit: input_vat, memo: 'تقفيل ضريبة المدخلات' });
    if (net > 0.005) lines.push({ account_code: pay_account, credit: net, memo: 'سداد صافي الضريبة للجهاز' });
    else if (net < -0.005) lines.push({ account_code: pay_account, debit: -net, memo: 'استرداد ضريبة' });
  }
  const jid = postJournal(
    { jdate: date, jtype: 'vat_settlement', reference: ref,
      memo: `VAT settlement ${from || ''}..${to || ''}`, memo_ar: `تسوية ضريبة ${from || ''} → ${to || ''}`, created_by },
    lines);
  return { journal_id: jid, reference: ref, output_vat, input_vat, net_payable: net, pay_account, date };
}

// One-time: repurpose 20000 as the single VAT provision. Moves any legacy vendor
// balance out of 20000 into 23000 (per vendor), then reclasses existing output
// (23200) and input (11600) VAT lines into 20000. Idempotent (guarded by a flag).
function migrateVatTo20000(created_by) {
  const done = db.prepare("SELECT value v FROM settings WHERE key='vat_provision_20000'").get();
  if (done && done.v === '1') return { skipped: true };
  db.exec('BEGIN');
  try {
    // 1) move legacy AP balance out of 20000 -> 23000, keeping vendor tags
    const bals = db.prepare("SELECT vendor_id vid, COALESCE(SUM(credit-debit),0) net FROM journal_lines WHERE account_code='20000' GROUP BY vendor_id").all();
    const lines = []; let moved = 0;
    for (const r of bals) {
      const net = r2(r.net); if (Math.abs(net) < 0.005) continue;
      if (net > 0) { lines.push({ account_code: '20000', debit: net, vendor_id: r.vid || null }); lines.push({ account_code: '23000', credit: net, vendor_id: r.vid || null }); }
      else { lines.push({ account_code: '20000', credit: -net, vendor_id: r.vid || null }); lines.push({ account_code: '23000', debit: -net, vendor_id: r.vid || null }); }
      moved = r2(moved + Math.abs(net));
    }
    if (lines.length) postJournal({ jdate: today(), jtype: 'adjustment', reference: 'REPURPOSE-20000-VAT', memo: 'Move legacy AP 20000 -> 23000; 20000 becomes VAT provision', memo_ar: 'نقل أرصدة الموردين من 20000 إلى 23000 (20000 أصبح مخصص ضريبة)', created_by }, lines);
    // 2) reclass existing output/input VAT into 20000 IN PLACE (keeps original dates)
    const u = db.prepare("UPDATE journal_lines SET account_code='20000' WHERE account_code IN ('23200','11600')").run();
    db.prepare("INSERT INTO settings (key,value) VALUES ('vat_provision_20000','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    db.exec('COMMIT');
    return { moved, reclassed: u.changes };
  } catch (e) { try { db.exec('ROLLBACK'); } catch (e2) {} throw e; }
}

module.exports = {
  issueInvoiceForContract, issueInvoicesForPeriod, backfillInvoices, issueAdHocInvoice,
  recognizeInvoice, recognizeRevenueForPeriod,
  recordPayment, deletePayment, recordDeposit,
  recordVendorBill, deleteVendorBill, updateVendorBill, recordVendorPayment, runPayroll, terminateContract, runDepreciation, setTenantOpening, setVendorOpening,
  settleVAT, splitTaxFromRent, splitInvoiceTax, taxAutoSettle, recordTaxPayment, taxDueRemaining, deleteTaxPayment, deleteTaxSplit,
  tenantAdvanceBalance, addMonths, periodOf, firstOfMonth, currentMonth, today,
  CUSTOMER_ADVANCE, expectedRentForPeriod,
};
module.exports.migrateVatTo20000 = migrateVatTo20000;
