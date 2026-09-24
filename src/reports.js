// ==========================================================================
// Reporting: Trial Balance, Income Statement, Balance Sheet, Aging (AR/AP),
// per-unit/tenant statement, occupancy, dashboard, Property P&L, Cash-Flow
// forecast, ROI, VAT report, bank/treasury/cheque reports.
// ==========================================================================
const { db } = require('./db');
const { r2 } = require('./ledger');
const CFG = require('./config');

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
  const expenseAll = build(grab('expense', -1));
  const depCode = CFG.acct('depreciation_expense'), taxCode = CFG.acct('income_tax_expense');
  const expense = expenseAll.filter((x) => x.code !== depCode && x.code !== taxCode);
  const depreciation_rows = expenseAll.filter((x) => x.code === depCode);
  const tax_rows = expenseAll.filter((x) => x.code === taxCode);
  const sumMonths = (rows) => {
    const m = Array(12).fill(0); let tot = 0;
    for (const r of rows) { r.months.forEach((v, i) => m[i] = r2(m[i] + v)); tot = r2(tot + r.total); }
    return { months: m, total: tot };
  };
  const ti = sumMonths(income), te = sumMonths(expense);
  const depreciation = sumMonths(depreciation_rows), income_tax = sumMonths(tax_rows);
  const ebitda = { months: ti.months.map((v, i) => r2(v - te.months[i])), total: r2(ti.total - te.total) };
  const net = { months: ebitda.months.map((v, i) => r2(v - depreciation.months[i] - income_tax.months[i])), total: r2(ebitda.total - depreciation.total - income_tax.total) };
  return { year, income, expense, total_income: ti, total_expense: te, ebitda, depreciation, income_tax, net, depreciation_code: depCode, income_tax_code: taxCode };
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

// Same-month settlement of a month's OWN invoices, computed from the LEDGER so it
// never depends on the mutable invoices.paid_amount. Per invoice:
//   settled = min(total, receipts dated in the invoice's month allocated to it
//                        + advance-applications booked against it)
// Both are credits to 11100 that settle THIS month's invoice (not old debt).
const LEGACY_SETTLED_PER_INV_SQL = `
  SELECT i.id inv_id, i.period period, i.tenant_id tid, i.total total,
    MIN(i.total,
        COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                    JOIN payments p ON p.id=pa.payment_id
                   WHERE pa.invoice_id=i.id AND substr(p.pdate,1,7)=i.period),0)
      + COALESCE((SELECT SUM(l.credit) FROM journal_lines l JOIN journals j ON j.id=l.journal_id
                   WHERE l.account_code='11100' AND j.jtype='adjustment'
                     AND j.source_table='invoices' AND j.source_id=i.id),0)
    ) settled
  FROM invoices i`;
const LEGACY_SETTLED_SQL = `SELECT period, COALESCE(SUM(settled),0) w FROM (${LEGACY_SETTLED_PER_INV_SQL})`;

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
  // wash per period = this-month's invoices already settled IN the same month —
  // removed from BOTH sides of the receivable so 11100 shows only "new unpaid"
  // (Dr) & "old collected" (Cr). Computed straight from the LEDGER (not the
  // mutable invoices.paid_amount): same-month receipt settlements (by payment
  // date) + advance-applications to that month's invoices. This makes an earlier
  // month's figures immune to anything entered later — fully period-stable.
  const washRows = db.prepare(`${LEGACY_SETTLED_SQL} GROUP BY period`).all();
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

