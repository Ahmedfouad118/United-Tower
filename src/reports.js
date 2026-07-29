// ==========================================================================
// Reporting: Trial Balance, Income Statement, Balance Sheet, Aging (AR/AP),
// per-unit/tenant statement, occupancy, dashboard, Property P&L, Cash-Flow
// forecast, ROI, VAT report, bank/treasury/cheque reports.
// ==========================================================================
const { db } = require('./db');
const { r2 } = require('./ledger');

const nameCol = (lang) => (lang === 'ar' ? "COALESCE(a.name_ar,a.name)" : lang === 'ur' ? "COALESCE(a.name_ur,a.name)" : "a.name");

// ---- Trial Balance --------------------------------------------------------
function trialBalance(upto, lang = 'en') {
  const rows = db.prepare(
    `SELECT a.code, ${nameCol(lang)} name, a.type,
            COALESCE(SUM(l.debit),0) d, COALESCE(SUM(l.credit),0) c
     FROM accounts a
     LEFT JOIN journal_lines l ON l.account_code=a.code
     LEFT JOIN journals j ON j.id=l.journal_id ${upto ? 'AND j.jdate<=?' : ''}
     GROUP BY a.code ORDER BY a.code`).all(...(upto ? [upto] : []));
  let td = 0, tc = 0;
  const out = rows.map((rw) => {
    const bal = r2(rw.d - rw.c), debit = bal > 0 ? bal : 0, credit = bal < 0 ? -bal : 0;
    td += debit; tc += credit;
    return { code: rw.code, name: rw.name, type: rw.type, debit: r2(debit), credit: r2(credit) };
  }).filter((x) => x.debit || x.credit);
  return { rows: out, total_debit: r2(td), total_credit: r2(tc), balanced: Math.abs(td - tc) < 0.01 };
}

// ---- Income Statement -----------------------------------------------------
function incomeStatement(from, to, lang = 'en', building_id) {
  const bf = building_id ? ' AND l.building_id=?' : '';
  const grab = (type, sign) => db.prepare(
    `SELECT a.code, ${nameCol(lang)} name, (COALESCE(SUM(l.credit),0)-COALESCE(SUM(l.debit),0))*? amt
     FROM accounts a JOIN journal_lines l ON l.account_code=a.code JOIN journals j ON j.id=l.journal_id
     WHERE a.type=? ${from ? 'AND j.jdate>=?' : ''} ${to ? 'AND j.jdate<=?' : ''} ${bf}
     GROUP BY a.code HAVING amt<>0 ORDER BY a.code`)
    .all(...[sign, type, ...(from ? [from] : []), ...(to ? [to] : []), ...(building_id ? [building_id] : [])]);
  const income = grab('income', 1);
  const expense = grab('expense', -1);
  const total_income = r2(income.reduce((s, x) => s + x.amt, 0));
  const total_expense = r2(expense.reduce((s, x) => s + x.amt, 0));
  return { income, expense, total_income, total_expense, net: r2(total_income - total_expense) };
}

// ---- Balance Sheet --------------------------------------------------------
function balanceSheet(upto, lang = 'en') {
  const grab = (type, sign) => db.prepare(
    `SELECT a.code, ${nameCol(lang)} name, (COALESCE(SUM(l.debit),0)-COALESCE(SUM(l.credit),0))*? amt
     FROM accounts a JOIN journal_lines l ON l.account_code=a.code JOIN journals j ON j.id=l.journal_id
     WHERE a.type=? ${upto ? 'AND j.jdate<=?' : ''}
     GROUP BY a.code HAVING amt<>0 ORDER BY a.code`).all(...[sign, type, ...(upto ? [upto] : [])]);
  const assets = grab('asset', 1), liabilities = grab('liability', -1), equity = grab('equity', -1);
  const is = incomeStatement(null, upto, lang);
  const total_assets = r2(assets.reduce((s, x) => s + x.amt, 0));
  const total_liabilities = r2(liabilities.reduce((s, x) => s + x.amt, 0));
  const total_equity = r2(equity.reduce((s, x) => s + x.amt, 0));
  return {
    assets, liabilities, equity, total_assets, total_liabilities,
    total_equity: r2(total_equity + is.net), net_income: is.net,
    balanced: Math.abs(total_assets - (total_liabilities + total_equity + is.net)) < 0.05,
  };
}

