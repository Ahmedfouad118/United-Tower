// ==========================================================================
// Central configuration: GL-account mapping per document type + module-name
// (label) overrides. Everything is stored in the `settings` table so the admin
// can re-map accounts and rename menus without a code change.
//   - acct('vendor_payable')  -> the account new vendor bills/opening post to
//   - labels()                -> { m_customers:'...', ... } overrides for t()
// ==========================================================================
const { db } = require('./db');

// key -> default account code. These are the "document type -> account" choices
// the CONFIGURATION screen exposes. Changing one affects NEW postings only.
const ACCT_DEFAULTS = {
  tenant_recv:      '11100', // فاتورة العميل (مدين) / رصيد افتتاحي مدين
  ar:               '11000', // ذمم مدينة أخرى
  rent_income:      '40000', // إيراد الإيجار (دائن الفاتورة)
  other_income:     '41000',
  output_vat:       '23200', // ض.ق.م المستحقة (فاتورة)
  input_vat:        '11600', // ض.ق.م المدخلات (فاتورة مورد)
  deferred_advance: '23100', // الدفعات المقدمة من العملاء (سند قبض زائد)
  customer_advance: '21500', // دفعات العملاء (النظام القديم)
  vendor_payable:   '23000', // مورد: الفاتورة + الرصيد الافتتاحي  (كان 20000)
  deposits_held:    '21000', // تأمينات محتجزة
  cash:             '10000', // الصندوق
  bank:             '10400', // البنك
  opening_equity:   '39999', // حقوق ملكية افتتاحية (الطرف المقابل للأرصدة)
};

// human labels (Arabic) for the config screen
const ACCT_LABELS = {
  tenant_recv:      'ذمم العملاء (فاتورة/افتتاحي مدين)',
  ar:               'ذمم مدينة أخرى',
  rent_income:      'إيراد الإيجار',
  other_income:     'إيرادات أخرى',
  output_vat:       'ض.ق.م المستحقة (مخرجات)',
  input_vat:        'ض.ق.م المدخلات',
  deferred_advance: 'الدفعات المقدمة من العملاء',
  customer_advance: 'دفعات العملاء (قديم)',
  vendor_payable:   'حساب الموردين (فاتورة/افتتاحي)',
  deposits_held:    'التأمينات المحتجزة',
  cash:             'الصندوق',
  bank:             'البنك الرئيسي',
  opening_equity:   'حقوق الملكية الافتتاحية',
};

const KEY = (k) => 'acct.' + k;

function acct(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(KEY(key));
  const v = row && row.value ? String(row.value).trim() : '';
  return v || ACCT_DEFAULTS[key];
}

function allAccts() {
  const out = {};
  for (const k of Object.keys(ACCT_DEFAULTS)) out[k] = { code: acct(k), default: ACCT_DEFAULTS[k], label: ACCT_LABELS[k] };
  return out;
}

function setAccts(map) {
  const set = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
  for (const [k, v] of Object.entries(map || {})) {
    if (!(k in ACCT_DEFAULTS)) continue;
    set.run(KEY(k), v == null ? '' : String(v).trim());
  }
}

// ---- Module / menu label overrides ---------------------------------------
// Stored as one JSON blob under settings key 'labels' -> { lang: { key: text } }
function labels() {
  const row = db.prepare("SELECT value FROM settings WHERE key='labels'").get();
  if (!row || !row.value) return {};
  try { return JSON.parse(row.value); } catch { return {}; }
}
function setLabels(obj) {
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)')
    .run('labels', JSON.stringify(obj || {}));
}

module.exports = { acct, allAccts, setAccts, labels, setLabels, ACCT_DEFAULTS, ACCT_LABELS };