// ---- Legacy report drill: WHO makes up each amount (per tenant/vendor) -----
// side = 'debit' | 'credit'. 11100 has special meaning (new-unpaid / old-collected).
function legacyDrill(account, period, side, lang = 'en') {
  // same-month settlement (ledger-based) for THIS period, keyed by tenant — the
  // single source both 11100 drills net against, so they always tie to the report
  // line and never drift with later months.
  const settledByTenant = () => {
    const rows = db.prepare(`${LEGACY_SETTLED_PER_INV_SQL} ${period ? 'WHERE i.period=?' : ''}`).all(...(period ? [period] : []));
    const m = {}; for (const r of rows) m[r.tid] = r2((m[r.tid] || 0) + r.settled); return m;
  };
  // 11100 debit = who got newly charged this month and is still unpaid as of it
  if (account === '11100' && side === 'debit') {
    const settled = settledByTenant();
    // this month's invoice charges, per tenant, with a representative unit
    const charges = db.prepare(
      `SELECT i.tenant_id tid, t.name party, MAX(f.code) flat, COALESCE(SUM(i.total),0) charged
         FROM invoices i JOIN tenants t ON t.id=i.tenant_id LEFT JOIN flats f ON f.id=i.flat_id
        WHERE i.period=? GROUP BY i.tenant_id`).all(period);
    const out = charges.map((x) => ({ party: x.party, flat: x.flat, ref: 'استحقاق ' + period, amount: r2(x.charged - (settled[x.tid] || 0)) }))
      .filter((x) => x.amount > 0.005);
    // non-invoice debits on 11100 (opening receivable / adjustments) so the drill
    // always ties to the report line, with the customer's name shown.
    const other = db.prepare(
      `SELECT COALESCE(t.name,'—') party, f.code flat, COALESCE(SUM(l.debit),0) d
         FROM journal_lines l JOIN journals j ON j.id=l.journal_id
         LEFT JOIN tenants t ON t.id=l.tenant_id LEFT JOIN flats f ON f.id=l.flat_id
        WHERE l.account_code='11100' AND substr(j.jdate,1,7)=?
          AND j.jtype NOT IN ('invoice','recognition','adjustment')
        GROUP BY t.name, f.code`).all(period);
    for (const o of other) if (o.d > 0.005) out.push({ party: o.party, flat: o.flat, ref: 'رصيد افتتاحي', amount: r2(o.d) });
    out.sort((a, b) => b.amount - a.amount);
    return { account, period, side, kind: 'unpaid', rows: out, total: r2(out.reduce((s, x) => s + x.amount, 0)) };
  }
  // 11100 credit = who paid down OLD dues = this month's credits − same-month settlement of this month's own invoices
  if (account === '11100' && side === 'credit') {
    const settled = settledByTenant();
    const credits = db.prepare(
      `SELECT l.tenant_id tid, t.name party,
              COALESCE(MAX(f.code), (SELECT fl.code FROM contracts cc JOIN flats fl ON fl.id=cc.flat_id
                                      WHERE cc.tenant_id=l.tenant_id ORDER BY (cc.status='active') DESC LIMIT 1)) flat,
              COALESCE(SUM(l.credit),0) c
       FROM journal_lines l JOIN journals j ON j.id=l.journal_id LEFT JOIN tenants t ON t.id=l.tenant_id
       LEFT JOIN flats f ON f.id=l.flat_id
       WHERE l.account_code='11100' AND substr(j.jdate,1,7)=? GROUP BY l.tenant_id`).all(period);
    const out = credits.map((r) => ({ party: r.party || '—', flat: r.flat, amount: r2(r.c - (settled[r.tid] || 0)) }))
      .filter((x) => Math.abs(x.amount) > 0.005).sort((a, b) => b.amount - a.amount);
    return { account, period, side, kind: 'old', rows: out, total: r2(out.reduce((s, x) => s + x.amount, 0)) };
  }
  // general: break the amount down per tenant/vendor for that account+side+month
  const rows = db.prepare(
    `SELECT COALESCE(t.name, v.name, '—') party,
            COALESCE(f.code, (SELECT fl.code FROM contracts cc JOIN flats fl ON fl.id=cc.flat_id
                               WHERE cc.tenant_id=l.tenant_id ORDER BY (cc.status='active') DESC LIMIT 1)) flat,
            COALESCE(SUM(l.debit),0) d, COALESCE(SUM(l.credit),0) c
     FROM journal_lines l JOIN journals j ON j.id=l.journal_id
     LEFT JOIN tenants t ON t.id=l.tenant_id LEFT JOIN vendors v ON v.id=l.vendor_id LEFT JOIN flats f ON f.id=l.flat_id
     WHERE l.account_code=? AND substr(j.jdate,1,7)=?
     GROUP BY party, flat`).all(account, period);
  const out = rows.map((r) => ({ party: r.party, flat: r.flat, amount: side === 'debit' ? r2(r.d) : r2(r.c) }))
    .filter((x) => Math.abs(x.amount) > 0.005).sort((a, b) => b.amount - a.amount);
  return { account, period, side, kind: 'general', rows: out, total: r2(out.reduce((s, x) => s + x.amount, 0)) };
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

// ---- "Where's my money?" / "Where did the retained earnings go?" ----------
// Plain-language reconciliation: cash in hand right now, what's still owed BY
// customers, what's still owed TO vendors/deposits, and how much of the
// company's accumulated profit is tied up in receivables/fixed-assets instead
// of sitting in the bank. Built from the same balance-sheet/liquidity figures
// as the other reports, just relabeled for a non-accountant to read directly.
function moneyPosition(upto, lang = 'en') {
  const bs = balanceSheet(upto, lang);
  const liq = liquidityReport(upto, lang);
  const recvCodes = new Set([CFG.acct('tenant_recv'), CFG.acct('ar')].filter(Boolean));
  const heldCodes = new Set([CFG.acct('deposits_held'), CFG.acct('deferred_advance'), CFG.acct('customer_advance')].filter(Boolean));
  const payCode = CFG.acct('vendor_payable');
  const sumAmt = (rows) => r2(rows.reduce((s, x) => s + x.amt, 0));

  const receivables = bs.assets.filter((a) => recvCodes.has(a.code));
  const fixedAssets = bs.assets.filter((a) => FIXED_ASSET_CODES.includes(a.code));
  const otherAssets = bs.assets.filter((a) => !CASH_CODES.includes(a.code) && !recvCodes.has(a.code) && !FIXED_ASSET_CODES.includes(a.code));
  const held = bs.liabilities.filter((l) => heldCodes.has(l.code));
  const payables = bs.liabilities.filter((l) => l.code === payCode);
  const otherLiabilities = bs.liabilities.filter((l) => !heldCodes.has(l.code) && l.code !== payCode);

  const cash = r2(liq.cash);
  const receivables_total = sumAmt(receivables);
  const held_total = sumAmt(held);
  const payables_total = sumAmt(payables);
  const other_liab_total = sumAmt(otherLiabilities);
  const fixed_total = sumAmt(fixedAssets);
  const other_assets_total = sumAmt(otherAssets);
  // what's actually "mine to spend": cash + what customers owe me − what I owe
  // vendors − deposits/advances I'm only holding on their behalf
  const net_liquid_position = r2(cash + receivables_total - held_total - payables_total - other_liab_total);

  // Retained earnings: specific equity accounts by code (real chart), falling
  // back to "everything in equity that isn't opening/paid-in capital" if the
  // chart differs.
  const retRow = bs.equity.find((e) => e.code === '39005') || bs.equity.find((e) => /retain|محتجز|مدور/i.test(e.name));
  const divRow = bs.equity.find((e) => e.code === '39007') || bs.equity.find((e) => /dividend|توزيع/i.test(e.name));
  const capital_total = sumAmt(bs.equity.filter((e) => e.code !== (retRow && retRow.code) && e.code !== (divRow && divRow.code)));
  const retained_earnings = r2((retRow ? retRow.amt : 0) + bs.net_income); // net_income not yet closed into the RE account
  // Dividends actually paid: some setups post them to a dedicated contra
  // account (39007 above); this one posts them straight against Retained
  // Earnings itself (a debit, tagged by memo — "... DIVIDEND ..." / "توزيع"),
  // so a bare divRow balance alone would miss them entirely. Sum both.
  const dividendMemoDebits = (code) => {
    if (!code) return 0;
    const row = db.prepare(
      `SELECT COALESCE(SUM(l.debit),0) d FROM journal_lines l JOIN journals j ON j.id=l.journal_id
        WHERE l.account_code=? ${upto ? 'AND j.jdate<=?' : ''} AND (j.memo LIKE '%dividend%' OR j.memo_ar LIKE '%توزيع%')`)
      .get(...[code, ...(upto ? [upto] : [])]);
    return r2(row.d);
  };
  const dividends_paid_life = r2((divRow ? -divRow.amt : 0) + dividendMemoDebits(retRow && retRow.code)); // dividends are a debit/contra in equity, shown here as a positive "paid out" figure

  return {
    upto, cash, receivables, receivables_total, held, held_total, payables, payables_total,
    other_liabilities: otherLiabilities, other_liab_total, other_assets: otherAssets, other_assets_total,
    net_liquid_position, fixed_assets: fixedAssets, fixed_total,
    total_equity: bs.total_equity, net_income_to_date: bs.net_income,
    retained_earnings, dividends_paid_life, capital_total,
    // reconciliation: retained earnings live partly in cash, partly in receivables,
    // partly invested in fixed assets, net of what's owed to vendors/held for others.
    tied_up_in_receivables: receivables_total, tied_up_in_fixed_assets: fixed_total,
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

// ---- Full IFRS-style financial statements (comparative: current vs prior) --
// Returns the classified Balance Sheet, Income/Comprehensive Income, Statement of
// Changes in Equity and (indirect) Cash Flow, each with current & prior-year figures.
function financialStatements(year, lang = 'en') {
  year = Number(year) || new Date().getFullYear();
  const endCur = `${year}-12-31`, endPrev = `${year - 1}-12-31`;
  const startCur = `${year}-01-01`, startPrev = `${year - 1}-01-01`;
  const bsC = balanceSheet(endCur, lang), bsP = balanceSheet(endPrev, lang);
  const isC = incomeStatement(startCur, endCur, lang), isP = incomeStatement(startPrev, endPrev, lang);
  const merge = (aCur, aPrev) => {
    const m = {};
    for (const x of aCur) m[x.code] = { code: x.code, name: x.name, cur: r2(x.amt), prev: 0 };
    for (const x of aPrev) { (m[x.code] = m[x.code] || { code: x.code, name: x.name, cur: 0, prev: 0 }).prev = r2(x.amt); }
    return Object.values(m).sort((a, b) => a.code.localeCompare(b.code));
  };
  const sum = (rows, k) => r2(rows.reduce((s, x) => s + (x[k] || 0), 0));
  const pair = (cur, prev) => ({ cur: r2(cur), prev: r2(prev) });

  const NONCUR_ASSET = new Set(FIXED_ASSET_CODES);
  const NONCUR_LIAB = new Set(['21000', '25000', '26000', '27000']); // deposits held + long-term loans
  const cashCodes = new Set(CASH_CODES);
  const assetsAll = merge(bsC.assets, bsP.assets);
  const liabAll = merge(bsC.liabilities, bsP.liabilities);
  const equityAll = merge(bsC.equity, bsP.equity);
  const ncAssets = assetsAll.filter((x) => NONCUR_ASSET.has(x.code));
  const cAssets = assetsAll.filter((x) => !NONCUR_ASSET.has(x.code));
  const ncLiab = liabAll.filter((x) => NONCUR_LIAB.has(x.code));
  const cLiab = liabAll.filter((x) => !NONCUR_LIAB.has(x.code));
  const retName = lang === 'ar' ? 'الأرباح المُدوّرة' : 'Retained Earnings';
  const equityRows = [...equityAll, { code: 'RET', name: retName, cur: r2(bsC.total_equity - sum(equityAll, 'cur')), prev: r2(bsP.total_equity - sum(equityAll, 'prev')) }];

  const balance_sheet = {
    non_current_assets: ncAssets, current_assets: cAssets,
    total_non_current_assets: pair(sum(ncAssets, 'cur'), sum(ncAssets, 'prev')),
    total_current_assets: pair(sum(cAssets, 'cur'), sum(cAssets, 'prev')),
    total_assets: pair(bsC.total_assets, bsP.total_assets),
    equity: equityRows, total_equity: pair(bsC.total_equity, bsP.total_equity),
    non_current_liabilities: ncLiab, current_liabilities: cLiab,
    total_non_current_liabilities: pair(sum(ncLiab, 'cur'), sum(ncLiab, 'prev')),
    total_current_liabilities: pair(sum(cLiab, 'cur'), sum(cLiab, 'prev')),
    total_liabilities: pair(bsC.total_liabilities, bsP.total_liabilities),
    total_equity_liabilities: pair(r2(bsC.total_equity + bsC.total_liabilities), r2(bsP.total_equity + bsP.total_liabilities)),
  };
  const income = {
    revenue: merge(isC.income, isP.income), expenses: merge(isC.expense, isP.expense),
    total_revenue: pair(isC.total_income, isP.total_income),
    total_expenses: pair(isC.total_expense, isP.total_expense),
    net: pair(isC.net, isP.net),
  };
  const equity = {
    opening: pair(bsP.total_equity, balanceSheet(`${year - 2}-12-31`, lang).total_equity),
    net: pair(isC.net, isP.net), closing: pair(bsC.total_equity, bsP.total_equity),
  };
  // reconciling line: capital introduced / opening balances / other equity moves
  // = closing − opening − net (so opening + net + capital = closing exactly).
  equity.capital = { cur: r2(equity.closing.cur - equity.opening.cur - equity.net.cur), prev: r2(equity.closing.prev - equity.opening.prev - equity.net.prev) };
  // ---- Cash flow (indirect) ----
  const cashBal = (upto) => r2(balanceSheet(upto, lang).assets.filter((x) => cashCodes.has(x.code)).reduce((s, x) => s + x.amt, 0));
  const cashStart = cashBal(endPrev), cashEnd = cashBal(endCur);
  const dep = r2((isC.expense.find((x) => /depre|إهلاك|اهلاك/i.test(x.name)) || {}).amt || 0);
  const wcAssetCur = r2(cAssets.reduce((s, x) => s + (cashCodes.has(x.code) ? 0 : x.cur), 0));
  const wcAssetPrev = r2(cAssets.reduce((s, x) => s + (cashCodes.has(x.code) ? 0 : x.prev), 0));
  const dRecv = r2(wcAssetCur - wcAssetPrev);
  const dPay = r2(sum(cLiab, 'cur') - sum(cLiab, 'prev'));
  const operating = r2(isC.net + dep - dRecv + dPay);
  const dNCA = r2(sum(ncAssets, 'cur') - sum(ncAssets, 'prev'));
  const investing = r2(-dNCA);
  const financing = r2((sum(equityAll, 'cur') - sum(equityAll, 'prev')) + (sum(ncLiab, 'cur') - sum(ncLiab, 'prev')));
  const net_change = r2(operating + investing + financing);
  const cash_flow = {
    net_income: r2(isC.net), depreciation: dep, change_receivables: r2(-dRecv), change_payables: dPay,
    operating, investing, financing, net_change, cash_start: cashStart,
    cash_end_computed: r2(cashStart + net_change), cash_end_actual: cashEnd,
    reconciles: Math.abs(r2(cashStart + net_change) - cashEnd) < 1,
  };
  return { year, prev_year: year - 1, currency: 'OMR', end_cur: endCur, end_prev: endPrev, balance_sheet, income, equity, cash_flow };
}

// ---- Receivables aging (GL-based: ties to the trial balance) ---------------
// Built from the customer receivable accounts (11000/11100) so it INCLUDES the
// opening balances (posted as journals, not invoices). Each debit "charge"
// (invoice / opening / manual) is aged by its date; total credits (collections)
// are consumed oldest-first. The grand total therefore equals the net receivable
// in the trial balance for these accounts.
function receivablesAging(asOf, building_id) {
  const ref = asOf || new Date().toISOString().slice(0, 10);
  const RECV = ['11000', '11100'];
  const list = RECV.map(() => '?').join(',');
  const bF = building_id ? ' AND l.building_id=' + Number(building_id) : '';
  // charges = debit entries (dated), credits = collections (netted oldest-first)
  const charges = db.prepare(
    `SELECT l.tenant_id, COALESCE(t.name,'(بدون عميل)') tenant, j.jdate, l.debit amt
     FROM journal_lines l JOIN journals j ON j.id=l.journal_id LEFT JOIN tenants t ON t.id=l.tenant_id
     WHERE l.account_code IN (${list}) AND l.debit>0.005 AND j.jdate<=? ${bF}
     ORDER BY j.jdate ASC, j.id ASC`).all(...RECV, ref);
  const credits = db.prepare(
    `SELECT l.tenant_id, COALESCE(SUM(l.credit),0) c
     FROM journal_lines l JOIN journals j ON j.id=l.journal_id
     WHERE l.account_code IN (${list}) AND l.credit>0.005 AND j.jdate<=? ${bF}
     GROUP BY l.tenant_id`).all(...RECV, ref);
  const credByT = {}; for (const c of credits) credByT[c.tenant_id || 0] = r2(c.c);

  const days = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / 86400000);
  const chargesByT = {};
  for (const ch of charges) { const k = ch.tenant_id || 0; (chargesByT[k] = chargesByT[k] || { tenant: ch.tenant, items: [] }).items.push(ch); }

  const byT = {}; const totals = { current: 0, d30: 0, d60: 0, d90: 0, d180: 0, d180p: 0 };
  for (const [k, g] of Object.entries(chargesByT)) {
    let credit = credByT[k] || 0;               // consume collections oldest-first
    const row = { tenant_id: k === '0' ? null : Number(k), tenant: g.tenant, current: 0, d30: 0, d60: 0, d90: 0, d180: 0, d180p: 0, total: 0 };
    for (const ch of g.items) {
      let rem = r2(ch.amt);
      if (credit > 0) { const used = r2(Math.min(credit, rem)); rem = r2(rem - used); credit = r2(credit - used); }
      if (rem <= 0.005) continue;
      const age = days(ch.jdate, ref);
      let b = 'current';
      if (age > 180) b = 'd180p'; else if (age > 90) b = 'd180'; else if (age > 60) b = 'd90';
      else if (age > 30) b = 'd60'; else if (age > 0) b = 'd30';
      row[b] = r2(row[b] + rem); row.total = r2(row.total + rem); totals[b] = r2(totals[b] + rem);
    }
    if (row.total > 0.005) byT[k] = row;
  }
  const listRows = Object.values(byT).sort((a, b) => b.total - a.total);
  return { asOf: ref, rows: listRows, totals, grand_total: r2(listRows.reduce((s, x) => s + x.total, 0)) };
}

// ---- Drill for one aging cell: which specific charges (invoices/openings) --
// make up a tenant's outstanding balance, aged the same way receivablesAging
// buckets them — so clicking any number in that report shows exactly where
// it came from instead of just a total.
function receivablesAgingDrill(tenant_id, asOf, building_id) {
  const ref = asOf || new Date().toISOString().slice(0, 10);
  const RECV = ['11000', '11100'];
  const list = RECV.map(() => '?').join(',');
  const bF = building_id ? ' AND l.building_id=' + Number(building_id) : '';
  const tf = tenant_id ? 'l.tenant_id=?' : 'l.tenant_id IS NULL';
  const tp = tenant_id ? [tenant_id] : [];
  const charges = db.prepare(
    `SELECT j.id journal_id, j.jdate, j.jtype, j.reference, j.memo_ar, l.debit amt, f.code flat
       FROM journal_lines l JOIN journals j ON j.id=l.journal_id LEFT JOIN flats f ON f.id=l.flat_id
      WHERE l.account_code IN (${list}) AND ${tf} AND l.debit>0.005 AND j.jdate<=? ${bF}
      ORDER BY j.jdate ASC, j.id ASC`).all(...RECV, ...tp, ref);
  const creditRow = db.prepare(
    `SELECT COALESCE(SUM(l.credit),0) c FROM journal_lines l JOIN journals j ON j.id=l.journal_id
      WHERE l.account_code IN (${list}) AND ${tf} AND l.credit>0.005 AND j.jdate<=? ${bF}`).get(...RECV, ...tp, ref);
  let credit = r2(creditRow.c);
  const days = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / 86400000);
  const rows = [];
  for (const ch of charges) {
    let rem = r2(ch.amt);
    if (credit > 0) { const used = r2(Math.min(credit, rem)); rem = r2(rem - used); credit = r2(credit - used); }
    if (rem <= 0.005) continue;
    const age = days(ch.jdate, ref);
    let bucket = 'current';
    if (age > 180) bucket = 'd180p'; else if (age > 90) bucket = 'd180'; else if (age > 60) bucket = 'd90';
    else if (age > 30) bucket = 'd60'; else if (age > 0) bucket = 'd30';
    rows.push({ journal_id: ch.journal_id, jdate: ch.jdate, jtype: ch.jtype, reference: ch.reference, memo: ch.memo_ar, flat: ch.flat, amount: rem, bucket, age });
  }
  return { tenant_id: tenant_id || null, asOf: ref, rows, total: r2(rows.reduce((s, x) => s + x.amount, 0)) };
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
  const bp = []; let base = '1=1';
  if (flat_id) { base += ' AND l.flat_id=?'; bp.push(flat_id); }
  if (tenant_id) { base += ' AND l.tenant_id=?'; bp.push(tenant_id); }
  if (building_id) { base += ' AND l.building_id=?'; bp.push(building_id); }
  const list = CUSTOMER_ACCOUNTS.map(() => '?').join(',');
  // opening balance = net of the customer accounts strictly before `from`
  let opening = 0;
  if (from) {
    const orow = db.prepare(
      `SELECT COALESCE(SUM(l.debit),0)-COALESCE(SUM(l.credit),0) bal
       FROM journal_lines l JOIN journals j ON j.id=l.journal_id
       WHERE ${base} AND l.account_code IN (${list}) AND j.jdate < ?`).get(...bp, ...CUSTOMER_ACCOUNTS, from);
    opening = r2(orow.bal);
  }
  const p = [...bp]; let where = base;
  if (from) { where += ' AND j.jdate>=?'; p.push(from); }
  if (to) { where += ' AND j.jdate<=?'; p.push(to); }
  const lines = db.prepare(
    `SELECT j.jdate, j.jtype, j.reference, j.memo, l.account_code, ${nameCol(lang)} account_name,
            l.debit, l.credit, l.tenant_id, t.name tenant, l.flat_id, f.code flat
     FROM journal_lines l JOIN journals j ON j.id=l.journal_id JOIN accounts a ON a.code=l.account_code
     LEFT JOIN tenants t ON t.id=l.tenant_id LEFT JOIN flats f ON f.id=l.flat_id
     WHERE ${where} AND l.account_code IN (${list}) ORDER BY j.jdate, j.id, l.id`).all(...p, ...CUSTOMER_ACCOUNTS);
  let running = opening;
  const withBal = lines.map((ln) => { running = r2(running + ln.debit - ln.credit); return { ...ln, balance: running }; });
  const td = r2(lines.reduce((s, x) => s + x.debit, 0)), tc = r2(lines.reduce((s, x) => s + x.credit, 0));
  return { opening: r2(opening), lines: withBal, total_debit: td, total_credit: tc, balance: r2(opening + td - tc) };
}

// ---- Vendor statement (opening + movements + running balance) -------------
const VENDOR_ACCOUNTS = ['20000', '23000'];
function vendorStatement({ vendor_id, from, to }, lang = 'en') {
  const list = VENDOR_ACCOUNTS.map(() => '?').join(',');
  let opening = 0;
  if (from && vendor_id) {
    const orow = db.prepare(
      `SELECT COALESCE(SUM(l.credit),0)-COALESCE(SUM(l.debit),0) bal
       FROM journal_lines l JOIN journals j ON j.id=l.journal_id
       WHERE l.vendor_id=? AND l.account_code IN (${list}) AND j.jdate < ?`).get(vendor_id, ...VENDOR_ACCOUNTS, from);
    opening = r2(orow.bal);
  }
  const p = [vendor_id]; let where = 'l.vendor_id=?';
  if (from) { where += ' AND j.jdate>=?'; p.push(from); }
  if (to) { where += ' AND j.jdate<=?'; p.push(to); }
  const lines = db.prepare(
    `SELECT j.id journal_id, j.jdate, j.jtype, j.reference, j.memo, l.account_code, ${nameCol(lang)} account_name,
            l.debit, l.credit, v.name vendor
     FROM journal_lines l JOIN journals j ON j.id=l.journal_id JOIN accounts a ON a.code=l.account_code
     LEFT JOIN vendors v ON v.id=l.vendor_id
     WHERE ${where} AND l.account_code IN (${list}) ORDER BY j.jdate, j.id, l.id`).all(...p, ...VENDOR_ACCOUNTS);
  // vendor payable is a credit balance -> running as credit-debit
  let running = opening;
  const withBal = lines.map((ln) => { running = r2(running + ln.credit - ln.debit); return { journal_id: ln.journal_id, jdate: ln.jdate, reference: ln.reference, account_name: ln.account_name, memo: ln.memo, vendor: ln.vendor, debit: r2(ln.debit), credit: r2(ln.credit), balance: running }; });
  const td = r2(lines.reduce((s, x) => s + x.debit, 0)), tc = r2(lines.reduce((s, x) => s + x.credit, 0));
  return { opening: r2(opening), lines: withBal, total_debit: td, total_credit: tc, balance: r2(opening + tc - td) };
}

// ---- Advances / credit customers ("الذمم الدائنة (مقدم)") ------------------
// Full customer-advance balance (21500 + 23100), as of an optional date, so it
// mirrors the receivables report and ties to the trial balance for those codes.
function advancesReport(asOf) {
  const ref = asOf || new Date().toISOString().slice(0, 10);
  const rows = db.prepare(
    `SELECT t.id, t.name tenant, t.phone,
        COALESCE(SUM(CASE WHEN l.account_code='23100' THEN l.credit-l.debit ELSE 0 END),0) deferred,
        COALESCE(SUM(CASE WHEN l.account_code='21500' THEN l.credit-l.debit ELSE 0 END),0) legacy,
        COALESCE(SUM(CASE WHEN l.account_code IN ('21500','23100') THEN l.credit-l.debit ELSE 0 END),0) advance
     FROM tenants t JOIN journal_lines l ON l.tenant_id=t.id
     JOIN journals j ON j.id=l.journal_id
     WHERE j.jdate<=?
     GROUP BY t.id HAVING advance > 0.005 ORDER BY advance DESC`).all(ref);
  return { asOf: ref, rows: rows.map((r) => ({ ...r, deferred: r2(r.deferred), legacy: r2(r.legacy), advance: r2(r.advance) })),
    grand_total: r2(rows.reduce((s, r) => s + r.advance, 0)) };
}

// ---- Balance persistence ("تاريخ الذمم") -----------------------------------
// A standard aging report answers "which invoices are still open, and how
// old are THEY" — it can't answer "how long has this customer's balance
// never dropped below what it is right now", because paying down an old
// invoice with a new payment (FIFO) makes the SPECIFIC open invoice rotate
// to a newer one even while the total owed never shrinks. This walks each
// customer's own running balance (receivable minus advance, same accounts as
// the tenant statement) backward from `asOf` and finds the earliest date
// after which the balance never crossed back below its current level (or,
// for a customer sitting on an advance, never came back above it) — i.e.
// "stuck at at least this much since day X".
function receivablesBalancePersistence(asOf, building_id) {
  const ref = asOf || new Date().toISOString().slice(0, 10);
  const list = CUSTOMER_ACCOUNTS.map(() => '?').join(',');
  const bF = building_id ? ' AND l.building_id=' + Number(building_id) : '';
  const lines = db.prepare(
    `SELECT l.tenant_id, COALESCE(t.name,'(بدون عميل)') tenant, j.jdate, l.debit, l.credit
       FROM journal_lines l JOIN journals j ON j.id=l.journal_id LEFT JOIN tenants t ON t.id=l.tenant_id
      WHERE l.account_code IN (${list}) AND j.jdate<=? ${bF} AND l.tenant_id IS NOT NULL
      ORDER BY l.tenant_id, j.jdate ASC, j.id ASC`).all(...CUSTOMER_ACCOUNTS, ref);
  const byT = {};
  for (const ln of lines) (byT[ln.tenant_id] = byT[ln.tenant_id] || { tenant: ln.tenant, points: [] }).points.push(ln);

  const days = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / 86400000);
  const rows = [];
  for (const [tid, g] of Object.entries(byT)) {
    // one running-balance checkpoint per calendar day (last balance that day)
    let running = 0; const checkpoints = [];
    for (const p of g.points) {
      running = r2(running + p.debit - p.credit);
      const last = checkpoints[checkpoints.length - 1];
      if (last && last.jdate === p.jdate) last.balance = running; else checkpoints.push({ jdate: p.jdate, balance: running });
    }
    const current = checkpoints.length ? checkpoints[checkpoints.length - 1].balance : 0;
    if (Math.abs(current) <= 0.005) continue; // settled — nothing persisting
    const positive = current > 0; // true = owes us (receivable), false = we hold an advance
    let sinceIdx = checkpoints.length - 1;
    for (let i = checkpoints.length - 2; i >= 0; i--) {
      const bal = checkpoints[i].balance;
      const holds = positive ? bal >= current - 0.005 : bal <= current + 0.005;
      if (holds) sinceIdx = i; else break;
    }
    const sinceDate = checkpoints[sinceIdx].jdate;
    rows.push({
      tenant_id: Number(tid), tenant: g.tenant, balance: current, kind: positive ? 'receivable' : 'advance',
      since: sinceDate, days_persisted: days(sinceDate, ref),
    });
  }
  rows.sort((a, b) => b.days_persisted - a.days_persisted);
  return { asOf: ref, rows };
}

