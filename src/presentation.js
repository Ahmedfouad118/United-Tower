// ==========================================================================
// Building Presentation (البرزنتيشن) — pulls together the numbers a slide
// deck would need (KPIs, income statement, ratios, occupancy, aging, budget)
// for a given year/building, plus an editable SWOT + development-plan note.
// ==========================================================================
const { db } = require('./db');
const { r2 } = require('./ledger');
const R = require('./reports');
const BUD = require('./budget');

function getNotes(year, building_id) {
  const bid = building_id || 0;
  const row = db.prepare('SELECT * FROM presentation_notes WHERE building_id=? AND year=?').get(bid, year);
  return row || { building_id: bid, year, strengths: '', weaknesses: '', opportunities: '', threats: '', development_plan: '' };
}

function saveNotes(year, building_id, data, updated_by) {
  const bid = building_id || 0;
  db.prepare(
    `INSERT INTO presentation_notes (building_id,year,strengths,weaknesses,opportunities,threats,development_plan,updated_by,updated_at)
     VALUES (?,?,?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(building_id,year) DO UPDATE SET
       strengths=excluded.strengths, weaknesses=excluded.weaknesses, opportunities=excluded.opportunities,
       threats=excluded.threats, development_plan=excluded.development_plan,
       updated_by=excluded.updated_by, updated_at=datetime('now')`)
    .run(bid, year, data.strengths || '', data.weaknesses || '', data.opportunities || '', data.threats || '', data.development_plan || '', updated_by || null);
  return getNotes(year, bid);
}

// Draft SWOT bullets from the numbers themselves — a starting point the user
// edits, not a substitute for their own judgement.
function draftSwot(data) {
  const s = [], w = [], o = [], t = [];
  const occ = data.occupancy.total ? r2((data.occupancy.occupied / data.occupancy.total) * 100) : 0;
  if (occ >= 85) s.push(`نسبة إشغال مرتفعة (${occ}%)`); else if (occ < 60) w.push(`نسبة إشغال منخفضة (${occ}%) — فرصة لحملة تسويقية للوحدات الشاغرة`);
  if (data.ratios.net_margin >= 30) s.push(`هامش ربح صافي قوي (${data.ratios.net_margin}%)`); else if (data.ratios.net_margin < 10) w.push(`هامش الربح الصافي ضعيف (${data.ratios.net_margin}%)`);
  if (data.ratios.current_ratio >= 1.5) s.push('سيولة قصيرة الأجل مريحة (نسبة تداول جيدة)'); else if (data.ratios.current_ratio < 1) t.push('نسبة التداول أقل من 1 — ضغط محتمل على السيولة قصيرة الأجل');
  if (data.aging.grand_total > 0) w.push(`ذمم متأخرة على العملاء بقيمة ${money0(data.aging.grand_total)} — يحتاج متابعة تحصيل`);
  o.push('رفع الإيجارات تدريجيًا عند تجديد العقود القريبة من نهايتها لمواكبة السوق');
  o.push('دراسة تحويل الوحدات الشاغرة طويلًا لاستخدام تجاري بعائد أعلى');
  t.push('تقلب تكاليف الصيانة والمرافق مع التضخم');
  return { strengths: s, weaknesses: w, opportunities: o, threats: t };
}
function money0(v) { return r2(v).toLocaleString('en-US', { minimumFractionDigits: 3 }); }

