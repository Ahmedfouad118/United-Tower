// Seed v3 — full client chart of accounts, real opening balances (31-12-2025)
// and the actual 2026 GL journals (Jan–Mar), building/units, masters, admin.
const { db, init } = require('../src/db');
const { hash } = require('../src/auth');
const { postJournal } = require('../src/ledger');
const DATA = require('./data2026');

init();

// ---- Chart of accounts (full list from client) ----------------------------
// Arabic names for the accounts that actually carry activity.
const AR = {
  '10000': 'الصندوق (النثرية)', '10400': 'الحساب البنكي الرئيسي', '10500': 'حساب بنكي خاص',
  '11000': 'ذمم مدينة أخرى', '11100': 'ذمم المستأجرين المدينة', '11500': 'مخصص ديون مشكوك فيها',
  '11600': 'ضريبة القيمة المضافة (مدخلات)', '14100': 'سلف الموظفين', '15500': 'المباني', '16900': 'الأراضي',
  '17500': 'مجمع إهلاك المباني', '20000': 'ذمم الموردين الدائنة', '21000': 'تأمينات مستأجرين محتجزة',
  '21500': 'دفعات عملاء مقدمة', '23000': 'مصروفات مستحقة', '23100': 'إيرادات مقدمة (إيجار)',
  '23200': 'ضريبة القيمة المضافة (مخرجات)', '24400': 'تأمينات عملاء', '39004': 'رأس المال',
  '39005': 'أرباح مرحّلة', '40000': 'إيرادات تأجير', '40500': 'إيرادات خدمات', '41000': 'إيرادات أخرى',
  '61000': 'مصاريف سيارات', '62000': 'مصاريف بنكية', '64000': 'مصروف الإهلاك', '68000': 'مصاريف نظافة',
  '70000': 'مصاريف صيانة', '73000': 'ضرائب أخرى', '77000': 'مصروف الرواتب', '78000': 'مصاريف مرافق', '89000': 'مصاريف أخرى',
};
const insAcc = db.prepare('INSERT OR IGNORE INTO accounts (code,name,name_ar,type,normal_balance) VALUES (?,?,?,?,?)');
for (const a of DATA.accounts) insAcc.run(a.code, a.name, AR[a.code] || null, a.type, a.normal_balance);

// ---- Settings -------------------------------------------------------------
const setS = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
[['company_name', 'United Tower'], ['company_name_ar', 'برج المتحدة'],
 ['currency', 'OMR'], ['decimals', '3'], ['vat_percent', '5'], ['default_lang', 'ar'],
 ['bank_account', '10400'], ['tenant_recv', '11100'], ['rent_income', '40000'],
].forEach(([k, v]) => setS.run(k, v));

// ---- Admin user -----------------------------------------------------------
if (!db.prepare("SELECT 1 FROM users WHERE username='admin'").get())
  db.prepare('INSERT INTO users (username,full_name,password_hash,role,lang) VALUES (?,?,?,?,?)')
    .run('admin', 'System Administrator', hash('admin123'), 'admin', 'ar');

// ---- Building (property) --------------------------------------------------
let buildingId = db.prepare("SELECT id FROM buildings WHERE code='UT'").get()?.id;
if (!buildingId) {
  buildingId = Number(db.prepare('INSERT INTO buildings (code,name,name_ar,address,owner,purchase_value) VALUES (?,?,?,?,?,?)')
    .run('UT', 'United Tower', 'برج المتحدة', 'GHALA 299/1, Muscat', 'United Securities', 2979778).lastInsertRowid);
}

// ---- Bank + payment methods ----------------------------------------------
if (!db.prepare('SELECT COUNT(*) c FROM banks').get().c)
  db.prepare('INSERT INTO banks (name,name_ar,gl_account,currency) VALUES (?,?,?,?)')
    .run('Bank Muscat', 'بنك مسقط', '10400', 'OMR');
if (!db.prepare('SELECT COUNT(*) c FROM payment_methods').get().c) {
  const pm = db.prepare('INSERT INTO payment_methods (name,name_ar,kind,gl_account) VALUES (?,?,?,?)');
  pm.run('Cash', 'نقدي', 'cash', '10000');
  pm.run('Bank Transfer', 'تحويل بنكي', 'bank', '10400');
  pm.run('Cheque', 'شيك', 'cheque', '10400');
  pm.run('Card / POS', 'شبكة / بطاقة', 'card', '10400');
  pm.run('Online (Thawani)', 'دفع إلكتروني', 'online', '10400');
}
if (!db.prepare('SELECT COUNT(*) c FROM categories').get().c) {
  const cat = db.prepare('INSERT INTO categories (entity,name,name_ar) VALUES (?,?,?)');
  cat.run('customer', 'Residential', 'سكني'); cat.run('customer', 'Commercial', 'تجاري');
  cat.run('vendor', 'Maintenance', 'صيانة'); cat.run('vendor', 'Utilities', 'مرافق');
  cat.run('unit', 'Apartment', 'شقة'); cat.run('unit', 'Shop', 'محل');
}

// ---- Flats ----------------------------------------------------------------
if (!db.prepare('SELECT COUNT(*) c FROM flats').get().c) {
  const insF = db.prepare('INSERT INTO flats (code,building_id,floor,base_rent,unit_type) VALUES (?,?,?,?,?)');
  for (let floor = 4; floor <= 9; floor++)
    for (let unit = 1; unit <= 7; unit++)
      insF.run(`FLAT ${floor}0${unit}`, buildingId, String(floor), 260, 'Apartment');
  insF.run('TOWER', buildingId, 'GF', 150, 'Shop');
}

// ---- Opening balances (31-12-2025) — opens the 2026 financial year --------
if (!db.prepare("SELECT 1 FROM journals WHERE jtype='opening'").get()) {
  postJournal(
    { jdate: '2025-12-31', jtype: 'opening', reference: 'OB-2025', memo: 'Opening balances 31-12-2025', memo_ar: 'أرصدة افتتاحية 31-12-2025' },
    DATA.opening.map((l) => ({ account_code: l.account_code, debit: l.debit, credit: l.credit }))
  );
  // ---- Actual 2026 journals (from the client GL, Jan–Mar) -----------------
  for (const j of DATA.journals) {
    postJournal(
      { jdate: j.jdate, jtype: 'manual', reference: j.ref, memo: (j.lines[0] && j.lines[0].memo) || j.ref },
      j.lines.map((l) => ({ account_code: l.account_code, debit: l.debit, credit: l.credit, memo: l.memo }))
    );
  }
}

const tb = db.prepare(`SELECT COALESCE(SUM(l.debit),0) d, COALESCE(SUM(l.credit),0) c FROM journal_lines l`).get();
console.log('Seed v3 complete:', {
  accounts: db.prepare('SELECT COUNT(*) c FROM accounts').get().c,
  journals: db.prepare('SELECT COUNT(*) c FROM journals').get().c,
  flats: db.prepare('SELECT COUNT(*) c FROM flats').get().c,
  ledger_debit: Math.round(tb.d * 100) / 100, ledger_credit: Math.round(tb.c * 100) / 100,
});
console.log('Login -> admin / admin123');