// ---- Receivables aging (from invoices) ------------------------------------
function receivablesAging(asOf, building_id) {
  const ref = asOf || new Date().toISOString().slice(0, 10);
  const rows = db.prepare(
    `SELECT i.tenant_id, t.name tenant, i.due_date, i.total - i.paid_amount outstanding
     FROM invoices i JOIN tenants t ON t.id=i.tenant_id
     WHERE i.status IN ('issued','partial') AND (i.total - i.paid_amount) > 0.005
     ${building_id ? 'AND i.building_id=' + Number(building_id) : ''}`).all();
  const days = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / 86400000);
  const byT = {}; const totals = { current: 0, d30: 0, d60: 0, d90: 0, d180: 0, d180p: 0 };
  for (const r of rows) {
    const age = days(r.due_date, ref);
    let b = 'current';
    if (age > 180) b = 'd180p'; else if (age > 90) b = 'd180'; else if (age > 60) b = 'd90';
    else if (age > 30) b = 'd60'; else if (age > 0) b = 'd30';
    const amt = r2(r.outstanding);
    if (!byT[r.tenant_id]) byT[r.tenant_id] = { tenant_id: r.tenant_id, tenant: r.tenant, current: 0, d30: 0, d60: 0, d90: 0, d180: 0, d180p: 0, total: 0 };
    byT[r.tenant_id][b] = r2(byT[r.tenant_id][b] + amt);
    byT[r.tenant_id].total = r2(byT[r.tenant_id].total + amt);
    totals[b] = r2(totals[b] + amt);
  }
  const list = Object.values(byT).sort((a, b) => b.total - a.total);
  return { asOf: ref, rows: list, totals, grand_total: r2(list.reduce((s, x) => s + x.total, 0)) };
}

// ---- Payables aging (vendor bills) ---------------------------------------
function payablesAging(asOf) {
  const ref = asOf || new Date().toISOString().slice(0, 10);
  const rows = db.prepare(
    `SELECT b.vendor_id, COALESCE(v.name,'(no vendor)') vendor, b.bdate, b.total-b.paid_amount amt
     FROM vendor_bills b LEFT JOIN vendors v ON v.id=b.vendor_id
     WHERE b.status!='paid' AND (b.total-b.paid_amount)>0.005`).all();
  const days = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / 86400000);
  const byV = {};
  for (const r of rows) {
    const age = days(r.bdate, ref);
    let b = 'current';
    if (age > 180) b = 'd180p'; else if (age > 90) b = 'd180'; else if (age > 60) b = 'd90';
    else if (age > 30) b = 'd60'; else if (age > 0) b = 'd30';
    const key = r.vendor_id || 0;
    if (!byV[key]) byV[key] = { vendor: r.vendor, current: 0, d30: 0, d60: 0, d90: 0, d180: 0, d180p: 0, total: 0 };
    byV[key][b] = r2(byV[key][b] + r.amt); byV[key].total = r2(byV[key].total + r.amt);
  }
  const list = Object.values(byV).sort((a, b) => b.total - a.total);
  return { asOf: ref, rows: list, grand_total: r2(list.reduce((s, x) => s + x.total, 0)) };
}

// ---- Per-unit / per-tenant statement (customer sub-ledger) ---------------
const CUSTOMER_ACCOUNTS = ['11000', '11100', '21500'];
function flatStatement({ flat_id, tenant_id, building_id, from, to }, lang = 'en') {
  const p = []; let where = '1=1';
  if (flat_id) { where += ' AND l.flat_id=?'; p.push(flat_id); }
  if (tenant_id) { where += ' AND l.tenant_id=?'; p.push(tenant_id); }
  if (building_id) { where += ' AND l.building_id=?'; p.push(building_id); }
  if (from) { where += ' AND j.jdate>=?'; p.push(from); }
  if (to) { where += ' AND j.jdate<=?'; p.push(to); }
  const list = CUSTOMER_ACCOUNTS.map(() => '?').join(',');
  const lines = db.prepare(
    `SELECT j.jdate, j.jtype, j.reference, j.memo, l.account_code, ${nameCol(lang)} account_name,
            l.debit, l.credit, l.tenant_id, t.name tenant, l.flat_id, f.code flat
     FROM journal_lines l JOIN journals j ON j.id=l.journal_id JOIN accounts a ON a.code=l.account_code
     LEFT JOIN tenants t ON t.id=l.tenant_id LEFT JOIN flats f ON f.id=l.flat_id
     WHERE ${where} AND l.account_code IN (${list}) ORDER BY j.jdate, j.id, l.id`).all(...p, ...CUSTOMER_ACCOUNTS);
  let running = 0;
  const withBal = lines.map((ln) => { running = r2(running + ln.debit - ln.credit); return { ...ln, balance: running }; });
  const td = r2(lines.reduce((s, x) => s + x.debit, 0)), tc = r2(lines.reduce((s, x) => s + x.credit, 0));
  return { lines: withBal, total_debit: td, total_credit: tc, balance: r2(td - tc) };
}