// ---- Invoice vs Contract audit --------------------------------------------
// Recomputes what each invoice's rent/VAT SHOULD be from its OWN contract's
// current terms (the exact same day-based proration `issueInvoiceForContract`
// applies), and flags any invoice that drifted from that — e.g. a contract was
// edited/renewed AFTER its invoices for later months were already issued, so
// the old rent kept being billed. Catches the class of bug found 2026-09-22
// (SHOP 2 / MADTHQ ALJOOD: contract renewed 1400→1200 but 3 already-issued
// invoices kept billing the old amount) automatically instead of by accident.
function invoiceContractAudit(building_id) {
  const { expectedRentForPeriod } = require('./services');
  const rows = db.prepare(
    `SELECT i.id, i.invoice_no, i.period, i.rent_amount, i.vat_amount, i.total, i.paid_amount, i.status,
            c.id contract_id, c.contract_no, c.monthly_rent, c.vat_percent, c.start_date, c.end_date,
            t.name tenant, f.code flat, b.name building
       FROM invoices i
       JOIN contracts c ON c.id = i.contract_id
       JOIN tenants t ON t.id = i.tenant_id
       LEFT JOIN flats f ON f.id = i.flat_id
       LEFT JOIN buildings b ON b.id = i.building_id
      WHERE i.status != 'cancelled' ${building_id ? 'AND i.building_id=' + Number(building_id) : ''}
      ORDER BY i.period`).all();
  const out = [];
  for (const r of rows) {
    const expectedRent = expectedRentForPeriod(
      { monthly_rent: r.monthly_rent, start_date: r.start_date, end_date: r.end_date }, r.period);
    const expectedVat = r2(expectedRent * (r.vat_percent || 0) / 100);
    const expectedTotal = r2(expectedRent + expectedVat);
    const diff = r2(r.total - expectedTotal);
    if (Math.abs(diff) <= 0.5) continue;
    out.push({
      id: r.id, invoice_no: r.invoice_no, period: r.period, tenant: r.tenant, flat: r.flat, building: r.building,
      contract_id: r.contract_id, contract_no: r.contract_no, status: r.status, paid_amount: r.paid_amount,
      actual_rent: r.rent_amount, actual_vat: r.vat_amount, actual_total: r.total,
      expected_rent: expectedRent, expected_vat: expectedVat, expected_total: expectedTotal, diff,
    });
  }
  out.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  return { rows: out, count: out.length, total_diff: r2(out.reduce((s, x) => s + x.diff, 0)) };
}