// Narrative performance insights — a plain-language reading of the same
// numbers already on the KPI slide, so a non-accountant reviewer gets a
// sentence of context instead of just a raw figure.
function buildInsights(data) {
  const out = [];
  const occ = data.occupancy.total ? r2((data.occupancy.occupied / data.occupancy.total) * 100) : 0;
  if (occ >= 90) out.push(`نسبة الإشغال ${occ}% — إشغال شبه كامل، فرصة محدودة لزيادة الإيراد إلا برفع الإيجارات أو وحدات جديدة.`);
  else if (occ >= 70) out.push(`نسبة الإشغال ${occ}% — مستوى جيد، مع وجود وحدات شاغرة تستحق حملة تسويقية مركّزة.`);
  else out.push(`نسبة الإشغال ${occ}% — أقل من المتوسط المعتاد للقطاع العقاري (80%+)، وده بيأثر مباشرة على الإيراد المحتمل.`);

  const nm = data.ratios.net_margin;
  if (nm >= 30) out.push(`هامش الربح الصافي ${nm}% — أعلى من متوسط قطاع العقارات التجارية (عادة 20-30%)، أداء مالي قوي.`);
  else if (nm >= 15) out.push(`هامش الربح الصافي ${nm}% — ضمن النطاق المعتاد للقطاع، لكن فيه مساحة لتحسين ضبط المصروفات.`);
  else out.push(`هامش الربح الصافي ${nm}% — أقل من المعتاد للقطاع، يستحق مراجعة بنود المصروفات الأكبر.`);

  const cr = data.ratios.current_ratio;
  if (cr >= 2) out.push(`نسبة التداول ${cr} — سيولة قصيرة الأجل مريحة جدًا، تغطي الالتزامات المتداولة براحة.`);
  else if (cr >= 1) out.push(`نسبة التداول ${cr} — سيولة كافية لتغطية الالتزامات المتداولة، بدون فائض كبير.`);
  else out.push(`نسبة التداول ${cr} — أقل من 1، ما يعني ضغط محتمل على السيولة قصيرة الأجل يستحق المتابعة.`);

  if (data.aging.grand_total > 0) {
    const pctOfRev = data.income.total_income ? r2((data.aging.grand_total / data.income.total_income) * 100) : 0;
    out.push(`الذمم المتأخرة على العملاء ${money0(data.aging.grand_total)} — ما يعادل ${pctOfRev}% من إيراد الفترة، يستحق خطة تحصيل واضحة.`);
  } else {
    out.push('لا توجد ذمم متأخرة على العملاء في نهاية الفترة — تحصيل جيد.');
  }

  if (data.budget && data.budget.income_totals.budget.total) {
    const varPct = r2((data.budget.income_totals.variance.total / data.budget.income_totals.budget.total) * 100);
    if (varPct >= 0) out.push(`الإيراد الفعلي تجاوز الموازنة بنسبة ${varPct}%.`);
    else out.push(`الإيراد الفعلي أقل من الموازنة بنسبة ${Math.abs(varPct)}%.`);
  }
  return out;
}

// Bank balances as of a date — each bank's own GL account balance, plus the
// total, so the presentation can show "رصيد البنك" without the user having to
// open the bank report separately.
function bankBalances(upto) {
  const banks = db.prepare("SELECT id, name, gl_account FROM banks WHERE gl_account IS NOT NULL AND gl_account<>''").all();
  const balOf = (code) => {
    const b = db.prepare(
      `SELECT COALESCE(SUM(l.debit),0) d, COALESCE(SUM(l.credit),0) c
         FROM journal_lines l JOIN journals j ON j.id=l.journal_id
        WHERE l.account_code=? ${upto ? 'AND j.jdate<=?' : ''}`).get(...[code, ...(upto ? [upto] : [])]);
    return r2(b.d - b.c);
  };
  const rows = banks.map((b) => ({ id: b.id, name: b.name, balance: balOf(b.gl_account) }));
  return { rows, total: r2(rows.reduce((s, x) => s + x.balance, 0)) };
}

function getPresentationData(from, to, building_id, version) {
  const today = new Date().toISOString().slice(0, 10);
  to = to || today;
  from = from || `${to.slice(0, 4)}-01-01`;
  const year = Number(to.slice(0, 4)) || new Date().getFullYear();
  const bid = building_id ? Number(building_id) : null;
  const bld = bid ? db.prepare('SELECT name, name_ar FROM buildings WHERE id=?').get(bid) : null;
  const income = R.incomeStatement(from, to, 'ar', bid);
  const consolidated = R.incomeStatementConsolidated(year, 'ar', bid);
  const fromMo = Number(from.slice(0, 4)) === year ? Number(from.slice(5, 7)) : 1;
  const toMo = Number(to.slice(0, 4)) === year ? Number(to.slice(5, 7)) : 12;
  const monthly_trend = consolidated.total_income.months.map((v, i) => ({
    mo: i + 1, income: v, expense: consolidated.total_expense.months[i], net: consolidated.ebitda.months[i],
  })).filter((m) => m.mo >= fromMo && m.mo <= toMo);
  const balance_sheet = R.balanceSheet(to, 'ar');
  const liquidity = R.liquidityReport(to, 'ar');
  const ratios = R.financialRatios(from, to, bid);
  const occupancy = R.occupancy(to, bid);
  const aging = R.receivablesAging(to, bid);
  const bank = bankBalances(to);
  const budgetFull = BUD.budgetVsActual(year, bid || 0, 'ar', version || 1);
  const sliceMonths = (obj) => ({
    months: obj.months.slice(fromMo - 1, toMo),
    total: r2(obj.months.slice(fromMo - 1, toMo).reduce((s, v) => s + v, 0)),
  });
  const budget = {
    ...budgetFull,
    income_totals: { budget: sliceMonths(budgetFull.income_totals.budget), actual: sliceMonths(budgetFull.income_totals.actual), variance: sliceMonths(budgetFull.income_totals.variance) },
    expense_totals: { budget: sliceMonths(budgetFull.expense_totals.budget), actual: sliceMonths(budgetFull.expense_totals.actual), variance: sliceMonths(budgetFull.expense_totals.variance) },
    net_budget: sliceMonths(budgetFull.net_budget), net_actual: sliceMonths(budgetFull.net_actual), net_variance: sliceMonths(budgetFull.net_variance),
  };
  const notes = getNotes(year, bid || 0);
  const data = {
    year, from, to, building_id: bid, building: bld ? (bld.name_ar || bld.name) : 'كل البنايات (موحّد)',
    income, monthly_trend, balance_sheet, liquidity, ratios, occupancy, aging, bank, budget, notes,
  };
  data.swot_draft = draftSwot(data);
  data.insights = buildInsights(data);
  return data;
}