// ---- Customers summary (all customers, balances) -------------------------
function customersSummary() {
  const rows = db.prepare(
    `SELECT t.id, t.name tenant, t.phone,
        COALESCE(SUM(CASE WHEN l.account_code IN ('11000','11100') THEN l.debit-l.credit ELSE 0 END),0) receivable,
        COALESCE(SUM(CASE WHEN l.account_code='21500' THEN l.credit-l.debit ELSE 0 END),0) advance
     FROM tenants t LEFT JOIN journal_lines l ON l.tenant_id=t.id
     GROUP BY t.id ORDER BY receivable DESC`).all();
  return rows.map((r) => ({ ...r, receivable: r2(r.receivable), advance: r2(r.advance), net: r2(r.receivable - r.advance) }))
    .filter((r) => Math.abs(r.receivable) > 0.005 || Math.abs(r.advance) > 0.005);
}

// ---- Occupancy calendar ---------------------------------------------------
function occupancy(onDate, building_id) {
  const ref = onDate || new Date().toISOString().slice(0, 10);
  const flats = db.prepare(`SELECT * FROM flats ${building_id ? 'WHERE building_id=?' : ''} ORDER BY code`).all(...(building_id ? [building_id] : []));
  const result = flats.map((f) => {
    const c = db.prepare(
      `SELECT c.*, t.name tenant FROM contracts c JOIN tenants t ON t.id=c.tenant_id
       WHERE c.flat_id=? AND c.start_date<=? AND (c.end_date>=? OR c.end_date IS NULL OR c.end_date='')
         AND c.status NOT IN ('terminated','vacated')
       ORDER BY c.start_date DESC LIMIT 1`).get(f.id, ref, ref);
    return { flat_id: f.id, flat: f.code, floor: f.floor, unit_type: f.unit_type, base_rent: f.base_rent,
      status: c ? 'occupied' : 'vacant', tenant: c ? c.tenant : null, contract_no: c ? c.contract_no : null,
      end_date: c ? c.end_date : null, monthly_rent: c ? c.monthly_rent : null };
  });
  const occupied = result.filter((r) => r.status === 'occupied').length;
  return { onDate: ref, total: flats.length, occupied, vacant: flats.length - occupied, flats: result };
}

// ---- Property P&L (per building) -----------------------------------------
function propertyPL(from, to) {
  const rows = db.prepare(
    `SELECT b.id building_id, b.name building,
            COALESCE(SUM(CASE WHEN a.type='income' THEN l.credit-l.debit ELSE 0 END),0) income,
            COALESCE(SUM(CASE WHEN a.type='expense' THEN l.debit-l.credit ELSE 0 END),0) expense
     FROM buildings b
     LEFT JOIN journal_lines l ON l.building_id=b.id
     LEFT JOIN journals j ON j.id=l.journal_id ${from ? 'AND j.jdate>=?' : ''} ${to ? 'AND j.jdate<=?' : ''}
     LEFT JOIN accounts a ON a.code=l.account_code
     GROUP BY b.id ORDER BY b.name`).all(...[...(from ? [from] : []), ...(to ? [to] : [])]);
  return rows.map((r) => ({ ...r, income: r2(r.income), expense: r2(r.expense), net: r2(r.income - r.expense) }));
}

