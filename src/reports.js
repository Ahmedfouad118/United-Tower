// ==========================================================================
// Reporting: Trial Balance, Income Statement, Balance Sheet, Aging (AR/AP),
// per-unit/tenant statement, occupancy, dashboard, Property P&L, Cash-Flow
// forecast, ROI, VAT report, bank/treasury/cheque reports.
// ==========================================================================
const { db } = require('./db');
const { r2 } = require('./ledger');

const nameCol = (lang) => (lang === 'ar' ? "COALESCE(a.name_ar,a.name)" : lang === 'ur' ? "COALESCE(a.name_ur,a.name)" : "a.name");

// normalize a unit code so "FLAT 401", "flat401" and "FLAT  401" collapse to one
const normCode = (s) => String(s == null ? '' : s).toUpperCase().replace(/\s+/g, '');

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

// ---- Consolidated Income Statement (month-by-month, whole year) -----------
// One row per account with 12 monthly columns + total, so the year can be
// analysed horizontally (like the Excel A.mobasher sheet).
function incomeStatementConsolidated(year, lang = 'en', building_id) {
  year = String(year || new Date().getFullYear());
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const bf = building_id ? ' AND l.building_id=?' : '';
  const grab = (type, sign) => db.prepare(
    `SELECT a.code, ${nameCol(lang)} name, CAST(substr(j.jdate,6,2) AS INTEGER) mo,
            (COALESCE(SUM(l.credit),0)-COALESCE(SUM(l.debit),0))*? amt
     FROM accounts a JOIN journal_lines l ON l.account_code=a.code JOIN journals j ON j.id=l.journal_id
     WHERE a.type=? AND j.jdate>=? AND j.jdate<=? ${bf}
     GROUP BY a.code, mo`)
    .all(...[sign, type, from, to, ...(building_id ? [building_id] : [])]);
  const build = (raw) => {
    const byAcc = {};
    for (const r of raw) {
      if (r.mo < 1 || r.mo > 12) continue;
      if (!byAcc[r.code]) byAcc[r.code] = { code: r.code, name: r.name, months: Array(12).fill(0), total: 0 };
      byAcc[r.code].months[r.mo - 1] = r2(byAcc[r.code].months[r.mo - 1] + r.amt);
      byAcc[r.code].total = r2(byAcc[r.code].total + r.amt);
    }
    return Object.values(byAcc).filter((x) => Math.abs(x.total) > 0.005).sort((a, b) => a.code.localeCompare(b.code));
  };
  const income = build(grab('income', 1));
  const expense = build(grab('expense', -1));
  const sumMonths = (rows) => {
    const m = Array(12).fill(0); let tot = 0;
    for (const r of rows) { r.months.forEach((v, i) => m[i] = r2(m[i] + v)); tot = r2(tot + r.total); }
    return { months: m, total: tot };
  };
  const ti = sumMonths(income), te = sumMonths(expense);
  const net = { months: ti.months.map((v, i) => r2(v - te.months[i])), total: r2(ti.total - te.total) };
  return { year, income, expense, total_income: ti, total_expense: te, net };
}