// ---- Share links (public, unlisted-by-token) + viewer feedback ------------
function getOrCreateShare(from, to, building_id, version, created_by) {
  const bid = building_id ? Number(building_id) : null;
  const ver = Number(version) || 1;
  const existing = bid == null
    ? db.prepare('SELECT * FROM presentation_shares WHERE building_id IS NULL AND from_date=? AND to_date=? AND version=?').get(from, to, ver)
    : db.prepare('SELECT * FROM presentation_shares WHERE building_id=? AND from_date=? AND to_date=? AND version=?').get(bid, from, to, ver);
  if (existing) return existing;
  const token = require('crypto').randomBytes(16).toString('hex');
  db.prepare('INSERT INTO presentation_shares (token,building_id,from_date,to_date,version,created_by) VALUES (?,?,?,?,?,?)')
    .run(token, bid, from, to, ver, created_by || null);
  return db.prepare('SELECT * FROM presentation_shares WHERE token=?').get(token);
}
function getShare(token) {
  return db.prepare('SELECT * FROM presentation_shares WHERE token=?').get(token);
}
function saveFeedback(token, data) {
  const share = getShare(token);
  if (!share) throw new Error('رابط غير صالح');
  const clamp = (v) => { v = Number(v); return v >= 1 && v <= 5 ? v : null; };
  db.prepare(
    `INSERT INTO presentation_feedback (share_token,rating_overall,rating_clarity,rating_design,notes,name)
     VALUES (?,?,?,?,?,?)`)
    .run(token, clamp(data.rating_overall), clamp(data.rating_clarity), clamp(data.rating_design),
      (data.notes || '').slice(0, 2000) || null, (data.name || '').slice(0, 100) || null);
  return { ok: true };
}
function listFeedback(from, to, building_id, version) {
  const bid = building_id ? Number(building_id) : null;
  const ver = Number(version) || 1;
  const shares = bid == null
    ? db.prepare('SELECT token FROM presentation_shares WHERE building_id IS NULL AND from_date=? AND to_date=? AND version=?').all(from, to, ver)
    : db.prepare('SELECT token FROM presentation_shares WHERE building_id=? AND from_date=? AND to_date=? AND version=?').all(bid, from, to, ver);
  if (!shares.length) return { rows: [], count: 0, avg_overall: 0, avg_clarity: 0, avg_design: 0 };
  const tokens = shares.map((s) => s.token);
  const rows = db.prepare(
    `SELECT * FROM presentation_feedback WHERE share_token IN (${tokens.map(() => '?').join(',')}) ORDER BY created_at DESC`).all(...tokens);
  const avg = (key) => { const v = rows.filter((r) => r[key] != null); return v.length ? r2(v.reduce((s, r) => s + r[key], 0) / v.length) : 0; };
  return { rows, count: rows.length, avg_overall: avg('rating_overall'), avg_clarity: avg('rating_clarity'), avg_design: avg('rating_design') };
}

module.exports = {
  getPresentationData, getNotes, saveNotes,
  getOrCreateShare, getShare, saveFeedback, listFeedback,
};