// ---- ROI per property -----------------------------------------------------
function roi(from, to) {
  const pls = propertyPL(from, to);
  return db.prepare('SELECT id,name,purchase_value FROM buildings').all().map((b) => {
    const pl = pls.find((p) => p.building_id === b.id) || { net: 0 };
    const annualNet = r2(pl.net);
    return { building: b.name, purchase_value: r2(b.purchase_value), annual_net: annualNet,
      roi_percent: b.purchase_value ? r2((annualNet / b.purchase_value) * 100) : 0 };
  });
}

// ---- Cash-flow forecast (upcoming due invoices) --------------------------
function cashFlowForecast(months = 6) {
  const rows = db.prepare(
    `SELECT substr(due_date,1,7) m, SUM(total - paid_amount) due
     FROM invoices WHERE status IN ('issued','partial') AND (total-paid_amount)>0.005
     GROUP BY m ORDER BY m`).all();
  return rows.map((r) => ({ period: r.m, expected_inflow: r2(r.due) }));
}

// ---- VAT report (accrual + collected/outstanding split) -------------------
function vatReport(from, to) {
  const bal = (code) => db.prepare(
    `SELECT COALESCE(SUM(l.credit),0) c, COALESCE(SUM(l.debit),0) d
     FROM journal_lines l JOIN journals j ON j.id=l.journal_id
     WHERE l.account_code=? ${from ? 'AND j.jdate>=?' : ''} ${to ? 'AND j.jdate<=?' : ''}`)
    .get(...[code, ...(from ? [from] : []), ...(to ? [to] : [])]);
  const out = bal('23200'), inp = bal('11600');
  const output_vat = r2(out.c - out.d), input_vat = r2(inp.d - inp.c);
  // Accrual view from invoices: VAT due, collected (pro-rata of paid), outstanding
  const inv = db.prepare(
    `SELECT COALESCE(SUM(vat_amount),0) due,
            COALESCE(SUM(CASE WHEN total>0 THEN vat_amount*(paid_amount/total) ELSE 0 END),0) collected
     FROM invoices WHERE status!='cancelled' ${from ? 'AND due_date>=?' : ''} ${to ? 'AND due_date<=?' : ''}`)
    .get(...[...(from ? [from] : []), ...(to ? [to] : [])]);
  const vat_due = r2(inv.due), vat_collected = r2(inv.collected);
  return {
    from, to,
    vat_due, vat_collected, vat_outstanding: r2(vat_due - vat_collected),
    output_vat, input_vat, net_payable: r2(output_vat - input_vat),
  };
}

// ---- Depreciation schedule ------------------------------------------------
function depreciationReport(building_id) {
  const assets = db.prepare(`SELECT a.*, b.name building FROM assets a LEFT JOIN buildings b ON b.id=a.building_id
    ${building_id ? 'WHERE a.building_id=' + Number(building_id) : ''} ORDER BY a.name`).all();
  return assets.map((a) => ({
    ...a, depreciable: r2(a.cost - a.salvage_value),
    net_book_value: r2(a.cost - a.accum_depreciation),
    monthly: r2((a.cost - a.salvage_value) / (a.life_years * 12)),
  }));
}

// ---- Bank / treasury / cheque reports ------------------------------------
function bankReport(bank_id, from, to) {
  const bank = db.prepare('SELECT * FROM banks WHERE id=?').get(bank_id);
  const code = bank ? bank.gl_account : '10400';
  const lines = db.prepare(
    `SELECT j.jdate, j.jtype, j.reference, j.memo, l.debit, l.credit
     FROM journal_lines l JOIN journals j ON j.id=l.journal_id
     WHERE l.account_code=? ${from ? 'AND j.jdate>=?' : ''} ${to ? 'AND j.jdate<=?' : ''}
     ORDER BY j.jdate, j.id`).all(...[code, ...(from ? [from] : []), ...(to ? [to] : [])]);
  let bal = 0; const withBal = lines.map((l) => { bal = r2(bal + l.debit - l.credit); return { ...l, balance: bal }; });
  return { account: code, bank: bank ? bank.name : code, lines: withBal, balance: bal };
}
function chequesReport(status, direction) {
  let where = '1=1', p = [];
  if (status) { where += ' AND status=?'; p.push(status); }
  if (direction) { where += ' AND direction=?'; p.push(direction); }
  return db.prepare(`SELECT * FROM cheques WHERE ${where} ORDER BY due_date`).all(...p);
}