// ---- General Ledger / account drill-down (movements on an account) --------
// Serves both the GL report (search accounts + see movements) and the
// click-through drill from any total in a report.
function accountLedger({ account, accounts, from, to, tenant_id, vendor_id, building_id, flat_id } = {}, lang = 'en') {
  const codes = (accounts && accounts.length ? accounts : (account ? [account] : [])).map(String);
  const p = []; let where = '1=1';
  if (codes.length) { where += ` AND l.account_code IN (${codes.map(() => '?').join(',')})`; p.push(...codes); }
  if (tenant_id) { where += ' AND l.tenant_id=?'; p.push(tenant_id); }
  if (vendor_id) { where += ' AND l.vendor_id=?'; p.push(vendor_id); }
  if (building_id) { where += ' AND l.building_id=?'; p.push(building_id); }
  if (flat_id) { where += ' AND l.flat_id=?'; p.push(flat_id); }
  // opening balance = net movement strictly before `from`
  let opening = 0;
  if (from) {
    const orow = db.prepare(
      `SELECT COALESCE(SUM(l.debit),0)-COALESCE(SUM(l.credit),0) bal
       FROM journal_lines l JOIN journals j ON j.id=l.journal_id
       WHERE ${where} AND j.jdate < ?`).get(...p, from);
    opening = r2(orow.bal);
  }
  const lines = db.prepare(
    `SELECT j.id journal_id, j.jdate, j.jtype, j.reference, j.memo j_memo, l.memo l_memo, l.account_code,
            ${nameCol(lang)} account_name, l.debit, l.credit,
            t.name tenant, v.name vendor, f.code flat, b.name building
     FROM journal_lines l JOIN journals j ON j.id=l.journal_id JOIN accounts a ON a.code=l.account_code
     LEFT JOIN tenants t ON t.id=l.tenant_id LEFT JOIN vendors v ON v.id=l.vendor_id
     LEFT JOIN flats f ON f.id=l.flat_id LEFT JOIN buildings b ON b.id=l.building_id
     WHERE ${where} ${from ? 'AND j.jdate>=?' : ''} ${to ? 'AND j.jdate<=?' : ''}
     ORDER BY j.jdate, j.id, l.id`)
    .all(...p, ...(from ? [from] : []), ...(to ? [to] : []));
  let running = opening;
  const rows = lines.map((ln) => {
    running = r2(running + ln.debit - ln.credit);
    return { journal_id: ln.journal_id, jdate: ln.jdate, jtype: ln.jtype, reference: ln.reference, account_code: ln.account_code,
      account_name: ln.account_name, memo: ln.l_memo || ln.j_memo, tenant: ln.tenant, vendor: ln.vendor,
      flat: ln.flat, building: ln.building, debit: r2(ln.debit), credit: r2(ln.credit), balance: running };
  });
  const total_debit = r2(lines.reduce((s, x) => s + x.debit, 0));
  const total_credit = r2(lines.reduce((s, x) => s + x.credit, 0));
  return { codes, opening: r2(opening), rows, total_debit, total_credit, closing: r2(running) };
}

// ---- Full General Ledger (every account with activity, grouped) -----------
// Selecting "all accounts" returns each account with its own opening + running
// balance, so it reads like a real GL rather than one mixed running total.
function generalLedgerFull({ from, to, building_id } = {}, lang = 'en') {
  const p = []; let where = '1=1';
  if (building_id) { where += ' AND l.building_id=?'; p.push(building_id); }
  const openings = {};
  if (from) {
    const orows = db.prepare(
      `SELECT l.account_code code, COALESCE(SUM(l.debit),0)-COALESCE(SUM(l.credit),0) bal
       FROM journal_lines l JOIN journals j ON j.id=l.journal_id
       WHERE ${where} AND j.jdate < ? GROUP BY l.account_code`).all(...p, from);
    for (const o of orows) openings[o.code] = r2(o.bal);
  }
  const lines = db.prepare(
    `SELECT j.id journal_id, j.jdate, j.reference, j.memo j_memo, l.memo l_memo, l.account_code,
            ${nameCol(lang)} account_name, l.debit, l.credit, t.name tenant, v.name vendor
     FROM journal_lines l JOIN journals j ON j.id=l.journal_id JOIN accounts a ON a.code=l.account_code
     LEFT JOIN tenants t ON t.id=l.tenant_id LEFT JOIN vendors v ON v.id=l.vendor_id
     WHERE ${where} ${from ? 'AND j.jdate>=?' : ''} ${to ? 'AND j.jdate<=?' : ''}
     ORDER BY l.account_code, j.jdate, j.id, l.id`)
    .all(...p, ...(from ? [from] : []), ...(to ? [to] : []));
  const byAcc = {};
  for (const ln of lines) {
    if (!byAcc[ln.account_code]) byAcc[ln.account_code] = { code: ln.account_code, name: ln.account_name, opening: openings[ln.account_code] || 0, rows: [], total_debit: 0, total_credit: 0, running: openings[ln.account_code] || 0 };
    const acc = byAcc[ln.account_code];
    acc.running = r2(acc.running + ln.debit - ln.credit);
    acc.total_debit = r2(acc.total_debit + ln.debit);
    acc.total_credit = r2(acc.total_credit + ln.credit);
    acc.rows.push({ journal_id: ln.journal_id, jdate: ln.jdate, reference: ln.reference, memo: ln.l_memo || ln.j_memo, party: ln.tenant || ln.vendor || '', debit: r2(ln.debit), credit: r2(ln.credit), balance: acc.running });
  }
  // include accounts that only have an opening balance (activity before `from`)
  for (const [code, bal] of Object.entries(openings)) {
    if (!byAcc[code] && Math.abs(bal) > 0.005) {
      const a = db.prepare(`SELECT ${nameCol(lang)} name FROM accounts a WHERE a.code=?`).get(code);
      byAcc[code] = { code, name: a ? a.name : code, opening: bal, rows: [], total_debit: 0, total_credit: 0, running: bal };
    }
  }
  const accounts = Object.values(byAcc).map((a) => ({ ...a, closing: r2(a.running) })).sort((x, y) => x.code.localeCompare(y.code));
  return { accounts };
}

