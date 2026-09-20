// ==========================================================================
// Budget (الموازنة المالية) — manual/suggested monthly budget per account,
// compared against actual results using the same shape as the consolidated
// income statement so the two can sit side by side.
// ==========================================================================
const { db } = require('./db');
const { r2 } = require('./ledger');
const R = require('./reports');

const ALL_BUILDINGS = 0; // sentinel: SQLite treats NULL as distinct in a UNIQUE
                          // index, so a real value is used for "whole company"

// ---- Read the budget grid for a year (one row per account, 12 months) -----
function getBudget(year, building_id, lang = 'ar') {
  const bid = building_id || ALL_BUILDINGS;
  const nameCol = lang === 'ar' ? 'COALESCE(a.name_ar,a.name)' : 'a.name';
  const rows = db.prepare(
    `SELECT b.account_code code, ${nameCol} name, a.type, b.month, b.amount
       FROM budgets b JOIN accounts a ON a.code=b.account_code
      WHERE b.building_id=? AND b.year=?
      ORDER BY a.code`).all(bid, year);
  const byAcc = {};
  for (const r of rows) {
    if (!byAcc[r.code]) byAcc[r.code] = { code: r.code, name: r.name, type: r.type, months: Array(12).fill(0), total: 0 };
    byAcc[r.code].months[r.month - 1] = r2(r.amount);
    byAcc[r.code].total = r2(byAcc[r.code].total + r.amount);
  }
  return Object.values(byAcc).sort((a, b) => a.code.localeCompare(b.code));
}

// ---- Save a batch of cells: [{account_code, month, amount}] ---------------
function saveBudget(year, building_id, entries, created_by) {
  const bid = building_id || ALL_BUILDINGS;
  const up = db.prepare(
    `INSERT INTO budgets (building_id,year,month,account_code,amount,updated_by,updated_at)
     VALUES (?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(building_id,year,month,account_code)
     DO UPDATE SET amount=excluded.amount, updated_by=excluded.updated_by, updated_at=datetime('now')`);
  let n = 0;
  for (const e of (entries || [])) {
    const month = Number(e.month);
    if (!e.account_code || !month || month < 1 || month > 12) continue;
    up.run(bid, Number(year), month, String(e.account_code), r2(e.amount || 0), created_by || null);
    n++;
  }
  return { saved: n };
}

// ---- Suggest a monthly rental-income budget from an occupancy % -----------
// Sums the base_rent of every flat (full-occupancy potential), scaled by an
// assumed occupancy percentage — a starting projection the user can accept
// as-is or adjust before saving.
function suggestRevenue(occupancy_percent, building_id) {
  const pct = Math.max(0, Math.min(100, Number(occupancy_percent))) / 100 || 0;
  const row = db.prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(base_rent),0) total_rent
       FROM flats ${building_id ? 'WHERE building_id=?' : ''}`).get(...(building_id ? [building_id] : []));
  const monthly = r2(row.total_rent * pct);
  return {
    flats: row.n, full_monthly_rent: r2(row.total_rent), occupancy_percent: r2(pct * 100),
    suggested_monthly: monthly, suggested_annual: r2(monthly * 12),
  };
}

// ---- Suggest an expense budget from the historical average -----------------
// Average of each expense account's actual postings over the prior `months`
// months — a starting point instead of typing every account from scratch.
function suggestExpenses(asOfYear, building_id, months = 12) {
  const to = `${asOfYear - 1}-12-31`;
  const fromD = new Date(asOfYear - 1, 11 - (months - 1), 1);
  const from = `${fromD.getFullYear()}-${String(fromD.getMonth() + 1).padStart(2, '0')}-01`;
  const rows = db.prepare(
    `SELECT a.code, COALESCE(a.name_ar,a.name) name, COALESCE(SUM(l.debit)-SUM(l.credit),0) total
       FROM accounts a JOIN journal_lines l ON l.account_code=a.code JOIN journals j ON j.id=l.journal_id
      WHERE a.type='expense' AND j.jdate>=? AND j.jdate<=? ${building_id ? 'AND l.building_id=?' : ''}
      GROUP BY a.code HAVING total>0.005 ORDER BY a.code`)
    .all(...[from, to, ...(building_id ? [building_id] : [])]);
  return rows.map((r) => ({ code: r.code, name: r.name, avg_monthly: r2(r.total / months) }));
}

// ---- Budget vs Actual (monthly + annual, income & expense) -----------------
function budgetVsActual(year, building_id, lang = 'ar') {
  const budget = getBudget(year, building_id, lang);
  const actual = R.incomeStatementConsolidated(year, lang, building_id || null);
  const actualByCode = {};
  for (const a of [...actual.income, ...actual.expense]) actualByCode[a.code] = a;
  const budgetByCode = {}; for (const b of budget) budgetByCode[b.code] = b;
  const codes = new Set([...budget.map((b) => b.code), ...Object.keys(actualByCode)]);
  const nameCol = lang === 'ar' ? 'name_ar' : 'name';
  const rows = [...codes].map((code) => {
    const b = budgetByCode[code], a = actualByCode[code];
    const accRow = db.prepare('SELECT code,name,name_ar,type FROM accounts WHERE code=?').get(code);
    const name = (accRow && (accRow[nameCol] || accRow.name)) || (b && b.name) || (a && a.name) || code;
    const type = (accRow && accRow.type) || (b && b.type) || (a ? (actual.income.includes(a) ? 'income' : 'expense') : 'expense');
    const budgetM = b ? b.months : Array(12).fill(0);
    const actualM = a ? a.months : Array(12).fill(0);
    const varianceM = actualM.map((v, i) => r2(v - budgetM[i]));
    return {
      code, name, type, budget: budgetM, actual: actualM, variance: varianceM,
      budget_total: r2(budgetM.reduce((s, v) => s + v, 0)),
      actual_total: r2(actualM.reduce((s, v) => s + v, 0)),
      variance_total: r2(varianceM.reduce((s, v) => s + v, 0)),
    };
  }).sort((x, y) => x.code.localeCompare(y.code));
  const income = rows.filter((r) => r.type === 'income');
  const expense = rows.filter((r) => r.type !== 'income');
  const sumRows = (list, key) => { const m = Array(12).fill(0); for (const r of list) r[key].forEach((v, i) => m[i] = r2(m[i] + v)); return { months: m, total: r2(m.reduce((s, v) => s + v, 0)) }; };
  const totals = (list) => ({ budget: sumRows(list, 'budget'), actual: sumRows(list, 'actual'), variance: sumRows(list, 'variance') });
  const incomeTotals = totals(income), expenseTotals = totals(expense);
  const netOf = (a, b) => a.months.map((v, i) => r2(v - b.months[i]));
  const net_budget = { months: netOf(incomeTotals.budget, expenseTotals.budget), total: r2(incomeTotals.budget.total - expenseTotals.budget.total) };
  const net_actual = { months: netOf(incomeTotals.actual, expenseTotals.actual), total: r2(incomeTotals.actual.total - expenseTotals.actual.total) };
  const net_variance = { months: net_actual.months.map((v, i) => r2(v - net_budget.months[i])), total: r2(net_actual.total - net_budget.total) };
  return { year, income, expense, income_totals: incomeTotals, expense_totals: expenseTotals, net_budget, net_actual, net_variance };
}

module.exports = { getBudget, saveBudget, suggestRevenue, suggestExpenses, budgetVsActual, ALL_BUILDINGS };