// ---- Dashboard ------------------------------------------------------------
function dashboard(building_id, from, to) {
  const today = new Date().toISOString().slice(0, 10);
  const occ = occupancy(to || today, building_id);
  const aging = receivablesAging(to || today, building_id);
  // "collected" respects the selected date range, else current month
  const collected = (from || to)
    ? db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM payments WHERE pdate>=? AND pdate<=?`).get(from || '0000', to || '9999').s
    : db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM payments WHERE substr(pdate,1,7)=substr(?,1,7)`).get(today).s;
  const monthly = db.prepare(`SELECT substr(pdate,1,7) m, SUM(amount) total FROM payments GROUP BY m ORDER BY m DESC LIMIT 12`).all().reverse();
  const incomeYtd = db.prepare(
    `SELECT COALESCE(SUM(l.credit)-SUM(l.debit),0) s FROM journal_lines l JOIN journals j ON j.id=l.journal_id JOIN accounts a ON a.code=l.account_code
     WHERE a.type='income' ${from ? 'AND j.jdate>=?' : ''} ${to ? 'AND j.jdate<=?' : ''}`).get(...[...(from ? [from] : []), ...(to ? [to] : [])]).s;
  const advance = db.prepare(`SELECT COALESCE(SUM(l.credit)-SUM(l.debit),0) s FROM journal_lines l WHERE l.account_code='21500'`).get().s;
  const deposits = db.prepare(`SELECT COALESCE(SUM(l.credit)-SUM(l.debit),0) s FROM journal_lines l WHERE l.account_code='21000'`).get().s;
  return {
    occupancy_rate: occ.total ? Math.round((occ.occupied / occ.total) * 100) : 0,
    total_flats: occ.total, occupied: occ.occupied, vacant: occ.vacant,
    collected_this_month: r2(collected), outstanding_receivables: aging.grand_total,
    income_ytd: r2(incomeYtd), advance_held: r2(advance), deposits_held: r2(deposits),
    monthly_collection: monthly, aging_buckets: aging.totals, top_debtors: aging.rows.slice(0, 8),
    cash_flow: cashFlowForecast(6), expiring_contracts: contractExpiry(60, building_id),
  };
}

// ---- Contract expiry alerts ----------------------------------------------
function contractExpiry(days = 60, building_id) {
  const ref = new Date();
  const limit = new Date(ref.getTime() + days * 86400000).toISOString().slice(0, 10);
  const rows = db.prepare(
    `SELECT c.id, c.contract_no, c.end_date, c.monthly_rent, t.name tenant, f.code flat, b.name building,
            CAST((julianday(c.end_date)-julianday('now')) AS INTEGER) days_left
     FROM contracts c JOIN tenants t ON t.id=c.tenant_id JOIN flats f ON f.id=c.flat_id
     LEFT JOIN buildings b ON b.id=c.building_id
     WHERE c.status='active' AND c.end_date<=? ${building_id ? 'AND c.building_id=' + Number(building_id) : ''}
     ORDER BY c.end_date`).all(limit);
  return rows;
}

// ---- Building comparison (performance) -----------------------------------
function buildingComparison(from, to) {
  const pls = propertyPL(from, to);
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare('SELECT id,name,purchase_value FROM buildings WHERE active=1').all().map((b) => {
    const occ = occupancy(today, b.id);
    const pl = pls.find((p) => p.building_id === b.id) || { income: 0, expense: 0, net: 0 };
    return {
      building_id: b.id, building: b.name, income: pl.income, expense: pl.expense, net: pl.net,
      units: occ.total, occupied: occ.occupied, occupancy_rate: occ.total ? Math.round(occ.occupied / occ.total * 100) : 0,
      roi_percent: b.purchase_value ? r2((pl.net / b.purchase_value) * 100) : 0,
    };
  });
}

module.exports = {
  trialBalance, incomeStatement, balanceSheet, receivablesAging, payablesAging,
  flatStatement, occupancy, propertyPL, roi, cashFlowForecast, vatReport,
  bankReport, chequesReport, dashboard, contractExpiry, buildingComparison,
  depreciationReport, customersSummary,
};
