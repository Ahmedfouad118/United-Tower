// Seed v2 — real-estate chart of accounts (multilingual), opening balances,
// building/units, masters (bank, payment methods, categories), admin user.
const { db, init } = require('../src/db');
const { hash } = require('../src/auth');
const { postJournal } = require('../src/ledger');

init();

// ---- Chart of accounts (code, EN, AR, type, normal) -----------------------
const ACCOUNTS = [
  ['10000', 'Petty Cash', 'الصندوق (النثرية)', 'asset', 'D'],
  ['10400', 'Savings Account (Bank)', 'الحساب البنكي الرئيسي', 'asset', 'D'],
  ['10500', 'Special Account (Bank)', 'حساب بنكي خاص', 'asset', 'D'],
  ['11000', 'Accounts Receivable', 'ذمم مدينة أخرى', 'asset', 'D'],
  ['11100', 'Tenant / Contracts Receivable', 'ذمم المستأجرين المدينة', 'asset', 'D'],
  ['11500', 'Allowance for Doubtful Accounts', 'مخصص ديون مشكوك فيها', 'asset', 'C'],
  ['11600', 'Input VAT (recoverable)', 'ضريبة القيمة المضافة (مدخلات)', 'asset', 'D'],
  ['15500', 'Building', 'المباني', 'asset', 'D'],
  ['16900', 'Land', 'الأراضي', 'asset', 'D'],
  ['17500', 'Accum. Depreciation - Building', 'مجمع إهلاك المباني', 'asset', 'C'],
  ['20000', 'Accounts Payable', 'ذمم الموردين الدائنة', 'liability', 'C'],
  ['21000', 'Security Deposits Held', 'تأمينات مستأجرين محتجزة', 'liability', 'C'],
  ['21500', 'Customer Advances (Prepaid Rent)', 'دفعات عملاء مقدمة', 'liability', 'C'],
  ['23000', 'Accrued Expenses', 'مصروفات مستحقة', 'liability', 'C'],
  ['23100', 'Deferred Rent Revenue (Unearned)', 'إيرادات إيجار مؤجلة', 'liability', 'C'],
  ['23200', 'VAT Payable (Output VAT)', 'ضريبة القيمة المضافة (مخرجات)', 'liability', 'C'],
  ['39004', 'Paid-in Capital', 'رأس المال', 'equity', 'C'],
  ['39005', 'Retained Earnings', 'أرباح مرحّلة', 'equity', 'C'],
  ['39999', 'Opening Balance Equity', 'حقوق ملكية افتتاحية', 'equity', 'C'],
  ['40000', 'Realized Rent Income', 'إيرادات تأجير محققة', 'income', 'C'],
  ['40500', 'Services Income', 'إيرادات خدمات (مواقف/غسيل/صيانة)', 'income', 'C'],
  ['41000', 'Other Income', 'إيرادات أخرى', 'income', 'C'],
  ['61000', 'Auto Expenses', 'مصاريف سيارات', 'expense', 'D'],
  ['62000', 'Bank Charges', 'مصاريف بنكية', 'expense', 'D'],
  ['65000', 'Marketing & Commission', 'عمولات وتسويق', 'expense', 'D'],
  ['68000', 'Laundry and Cleaning Expense', 'مصاريف نظافة', 'expense', 'D'],
  ['70000', 'Maintenance & Operating Expense', 'مصاريف صيانة وتشغيل', 'expense', 'D'],
  ['71000', 'Depreciation Expense', 'مصروف الإهلاك', 'expense', 'D'],
  ['73000', 'Other Taxes', 'ضرائب أخرى', 'expense', 'D'],
  ['77000', 'Salaries Expense', 'مصروف الرواتب', 'expense', 'D'],
  ['78000', 'Utilities Expense', 'مصاريف مرافق', 'expense', 'D'],
  ['89000', 'Other Expense', 'مصاريف أخرى', 'expense', 'D'],
];
const insAcc = db.prepare('INSERT OR IGNORE INTO accounts (code,name,name_ar,type,normal_balance) VALUES (?,?,?,?,?)');
for (const a of ACCOUNTS) insAcc.run(...a);

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

// ---- Opening balances (exact from client's TB, dated 2026-02-28) ----------
if (!db.prepare("SELECT 1 FROM journals WHERE jtype='opening'").get()) {
  const OB = [
    ['10000', 183.06, 0], ['10400', 127726.79, 0], ['10500', 4710.04, 0],
    ['11000', 555.00, 0], ['11100', 22257.50, 0], ['11500', 0, 12520.00],
    ['15500', 2129778.00, 0], ['16900', 850000.00, 0], ['17500', 0, 702821.00],
    ['20000', 0, 1625.23], ['23000', 0, 1884.76], ['23100', 0, 795.00],
    ['39004', 0, 2979778.00], ['39005', 620170.82, 0],
    ['40000', 0, 66165.00], ['41000', 0, 180.00],
    ['61000', 135.00, 0], ['62000', 2.05, 0], ['68000', 1391.75, 0],
    ['70000', 5649.08, 0], ['73000', 906.40, 0], ['77000', 950.00, 0],
    ['78000', 383.50, 0], ['89000', 970.00, 0],
  ];
  postJournal(
    { jdate: '2026-02-28', jtype: 'opening', reference: 'OB-2026', memo: 'Opening balances (from Trial Balance)', memo_ar: 'أرصدة افتتاحية' },
    OB.map(([code, d, c]) => ({ account_code: code, debit: d, credit: c }))
  );
}

console.log('Seed v2 complete:', {
  accounts: db.prepare('SELECT COUNT(*) c FROM accounts').get().c,
  buildings: db.prepare('SELECT COUNT(*) c FROM buildings').get().c,
  flats: db.prepare('SELECT COUNT(*) c FROM flats').get().c,
  banks: db.prepare('SELECT COUNT(*) c FROM banks').get().c,
  payment_methods: db.prepare('SELECT COUNT(*) c FROM payment_methods').get().c,
});
console.log('Login -> admin / admin123');