// ---- Grouped journals: combine each batch (date + type) into one entry -----
// A read-only view that rolls all lines of the same day+type into a single
// consolidated journal — so an uploaded batch of receipts/invoices reads as ONE
// entry, without touching the real journals.
function groupedJournals(from, to, lang = 'en', group = 'day') {
  // period expression: whole selected range, per month, or per day
  const per = group === 'range' ? "'ALL'" : (group === 'month' || group === 'month-all') ? "substr(j.jdate,1,7)" : 'j.jdate';
  // 'month-all' combines ALL journal types of the month into ONE entry
  const jtypeExpr = group === 'month-all' ? "'ALL'" : 'j.jtype';
  const rows = db.prepare(
    `SELECT ${per} period, ${jtypeExpr} jtype, l.account_code, ${nameCol(lang)} account_name, a.type acctype,
            COALESCE(SUM(l.debit),0) debit, COALESCE(SUM(l.credit),0) credit
     FROM journal_lines l JOIN journals j ON j.id=l.journal_id JOIN accounts a ON a.code=l.account_code
     WHERE 1=1 ${from ? 'AND j.jdate>=?' : ''} ${to ? 'AND j.jdate<=?' : ''}
     GROUP BY period, jtype, l.account_code
     HAVING ABS(debit)>0.005 OR ABS(credit)>0.005
     ORDER BY period DESC, jtype, l.account_code`).all(...[...(from ? [from] : []), ...(to ? [to] : [])]);
  const groups = {};
  for (const l of rows) {
    const k = l.period + '|' + l.jtype;
    if (!groups[k]) groups[k] = { jdate: l.period === 'ALL' ? ((from || '') + ' → ' + (to || '')) : l.period, jtype: l.jtype, lines: [], total_debit: 0, total_credit: 0 };
    groups[k].lines.push({ account_code: l.account_code, account_name: l.account_name, acctype: l.acctype, debit: r2(l.debit), credit: r2(l.credit) });
    groups[k].total_debit = r2(groups[k].total_debit + l.debit);
    groups[k].total_credit = r2(groups[k].total_credit + l.credit);
  }
  return Object.values(groups);
}