// ---- Audit Center: automated integrity checks + KPIs for external audit prep
function auditCenter(asOf, building_id) {
  const ref = asOf || new Date().toISOString().slice(0, 10);
  const yearStart = ref.slice(0, 4) + '-01-01';
  const checks = [];

  const tb = trialBalance(ref);
  checks.push({ key: 'trial_balance', label: 'ميزان المراجعة متوازن (مدين = دائن)', status: tb.balanced ? 'ok' : 'bad',
    detail: `مدين ${tb.total_debit} — دائن ${tb.total_credit}`, link: '#/tb' });

  const unbalanced = db.prepare(
    `SELECT j.id FROM journals j JOIN journal_lines l ON l.journal_id=j.id
      GROUP BY j.id HAVING ABS(ROUND(SUM(l.debit)-SUM(l.credit),3)) > 0.005`).all();
  checks.push({ key: 'journal_balance', label: 'كل قيد متزن (مدين = دائن) لوحده', status: unbalanced.length ? 'bad' : 'ok',
    detail: unbalanced.length ? `${unbalanced.length} قيد غير متزن` : 'كل القيود متزنة', count: unbalanced.length, link: '#/journals' });

  const audit = invoiceContractAudit(building_id);
  checks.push({ key: 'invoice_contract', label: 'الفواتير مطابقة لشروط عقودها الحالية', status: audit.count ? 'warn' : 'ok',
    detail: audit.count ? `${audit.count} فاتورة بفرق إجمالي ${audit.total_diff}` : 'كل الفواتير مطابقة لعقودها',
    count: audit.count, amount: audit.total_diff });

  const RECV = ['11000', '11100'];
  const glRecv = r2(db.prepare(
    `SELECT COALESCE(SUM(l.debit)-SUM(l.credit),0) bal FROM journal_lines l JOIN journals j ON j.id=l.journal_id
      WHERE l.account_code IN (${RECV.map(() => '?').join(',')}) AND j.jdate<=? ${building_id ? 'AND l.building_id=' + Number(building_id) : ''}`)
    .get(...RECV, ref).bal);
  const aging = receivablesAging(ref, building_id);
  const arGap = r2(aging.grand_total - glRecv);
  // small gaps can be cumulative rounding from the FIFO oldest-first sweep across
  // many transactions, not a real data error — only flag 'bad' once it's material.
  const arStatus = Math.abs(arGap) <= 1 ? 'ok' : (Math.abs(arGap) <= 50 ? 'warn' : 'bad');
  checks.push({ key: 'ar_tieout', label: 'أعمار الذمم المدينة = رصيد حساب الذمم بالأستاذ', status: arStatus,
    detail: `الأعمار ${aging.grand_total} — الأستاذ ${glRecv}${Math.abs(arGap) > 1 ? ' — فرق ' + arGap : ''}`, link: '#/ar_aging' });

  const vr = vatReturn(yearStart, ref);
  const vatDocVsLedger = r2(vr.box1a.vat - vr.box5_output);
  const vatOk = Math.abs(vatDocVsLedger) <= 0.5 && Math.abs(vr.box6_reconciliation_gap) <= 0.5;
  checks.push({ key: 'vat', label: 'ضريبة القيمة المضافة (الفواتير مقابل الأستاذ)', status: vatOk ? 'ok' : 'warn',
    detail: `مخرجات: فواتير ${vr.box1a.vat} / أستاذ ${vr.box5_output} — فجوة مدخلات غير موثّقة: ${vr.box6_reconciliation_gap}`,
    link: '#/vat_statement' });

  const unrecon = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(debit+credit),0) amt FROM bank_statement_lines WHERE reconciled=0 AND txn_date<=?`).get(ref);
  checks.push({ key: 'bank_recon', label: 'التسوية البنكية', status: unrecon.c ? 'warn' : 'ok',
    detail: unrecon.c ? `${unrecon.c} حركة غير مسواة بقيمة ${r2(unrecon.amt)}` : 'كل الحركات متسواة', count: unrecon.c, link: '#/reconciliation' });

  const cheq = chequesDashboard(ref);
  const overdueCount = cheq.incoming.overdue.count + cheq.outgoing.overdue.count;
  checks.push({ key: 'cheques', label: 'الشيكات المعلّقة', status: overdueCount ? 'warn' : 'ok',
    detail: `متأخرة: ${overdueCount} — تحت التحصيل ${cheq.incoming.pending_total} — تحت الدفع ${cheq.outgoing.pending_total}`, link: '#/cheques_dash' });

  const expiring = contractExpiry(60, building_id);
  checks.push({ key: 'contract_expiry', label: 'عقود قاربت على الانتهاء (خلال 60 يوم)', status: expiring.length ? 'warn' : 'ok',
    detail: expiring.length ? `${expiring.length} عقد` : 'لا يوجد', count: expiring.length, link: '#/contracts' });

  const assets = depreciationReport(building_id);
  const badAssets = assets.filter((a) => a.accum_depreciation > a.depreciable + 0.5);
  checks.push({ key: 'assets', label: 'سجل الأصول الثابتة سليم', status: badAssets.length ? 'bad' : 'ok',
    detail: badAssets.length ? `${badAssets.length} أصل مجمّع إهلاكه أكتر من تكلفته` : 'كل الأصول سليمة', count: badAssets.length, link: '#/depreciation' });

  const bankCodes = [...new Set(db.prepare('SELECT gl_account FROM banks').all().map((b) => b.gl_account).filter(Boolean).concat([CFG.acct('cash')]))];
  const cashBal = r2(db.prepare(
    `SELECT COALESCE(SUM(l.debit)-SUM(l.credit),0) bal FROM journal_lines l JOIN journals j ON j.id=l.journal_id
      WHERE l.account_code IN (${bankCodes.map(() => '?').join(',')}) AND j.jdate<=?`).get(...bankCodes, ref).bal);
  const apTotal = payablesAging(ref).grand_total;
  const advAccts = ['21500', '23100'];
  const advBal = r2(db.prepare(
    `SELECT COALESCE(SUM(l.credit)-SUM(l.debit),0) bal FROM journal_lines l WHERE l.account_code IN (${advAccts.map(() => '?').join(',')}) AND l.tenant_id IS NOT NULL`)
    .get(...advAccts).bal);

  return {
    asOf: ref, checks,
    ok_count: checks.filter((c) => c.status === 'ok').length,
    warn_count: checks.filter((c) => c.status === 'warn').length,
    bad_count: checks.filter((c) => c.status === 'bad').length,
    kpis: { receivable: glRecv, payable: apTotal, advances_held: advBal, cash_and_bank: cashBal },
  };
}

// ---- Customers summary (all customers, balances) -------------------------
function customersSummary() {
  const rows = db.prepare(
    `SELECT t.id, t.name tenant, t.phone,
        COALESCE(SUM(CASE WHEN l.account_code IN ('11000','11100') THEN l.debit-l.credit ELSE 0 END),0) receivable,
        COALESCE(SUM(CASE WHEN l.account_code IN ('21500','23100') THEN l.credit-l.debit ELSE 0 END),0) advance
     FROM tenants t LEFT JOIN journal_lines l ON l.tenant_id=t.id
     GROUP BY t.id ORDER BY receivable DESC`).all();
  // units are fetched separately (not joined above) so the fan-out from
  // multiple active contracts per tenant doesn't multiply the SUM() rows
  const unitsByTenant = {};
  for (const u of db.prepare(
    `SELECT c.tenant_id, f.code FROM contracts c JOIN flats f ON f.id=c.flat_id WHERE c.status='active'`).all())
    (unitsByTenant[u.tenant_id] = unitsByTenant[u.tenant_id] || []).push(u.code);
  return rows.map((r) => ({ ...r, receivable: r2(r.receivable), advance: r2(r.advance), net: r2(r.receivable - r.advance),
      units: (unitsByTenant[r.id] || []).join('، ') }))
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
  // excludes vat_settlement journals — a settlement clears prior VAT, it isn't new
  // VAT activity, so it shouldn't count as this period's output/input movement.
  const bal = (code) => db.prepare(
    `SELECT COALESCE(SUM(l.credit),0) c, COALESCE(SUM(l.debit),0) d
     FROM journal_lines l JOIN journals j ON j.id=l.journal_id
     WHERE l.account_code=? AND j.jtype!='vat_settlement' ${from ? 'AND j.jdate>=?' : ''} ${to ? 'AND j.jdate<=?' : ''}`)
    .get(...[code, ...(from ? [from] : []), ...(to ? [to] : [])]);
  // GL provision view — output & input VAT may share ONE account (20000) by config.
  const OUT = CFG.acct('output_vat'), IN = CFG.acct('input_vat');
  let output_vat, input_vat;
  if (OUT === IN) { const b = bal(OUT); output_vat = r2(b.c); input_vat = r2(b.d); }
  else { const o = bal(OUT), i = bal(IN); output_vat = r2(o.c - o.d); input_vat = r2(i.d - i.c); }
  // Accrual view — VAT is collected LAST: a payment covers the rent/expense first,
  // so VAT stays outstanding until the invoice/bill is fully paid. "Outstanding as
  // of `to`" uses payments dated on/before `to`, not today's live paid_amount —
  // otherwise a payment made after `to` would wrongly show the invoice as settled
  // for a report run against an earlier period.
  const inv = db.prepare(
    `SELECT COALESCE(SUM(i.vat_amount),0) due,
            COALESCE(SUM(MIN(i.vat_amount, MAX(0, i.total - COALESCE(pa.paid_as_of,0)))),0) outstanding
       FROM invoices i
       LEFT JOIN (
         SELECT invoice_id, SUM(amount) paid_as_of FROM (
           SELECT al.invoice_id invoice_id, al.amount amount
             FROM payment_allocations al JOIN payments p ON p.id=al.payment_id
            ${to ? 'WHERE p.pdate<=?' : ''}
           UNION ALL
           SELECT j.source_id invoice_id, l.credit amount
             FROM journal_lines l JOIN journals j ON j.id=l.journal_id
            WHERE j.source_table='invoices' AND j.jtype='adjustment' AND l.account_code='11100'
              ${to ? 'AND j.jdate<=?' : ''}
         ) GROUP BY invoice_id
       ) pa ON pa.invoice_id = i.id
      WHERE i.status!='cancelled' ${from ? 'AND i.due_date>=?' : ''} ${to ? 'AND i.due_date<=?' : ''}`)
    .get(...[...(to ? [to, to] : []), ...(from ? [from] : []), ...(to ? [to] : [])]);
  const vat_due = r2(inv.due), vat_outstanding = r2(inv.outstanding), vat_collected = r2(vat_due - vat_outstanding);
  // input VAT accrual from vendor bills (who we still owe VAT to)
  const bill = db.prepare(
    `SELECT COALESCE(SUM(b.vat_amount),0) due,
            COALESCE(SUM(MIN(b.vat_amount, MAX(0, b.total - COALESCE(pa.paid_as_of,0)))),0) outstanding
       FROM vendor_bills b
       LEFT JOIN (
         SELECT al.bill_id, SUM(al.amount) paid_as_of
           FROM vendor_payment_allocations al JOIN vendor_payments p ON p.id=al.payment_id
          ${to ? 'WHERE p.pdate<=?' : ''}
          GROUP BY al.bill_id
       ) pa ON pa.bill_id = b.id
      WHERE b.status!='cancelled' ${from ? 'AND b.bdate>=?' : ''} ${to ? 'AND b.bdate<=?' : ''}`)
    .get(...[...(to ? [to] : []), ...(from ? [from] : []), ...(to ? [to] : [])]);
  const vat_input_due = r2(bill.due), vat_input_outstanding = r2(bill.outstanding), vat_input_paid = r2(vat_input_due - vat_input_outstanding);
  // Net payable for the period comes from the LEDGER (output_vat/input_vat above),
  // not just the accrual (invoices/vendor-bills) totals — this way a VAT amount
  // posted by a manual journal entry (not through the invoice/vendor-bill screens)
  // still counts, so the settlement always clears what is really booked.
  const net_payable = r2(output_vat - input_vat);
  const provAll = (OUT === IN)
    ? db.prepare("SELECT COALESCE(SUM(credit-debit),0) b FROM journal_lines WHERE account_code=?").get(OUT).b
    : output_vat - input_vat;
  return {
    from, to,
    vat_due, vat_collected, vat_outstanding,
    vat_input_due, vat_input_paid, vat_input_outstanding,
    output_vat, input_vat, net_payable, provision_balance: r2(provAll), provision_account: OUT === IN ? OUT : null,
  };
}

// ---- Oman VAT Return (الإقرار الضريبي) — the box figures for filing ---------
// Accrual basis (VAT due on invoice/bill date). Standard-rated supplies = rent;
// input VAT = vendor bills. Boxes follow the OTA VAT return layout.
function vatReturn(from, to) {
  const setg = (k) => (db.prepare('SELECT value FROM settings WHERE key=?').get(k) || {}).value || '';
  const inv = db.prepare(
    `SELECT COALESCE(SUM(rent_amount),0) base, COALESCE(SUM(vat_amount),0) vat
       FROM invoices WHERE status!='cancelled' ${from ? 'AND due_date>=?' : ''} ${to ? 'AND due_date<=?' : ''}`)
    .get(...[...(from ? [from] : []), ...(to ? [to] : [])]);
  // input VAT split: fixed-asset purchases (Box 6c) vs normal purchases (Box 6a)
  const bill = db.prepare(
    `SELECT a.type acctype, COALESCE(SUM(b.amount),0) base, COALESCE(SUM(b.vat_amount),0) vat
       FROM vendor_bills b JOIN accounts a ON a.code=b.expense_code
      WHERE b.status!='cancelled' ${from ? 'AND b.bdate>=?' : ''} ${to ? 'AND b.bdate<=?' : ''}
      GROUP BY a.type`).all(...[...(from ? [from] : []), ...(to ? [to] : [])]);
  let b6a = { base: 0, vat: 0 }, b6c = { base: 0, vat: 0 };
  for (const r of bill) { const t = r.acctype === 'asset' ? b6c : b6a; t.base = r2(t.base + r.base); t.vat = r2(t.vat + r.vat); }
  const box1a = { base: r2(inv.base), vat: r2(inv.vat) };
  // Box 5/6 VAT amounts come from the LEDGER (output/input VAT account), not only
  // from invoice/vendor-bill documents — so a VAT amount posted via a manual
  // journal entry is still picked up and the filed net always matches the books.
  // box6a/box6c above stay document-based (base + vat breakdown by purchase type)
  // for reference; box6_reconciliation_gap flags when they don't add up to the
  // ledger total (a sign that some input VAT was booked outside the bills screen).
  const OUT = CFG.acct('output_vat'), IN = CFG.acct('input_vat');
  const balVat = (code) => db.prepare(
    `SELECT COALESCE(SUM(l.credit),0) c, COALESCE(SUM(l.debit),0) d
       FROM journal_lines l JOIN journals j ON j.id=l.journal_id
      WHERE l.account_code=? AND j.jtype!='vat_settlement' ${from ? 'AND j.jdate>=?' : ''} ${to ? 'AND j.jdate<=?' : ''}`)
    .get(...[code, ...(from ? [from] : []), ...(to ? [to] : [])]);
  let box5_output, box6_input;
  if (OUT === IN) { const b = balVat(OUT); box5_output = r2(b.c); box6_input = r2(b.d); }
  else { const o = balVat(OUT), i = balVat(IN); box5_output = r2(o.c - o.d); box6_input = r2(i.d - i.c); }
  const box7_net = r2(box5_output - box6_input);
  const box6_reconciliation_gap = r2(box6_input - (b6a.vat + b6c.vat));
  return {
    from, to, vatin: setg('vat_number') || 'OM1100201030',
    legal_name: setg('company_name') || 'United Tower', sector: 'Real Estate', currency: 'OMR',
    box1a, box1b: { base: 0, vat: 0 }, box1c: { base: 0 },
    box2: { base: 0, vat: 0 }, box3: { base: 0 },
    box5_output,
    box6a: { base: r2(b6a.base), vat: r2(b6a.vat) }, box6c: { base: r2(b6c.base), vat: r2(b6c.vat) },
    box6_input, box7_net, box6_reconciliation_gap, output_account: OUT, input_account: IN,
  };
}

// ---- VAT Statement (كشف الضريبة) — month-by-month, whole year --------------
// Puts the ACCRUAL view (VAT on invoices/vendor-bills, by document date) next to
// the LEDGER view (actual movement on the output/input VAT account, by journal
// date — this also picks up any VAT posted via a manual journal entry) so any
// month where the two disagree is easy to spot before posting that month's
// settlement. Also lists the settlement entries already posted this year.
function vatStatement(year) {
  year = String(year || new Date().getFullYear());
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const OUT = CFG.acct('output_vat'), IN = CFG.acct('input_vat');
  const zeros = () => Array(12).fill(0);
  const addByMonth = (arr, rows, valKey) => rows.forEach((r) => { if (r.mo >= 1 && r.mo <= 12) arr[r.mo - 1] = r2(arr[r.mo - 1] + r[valKey]); });

  const accOut = zeros(), accIn = zeros();
  addByMonth(accOut, db.prepare(
    `SELECT CAST(substr(due_date,6,2) AS INTEGER) mo, COALESCE(SUM(vat_amount),0) v
       FROM invoices WHERE status!='cancelled' AND due_date>=? AND due_date<=? GROUP BY mo`).all(from, to), 'v');
  addByMonth(accIn, db.prepare(
    `SELECT CAST(substr(bdate,6,2) AS INTEGER) mo, COALESCE(SUM(vat_amount),0) v
       FROM vendor_bills WHERE status!='cancelled' AND bdate>=? AND bdate<=? GROUP BY mo`).all(from, to), 'v');

  // excludes vat_settlement journals — a settlement clears prior VAT, it isn't new
  // VAT activity for the month, so it would otherwise inflate the "فعلي" row and
  // falsely show a gap against the accrual row.
  const glMovement = (code) => db.prepare(
    `SELECT CAST(substr(j.jdate,6,2) AS INTEGER) mo, COALESCE(SUM(l.credit),0) c, COALESCE(SUM(l.debit),0) d
       FROM journal_lines l JOIN journals j ON j.id=l.journal_id
      WHERE l.account_code=? AND j.jtype!='vat_settlement' AND j.jdate>=? AND j.jdate<=? GROUP BY mo`).all(code, from, to);
  const glOut = zeros(), glIn = zeros();
  if (OUT === IN) {
    for (const r of glMovement(OUT)) { if (r.mo >= 1 && r.mo <= 12) { glOut[r.mo - 1] = r2(glOut[r.mo - 1] + r.c); glIn[r.mo - 1] = r2(glIn[r.mo - 1] + r.d); } }
  } else {
    for (const r of glMovement(OUT)) { if (r.mo >= 1 && r.mo <= 12) glOut[r.mo - 1] = r2(glOut[r.mo - 1] + (r.c - r.d)); }
    for (const r of glMovement(IN)) { if (r.mo >= 1 && r.mo <= 12) glIn[r.mo - 1] = r2(glIn[r.mo - 1] + (r.d - r.c)); }
  }

  const sum = (arr) => r2(arr.reduce((s, x) => s + x, 0));
  const netOf = (out, inn) => out.map((v, i) => r2(v - inn[i]));
  const accrual_net = netOf(accOut, accIn), ledger_net = netOf(glOut, glIn);
  const gap = ledger_net.map((v, i) => r2(v - accrual_net[i]));

  // Running balance of the provision account — the TRUE balance (includes
  // settlements, unlike the "فعلي" gap-detection rows above), seeded with the
  // account's opening balance before this year so it ties to "رصيد حساب 20000".
  const balBefore = (code) => {
    const b = db.prepare(
      `SELECT COALESCE(SUM(l.credit),0) c, COALESCE(SUM(l.debit),0) d
         FROM journal_lines l JOIN journals j ON j.id=l.journal_id
        WHERE l.account_code=? AND j.jdate<?`).get(code, from);
    return r2(b.c - b.d);
  };
  const openingNet = OUT === IN ? balBefore(OUT) : r2(balBefore(OUT) - balBefore(IN));
  const allMovement = (code) => db.prepare(
    `SELECT CAST(substr(j.jdate,6,2) AS INTEGER) mo, COALESCE(SUM(l.credit),0) c, COALESCE(SUM(l.debit),0) d
       FROM journal_lines l JOIN journals j ON j.id=l.journal_id
      WHERE l.account_code=? AND j.jdate>=? AND j.jdate<=? GROUP BY mo`).all(code, from, to);
  const trueOut = zeros(), trueIn = zeros();
  if (OUT === IN) {
    for (const r of allMovement(OUT)) { if (r.mo >= 1 && r.mo <= 12) { trueOut[r.mo - 1] = r2(trueOut[r.mo - 1] + r.c); trueIn[r.mo - 1] = r2(trueIn[r.mo - 1] + r.d); } }
  } else {
    for (const r of allMovement(OUT)) { if (r.mo >= 1 && r.mo <= 12) trueOut[r.mo - 1] = r2(trueOut[r.mo - 1] + (r.c - r.d)); }
    for (const r of allMovement(IN)) { if (r.mo >= 1 && r.mo <= 12) trueIn[r.mo - 1] = r2(trueIn[r.mo - 1] + (r.d - r.c)); }
  }
  let running = openingNet;
  const cumulative_balance = netOf(trueOut, trueIn).map((v) => r2(running += v));

  const settlements = db.prepare(
    `SELECT jdate, reference, memo_ar FROM journals WHERE jtype='vat_settlement' AND jdate>=? AND jdate<=? ORDER BY jdate`).all(from, to);

  return {
    year, provision_account: OUT === IN ? OUT : null, output_account: OUT, input_account: IN, opening_balance: openingNet,
    accrual_output: { months: accOut, total: sum(accOut) },
    accrual_input: { months: accIn, total: sum(accIn) },
    accrual_net: { months: accrual_net, total: sum(accrual_net) },
    ledger_output: { months: glOut, total: sum(glOut) },
    ledger_input: { months: glIn, total: sum(glIn) },
    ledger_net: { months: ledger_net, total: sum(ledger_net) },
    gap: { months: gap, total: sum(gap) },
    cumulative_balance,
    settlements,
  };
}

// ---- Unpaid INPUT VAT per vendor (VAT we still owe on vendor bills) --------
// Same as vatUncollectedByCustomer: "unpaid as of `to`" uses the payment's own
// date, not the bill's live paid_amount, so a payment made after `to` doesn't
// count yet.
function vatInputUnpaidByVendor(from, to) {
  const rows = db.prepare(
    `SELECT COALESCE(v.name,'—') vendor,
            COALESCE(SUM(b.vat_amount),0) vat_due,
            COALESCE(SUM(MIN(b.vat_amount, MAX(0, b.total - COALESCE(pa.paid_as_of,0)))),0) vat_outstanding
       FROM vendor_bills b LEFT JOIN vendors v ON v.id=b.vendor_id
       LEFT JOIN (
         SELECT al.bill_id, SUM(al.amount) paid_as_of
           FROM vendor_payment_allocations al JOIN vendor_payments p ON p.id=al.payment_id
          ${to ? 'WHERE p.pdate<=?' : ''}
          GROUP BY al.bill_id
       ) pa ON pa.bill_id = b.id
      WHERE b.status!='cancelled' ${from ? 'AND b.bdate>=?' : ''} ${to ? 'AND b.bdate<=?' : ''}
      GROUP BY b.vendor_id`).all(...[...(to ? [to] : []), ...(from ? [from] : []), ...(to ? [to] : [])]);
  const outr = rows.map((r) => ({ vendor: r.vendor, vat_due: r2(r.vat_due), vat_paid: r2(r.vat_due - r.vat_outstanding), vat_outstanding: r2(r.vat_outstanding) }))
    .filter((x) => x.vat_outstanding > 0.005).sort((a, b) => b.vat_outstanding - a.vat_outstanding);
  return { from, to, rows: outr, grand_total: r2(outr.reduce((s, x) => s + x.vat_outstanding, 0)) };
}

// ---- Uncollected VAT per customer (the VAT portion still inside 11100) -----
// "Outstanding as of `to`" means paid-as-of-that-date, not the invoice's current
// (today's) paid_amount — a payment made AFTER `to` must not count yet, so this
// joins payment_allocations by the payment's own date instead of using the
// invoice's live running total.
function vatUncollectedByCustomer(from, to) {
  const rows = db.prepare(
    `SELECT t.name tenant, MAX(f.code) flat,
            COALESCE(SUM(i.vat_amount),0) vat_due,
            COALESCE(SUM(MIN(i.vat_amount, MAX(0, i.total - COALESCE(pa.paid_as_of,0)))),0) vat_outstanding
       FROM invoices i JOIN tenants t ON t.id=i.tenant_id LEFT JOIN flats f ON f.id=i.flat_id
       LEFT JOIN (
         SELECT invoice_id, SUM(amount) paid_as_of FROM (
           SELECT al.invoice_id invoice_id, al.amount amount
             FROM payment_allocations al JOIN payments p ON p.id=al.payment_id
            ${to ? 'WHERE p.pdate<=?' : ''}
           UNION ALL
           SELECT j.source_id invoice_id, l.credit amount
             FROM journal_lines l JOIN journals j ON j.id=l.journal_id
            WHERE j.source_table='invoices' AND j.jtype='adjustment' AND l.account_code='11100'
              ${to ? 'AND j.jdate<=?' : ''}
         ) GROUP BY invoice_id
       ) pa ON pa.invoice_id = i.id
      WHERE i.status!='cancelled' ${from ? 'AND i.due_date>=?' : ''} ${to ? 'AND i.due_date<=?' : ''}
      GROUP BY i.tenant_id`).all(...[...(to ? [to, to] : []), ...(from ? [from] : []), ...(to ? [to] : [])]);
  const out = rows.map((r) => ({ tenant: r.tenant, flat: r.flat, vat_due: r2(r.vat_due), vat_paid: r2(r.vat_due - r.vat_outstanding), vat_outstanding: r2(r.vat_outstanding) }))
    .filter((x) => x.vat_outstanding > 0.005).sort((a, b) => b.vat_outstanding - a.vat_outstanding);
  return { from, to, rows: out, grand_total: r2(out.reduce((s, x) => s + x.vat_outstanding, 0)) };
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
  trialBalance, incomeStatement, incomeStatementConsolidated, accountLedger, generalLedgerFull, groupedJournals, legacyJournals, legacyDrill,
  liquidityReport, moneyPosition, financialRatios, balanceSheet, financialStatements, receivablesAging, receivablesAgingDrill, payablesAging,
  flatStatement, vendorStatement, advancesReport, receivablesBalancePersistence, occupancy, propertyPL, roi, cashFlowForecast, vatReport, vatReturn, vatStatement, vatUncollectedByCustomer, vatInputUnpaidByVendor,
  bankReport, chequesReport, chequesDashboard, dashboard, contractExpiry, buildingComparison,
  depreciationReport, customersSummary, invoiceContractAudit, auditCenter,
};
