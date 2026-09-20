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

function getPresentationData(year, building_id) {
  year = Number(year) || new Date().getFullYear();
  const bid = building_id ? Number(building_id) : null;
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const bld = bid ? db.prepare('SELECT name, name_ar FROM buildings WHERE id=?').get(bid) : null;
  const income = R.incomeStatement(from, to, 'ar', bid);
  const balance_sheet = R.balanceSheet(to, 'ar');
  const liquidity = R.liquidityReport(to, 'ar');
  const ratios = R.financialRatios(from, to, bid);
  const occupancy = R.occupancy(to, bid);
  const aging = R.receivablesAging(to, bid);
  const budget = BUD.budgetVsActual(year, bid || 0, 'ar');
  const notes = getNotes(year, bid || 0);
  const data = {
    year, building_id: bid, building: bld ? (bld.name_ar || bld.name) : 'كل البنايات (موحّد)',
    income, balance_sheet, liquidity, ratios, occupancy, aging, budget, notes,
  };
  data.swot_draft = draftSwot(data);
  return data;
}

module.exports = { getPresentationData, getNotes, saveNotes };