// ---- Legacy-system journals: ONE combined revenue entry + ONE expense entry
// per month, built from the system's own auto entries — sized for pasting into
// Peachtree/Sage (side = all | revenue | expense).
function legacyJournals(from, to, lang = 'en', side = 'all') {
  const filt = side === 'revenue' ? "AND j.jtype IN ('invoice','recognition','receipt','adjustment')"
    : side === 'expense' ? "AND j.jtype IN ('expense','payment')" : '';
  const rows = db.prepare(
    `SELECT substr(j.jdate,1,7) period, l.account_code, ${nameCol(lang)} account_name, a.type acctype,
            COALESCE(SUM(l.debit),0) debit, COALESCE(SUM(l.credit),0) credit
     FROM journal_lines l JOIN journals j ON j.id=l.journal_id JOIN accounts a ON a.code=l.account_code
     WHERE 1=1 ${from ? 'AND j.jdate>=?' : ''} ${to ? 'AND j.jdate<=?' : ''} ${filt}
     GROUP BY period, l.account_code
     HAVING ABS(debit)>0.005 OR ABS(credit)>0.005
     ORDER BY period, l.account_code`).all(...[...(from ? [from] : []), ...(to ? [to] : [])]);
  // wash per period = current-month invoices already settled — removed from BOTH
  // sides of the receivable so 11100 shows only "new unpaid" (Dr) & "old collected" (Cr)
  const washRows = db.prepare('SELECT period, COALESCE(SUM(paid_amount),0) w FROM invoices GROUP BY period').all();
  const wash = {}; for (const w of washRows) wash[w.period] = r2(w.w);
  const groups = {};
  for (const l of rows) {
    if (!groups[l.period]) groups[l.period] = { period: l.period, lines: [], total_debit: 0, total_credit: 0 };
    let debit = r2(l.debit), credit = r2(l.credit);
    if (l.account_code === '11100' && (side === 'all' || side === 'revenue')) {
      const w = Math.min(wash[l.period] || 0, debit, credit);
      debit = r2(debit - w); credit = r2(credit - w);
    }
    const g = groups[l.period];
    const meta = { account_code: l.account_code, account_name: l.account_name, acctype: l.acctype };
    // an account with BOTH sides becomes TWO rows (same code): one Dr, one Cr
    if (debit > 0.005 && credit > 0.005) {
      g.lines.push({ ...meta, debit, credit: 0 });
      g.lines.push({ ...meta, debit: 0, credit });
    } else if (debit > 0.005 || credit > 0.005) {
      g.lines.push({ ...meta, debit: debit > 0.005 ? debit : 0, credit: credit > 0.005 ? credit : 0 });
    }
  }
  for (const g of Object.values(groups)) {
    g.total_debit = r2(g.lines.reduce((s, x) => s + x.debit, 0));
    g.total_credit = r2(g.lines.reduce((s, x) => s + x.credit, 0));
  }
  return Object.values(groups).sort((a, b) => b.period.localeCompare(a.period));
}

// ---- Liquidity report (current assets vs current liabilities) -------------
// Fixed assets (buildings/land + their accumulated depreciation) are excluded
// from current assets; everything else asset = current/liquid within a year.
const FIXED_ASSET_CODES = ['15500', '16900', '17500', '15000', '16000', '18000'];
const CASH_CODES = ['10000', '10400', '10500', '10100', '10200', '10300'];
function liquidityReport(upto, lang = 'en') {
  const bal = (type, sign) => db.prepare(
    `SELECT a.code, ${nameCol(lang)} name, (COALESCE(SUM(l.debit),0)-COALESCE(SUM(l.credit),0))*? amt
     FROM accounts a JOIN journal_lines l ON l.account_code=a.code JOIN journals j ON j.id=l.journal_id
     WHERE a.type=? ${upto ? 'AND j.jdate<=?' : ''}
     GROUP BY a.code HAVING ABS(amt)>0.005 ORDER BY a.code`).all(...[sign, type, ...(upto ? [upto] : [])]);
  const allAssets = bal('asset', 1), liabilities = bal('liability', -1);
  const current_assets = allAssets.filter((a) => !FIXED_ASSET_CODES.includes(a.code));
  // cash & equivalents = petty cash + EVERY bank's GL account (not just 10400)
  const bankAccs = db.prepare("SELECT DISTINCT gl_account c FROM banks WHERE gl_account IS NOT NULL AND gl_account<>''").all().map((x) => x.c);
  const cashSet = new Set([...CASH_CODES, ...bankAccs]);
  const cash = current_assets.filter((a) => cashSet.has(a.code));
  const ca = r2(current_assets.reduce((s, x) => s + x.amt, 0));
  const cl = r2(liabilities.reduce((s, x) => s + x.amt, 0));
  const cashTotal = r2(cash.reduce((s, x) => s + x.amt, 0));
  // quick assets = current assets excluding inventory (no inventory here => same as CA)
  const quick = ca;
  const ratio = (n, d) => d ? r2(n / d) : 0;
  return {
    upto, current_assets, current_liabilities: liabilities,
    total_current_assets: ca, total_current_liabilities: cl, cash: cashTotal,
    working_capital: r2(ca - cl),
    current_ratio: ratio(ca, cl), quick_ratio: ratio(quick, cl), cash_ratio: ratio(cashTotal, cl),
  };
}

