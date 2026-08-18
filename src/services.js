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
function issueInvoiceForContract(contract, period, created_by) {
  const existing = db.prepare('SELECT id FROM invoices WHERE contract_id=? AND period=?').get(contract.id, period);
  if (existing) return { skipped: true, reason: 'exists', id: existing.id };

  const start = periodOf(contract.start_date), end = periodOf(contract.end_date);
  if (period < start || period > end) return { skipped: true, reason: 'out-of-window' };
  if ((contract.status === 'terminated' || contract.status === 'vacated')) {
    const cut = contract.terminated_on ? periodOf(contract.terminated_on) : end;
    if (period > cut) return { skipped: true, reason: 'after-termination' };
  }

  const rent = r2(contract.monthly_rent);
  const vat = r2((rent * (contract.vat_percent || 0)) / 100);
  const total = r2(rent + vat);
  const invNo = nextInvoiceNo();
  const due = firstOfMonth(period);

  // Simple accrual: the invoice IS the accrual entry (Dr Receivable / Cr Rental
  // Income + VAT). No separate deferred/recognition step. Collection settles it.
  const jid = postJournal(
    { jdate: due, jtype: 'invoice', reference: invNo, memo: `Rent accrual ${period}`,
      memo_ar: `استحقاق إيجار ${period}`, source_table: 'invoices', created_by },
    [
      { account_code: ACC.TENANT_RECV, debit: total, building_id: contract.building_id, flat_id: contract.flat_id, tenant_id: contract.tenant_id, memo: `Rent ${period}` },
      { account_code: ACC.RENT_INCOME, credit: rent, building_id: contract.building_id, flat_id: contract.flat_id, tenant_id: contract.tenant_id },
      ...(vat > 0 ? [{ account_code: ACC.VAT_PAYABLE, credit: vat, tenant_id: contract.tenant_id, memo: 'VAT 5%' }] : []),
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

  applyAdvanceToInvoice(invId, created_by);
  return { id: invId, invoice_no: invNo, journal_id: jid, total };
}

// Ad-hoc invoice (no contract) — used by Excel import of historical invoices.
function issueAdHocInvoice({ tenant_id, flat_id, building_id, period, rent, vat_percent = 0 }, created_by) {
  const r = r2(rent), vat = r2((r * (vat_percent || 0)) / 100), total = r2(r + vat);
  const invNo = nextInvoiceNo();
  const due = firstOfMonth(period || currentMonth());
  const jid = postJournal(
    { jdate: due, jtype: 'invoice', reference: invNo, memo: `Rent accrual ${period}`, memo_ar: `استحقاق إيجار ${period}`, source_table: 'invoices', created_by },
    [
      { account_code: ACC.TENANT_RECV, debit: total, building_id, flat_id, tenant_id, memo: `Rent ${period}` },
      { account_code: ACC.RENT_INCOME, credit: r, building_id, flat_id, tenant_id },
      ...(vat > 0 ? [{ account_code: ACC.VAT_PAYABLE, credit: vat, tenant_id, memo: 'VAT' }] : []),
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
  // Positive = customer owes us -> Receivable (11100). Negative = customer holds
  // a credit with us -> a prepaid/advance in 23100 on its own (NOT a negative
  // receivable), so it never nets against other debit balances.
  const lines = amount > 0
    ? [{ account_code: ACC.TENANT_RECV, debit: amount, tenant_id, memo: 'رصيد افتتاحي' }, { account_code: '39999', credit: amount }]
    : [{ account_code: '39999', debit: -amount }, { account_code: DEFERRED_ADVANCE, credit: -amount, tenant_id, memo: 'رصيد افتتاحي دائن (دفعة مقدمة)' }];
  postJournal({ jdate: date, jtype: 'opening', reference: ref, memo: 'Customer opening balance', memo_ar: 'رصيد افتتاحي للعميل', source_table: 'tenants', source_id: tenant_id, created_by }, lines);
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
  const lines = amount > 0
    ? [{ account_code: '39999', debit: amount }, { account_code: ACC.AP, credit: amount, vendor_id, memo: 'رصيد افتتاحي مورد' }]
    : [{ account_code: ACC.AP, debit: -amount, vendor_id, memo: 'رصيد افتتاحي مورد مدين' }, { account_code: '39999', credit: -amount }];
  postJournal({ jdate: date, jtype: 'opening', reference: ref, memo: 'Vendor opening balance', memo_ar: 'رصيد افتتاحي للمورد', source_table: 'vendors', source_id: vendor_id, created_by }, lines);
}

function issueInvoicesForPeriod(period, created_by) {
  const contracts = db.prepare("SELECT * FROM contracts").all();
  let created = 0, skipped = 0;
  for (const c of contracts) {
    const r = issueInvoiceForContract(c, period, created_by);
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
  if (from23 > 0) advLines.push({ account_code: DEFERRED_ADVANCE, debit: from23, tenant_id: inv.tenant_id });
  if (from21 > 0) advLines.push({ account_code: CUSTOMER_ADVANCE, debit: from21, tenant_id: inv.tenant_id });
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

  const invoices = db.prepare(
    `SELECT * FROM invoices WHERE tenant_id=? ${contract_id ? 'AND contract_id=?' : ''}
       AND status NOT IN ('paid','cancelled') ORDER BY due_date ASC`)
    .all(...(contract_id ? [tenant_id, contract_id] : [tenant_id]));

  // Settle the OLD debt first: the opening/other receivable that isn't tied to an
  // invoice (dated before any invoice) is the oldest, so it gets paid before the
  // current-month invoices. Any excess beyond total owed becomes a prepaid advance.
  const invoiceDue = r2(invoices.reduce((s, inv) => s + Math.max(0, r2(inv.total - inv.paid_amount)), 0));
  const netReceivable = tenantReceivableBalance(tenant_id);
  const openingDue = r2(Math.max(0, r2(netReceivable - invoiceDue))); // opening balance / misc — oldest

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
  if (advance > 0) lines.push({ account_code: DEFERRED_ADVANCE, credit: advance, tenant_id, memo: `دفعة مقدمة ${tName}${fCode ? ' - وحدة ' + fCode : ''}` });

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
  const credit = paid ? (pay_account || '10400') : ACC.AP;
  const jid = postJournal(
    { jdate: bdate, jtype: 'expense', reference: billNo, memo: description || 'Vendor bill',
      memo_ar: 'فاتورة مورد', source_table: 'vendor_bills', source_id: bid, created_by },
    [
      { account_code: expense_code, debit: amt, vendor_id: vendor_id || null, building_id: building_id || null, flat_id: flat_id || null, memo: description || 'Expense' },
      ...(vat > 0 ? [{ account_code: ACC.INPUT_VAT, debit: vat, memo: 'Input VAT' }] : []),
      { account_code: credit, credit: total, vendor_id: vendor_id || null, memo: paid ? 'Paid' : 'Payable' },
    ]);
  db.prepare('UPDATE vendor_bills SET journal_id=? WHERE id=?').run(jid, bid);
  return { id: bid, bill_no: billNo, journal_id: jid };
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
      { account_code: ACC.AP, debit: total, vendor_id, memo: 'Settle payable' },
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
function runDepreciation(period, created_by) {
  const assets = db.prepare("SELECT * FROM assets WHERE status='active'").all();
  let posted = 0;
  for (const a of assets) {
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
        { account_code: a.expense_account || '71000', debit: monthly, building_id: a.building_id, memo: `Depreciation ${a.name}` },
        { account_code: a.accum_account || '17500', credit: monthly, building_id: a.building_id },
      ]);
    db.prepare('INSERT INTO depreciation_runs (asset_id,period,amount,journal_id) VALUES (?,?,?,?)').run(a.id, period, monthly, jid);
    db.prepare('UPDATE assets SET accum_depreciation=? WHERE id=?').run(r2(a.accum_depreciation + monthly), a.id);
    posted++;
  }
  return { period, posted };
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

module.exports = {
  issueInvoiceForContract, issueInvoicesForPeriod, backfillInvoices, issueAdHocInvoice,
  recognizeInvoice, recognizeRevenueForPeriod,
  recordPayment, deletePayment, recordDeposit,
  recordVendorBill, recordVendorPayment, runPayroll, terminateContract, runDepreciation, setTenantOpening, setVendorOpening,
  tenantAdvanceBalance, addMonths, periodOf, firstOfMonth, currentMonth, today,
  CUSTOMER_ADVANCE,
};