// ---- Financial ratios (profitability + liquidity) for the dashboard -------
function financialRatios(from, to, building_id) {
  const is = incomeStatement(from, to, 'en', building_id);
  const bs = balanceSheet(to, 'en');
  const liq = liquidityReport(to, 'en');
  const rev = is.total_income, net = is.net;
  const totalAssets = bs.total_assets, equity = bs.total_equity;
  const pct = (n, d) => d ? r2((n / d) * 100) : 0;
  return {
    revenue: rev, net_income: net, total_assets: totalAssets, equity,
    // profitability
    gross_margin: pct(net, rev), net_margin: pct(net, rev),
    roa: pct(net, totalAssets), roe: pct(net, equity),
    asset_turnover: pct(rev, totalAssets), // expressed as a percentage
    // liquidity
    current_ratio: liq.current_ratio, quick_ratio: liq.quick_ratio, cash_ratio: liq.cash_ratio,
    working_capital: liq.working_capital,
  };
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
const CUSTOMER_ACCOUNTS = ['11000', '11100', '21500', '23100'];
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
        COALESCE(SUM(CASE WHEN l.account_code IN ('21500','23100') THEN l.credit-l.debit ELSE 0 END),0) advance
     FROM tenants t LEFT JOIN journal_lines l ON l.tenant_id=t.id
     GROUP BY t.id ORDER BY receivable DESC`).all();
  return rows.map((r) => ({ ...r, receivable: r2(r.receivable), advance: r2(r.advance), net: r2(r.receivable - r.advance) }))
    .filter((r) => Math.abs(r.receivable) > 0.005 || Math.abs(r.advance) > 0.005);
}

// ---- Occupancy calendar ---------------------------------------------------
function occupancy(onDate, building_id) {
  const ref = onDate || new Date().toISOString().slice(0, 10);
  const flats = db.prepare(`SELECT * FROM flats ${building_id ? 'WHERE building_id=?' : ''} ORDER BY code`).all(...(building_id ? [building_id] : []));
  // Deduplicate by normalized code so legacy duplicate units don't inflate the
  // calendar or the occupancy rate. A unit counts as occupied if ANY of the
  // duplicate rows sharing its code has an active contract.
  const groups = {};
  for (const f of flats) { const k = normCode(f.code); (groups[k] = groups[k] || []).push(f); }
  const result = Object.values(groups).map((grp) => {
    const f = grp[0];
    const ids = grp.map((x) => x.id);
    const c = db.prepare(
      `SELECT c.*, t.name tenant FROM contracts c JOIN tenants t ON t.id=c.tenant_id
       WHERE c.flat_id IN (${ids.map(() => '?').join(',')}) AND c.start_date<=? AND (c.end_date>=? OR c.end_date IS NULL OR c.end_date='')
         AND c.status NOT IN ('terminated','vacated')
       ORDER BY c.start_date DESC LIMIT 1`).get(...ids, ref, ref);
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

// ---- Cheques dashboard: cheques to collect (incoming) vs to pay (outgoing) --
// Pending cheques whose due date has passed keep rolling forward as "due now"
// until they are cleared, so nothing gets lost.
function chequesDashboard(asOf) {
  const ref = asOf || new Date().toISOString().slice(0, 10);
  const all = db.prepare('SELECT * FROM cheques ORDER BY due_date').all();
  const side = (direction) => {
    const rows = all.filter((c) => c.direction === direction);
    const pending = rows.filter((c) => c.status === 'pending');
    const bucketOf = (c) => { const d = (c.due_date || '').slice(0, 10); if (!d || d < ref) return 'overdue'; if (d === ref) return 'today'; return 'upcoming'; };
    const buckets = { overdue: [], today: [], upcoming: [] };
    for (const c of pending) buckets[bucketOf(c)].push(c);
    const sum = (list) => r2(list.reduce((s, c) => s + (c.amount || 0), 0));
    const cleared = rows.filter((c) => c.status === 'cleared');
    const bounced = rows.filter((c) => c.status === 'bounced');
    // "due now" rolls overdue + today together (uncollected carries to next days)
    const dueNow = buckets.overdue.concat(buckets.today).sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
    return {
      overdue: { count: buckets.overdue.length, amount: sum(buckets.overdue) },
      today: { count: buckets.today.length, amount: sum(buckets.today) },
      upcoming: { count: buckets.upcoming.length, amount: sum(buckets.upcoming), list: buckets.upcoming },
      due_now: { count: dueNow.length, amount: sum(dueNow), list: dueNow },
      pending_total: sum(pending),
      cleared: { count: cleared.length, amount: sum(cleared) },
      bounced: { count: bounced.length, amount: sum(bounced) },
    };
  };
  return { asOf: ref, incoming: side('incoming'), outgoing: side('outgoing') };
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
  // customer advances now live in 23100 (new) AND legacy 21500 — count both,
  // but only the tenant-tagged part (so deferred-rent GL entries aren't included)
  const advance = db.prepare(`SELECT COALESCE(SUM(l.credit)-SUM(l.debit),0) s FROM journal_lines l WHERE l.account_code IN ('21500','23100') AND l.tenant_id IS NOT NULL`).get().s;
  const deposits = db.prepare(`SELECT COALESCE(SUM(l.credit)-SUM(l.debit),0) s FROM journal_lines l WHERE l.account_code='21000'`).get().s;
  // outstanding receivables = actual net balance of the receivable accounts up to
  // the period end (opening balances + invoices − collections), not just unpaid invoices
  const recvBal = db.prepare(
    `SELECT COALESCE(SUM(l.debit)-SUM(l.credit),0) s FROM journal_lines l JOIN journals j ON j.id=l.journal_id
     WHERE l.account_code IN ('11000','11100') ${to ? 'AND j.jdate<=?' : ''} ${building_id ? 'AND l.building_id=?' : ''}`)
    .get(...[...(to ? [to] : []), ...(building_id ? [building_id] : [])]).s;
  return {
    occupancy_rate: occ.total ? Math.round((occ.occupied / occ.total) * 100) : 0,
    total_flats: occ.total, occupied: occ.occupied, vacant: occ.vacant,
    collected_this_month: r2(collected), outstanding_receivables: r2(recvBal),
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
  trialBalance, incomeStatement, incomeStatementConsolidated, accountLedger, generalLedgerFull, groupedJournals, legacyJournals,
  liquidityReport, financialRatios, balanceSheet, receivablesAging, payablesAging,
  flatStatement, occupancy, propertyPL, roi, cashFlowForecast, vatReport,
  bankReport, chequesReport, chequesDashboard, dashboard, contractExpiry, buildingComparison,
  depreciationReport, customersSummary,
};
