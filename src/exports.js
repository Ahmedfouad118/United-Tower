// Excel export + blank-template endpoints for every screen.
const express = require('express');
const XLSX = require('xlsx');
const { db } = require('./db');
const { authMiddleware } = require('./auth');
const R = require('./reports');

const router = express.Router();
router.use(authMiddleware);

// registry: type -> { rows(), columns:[{key,label}], template:[headers] }
const REG = {
  tenants: {
    rows: () => db.prepare('SELECT code,name,phone,email,civil_id,opening_balance FROM tenants ORDER BY name').all(),
    columns: [['code', 'Code'], ['name', 'Tenant Name'], ['phone', 'Phone'], ['email', 'Email'], ['civil_id', 'Civil ID'], ['opening_balance', 'Opening Balance']],
    template: ['Tenant Name', 'Phone', 'Email', 'Civil ID', 'Opening Balance'],
  },
  vendors: {
    rows: () => db.prepare('SELECT code,name,phone,email,tax_no,opening_balance FROM vendors ORDER BY name').all(),
    columns: [['code', 'Code'], ['name', 'Vendor Name'], ['phone', 'Phone'], ['email', 'Email'], ['tax_no', 'Tax No'], ['opening_balance', 'Opening Balance']],
    template: ['Vendor Name', 'Phone', 'Email', 'Tax No', 'Opening Balance'],
  },
  flats: {
    rows: () => db.prepare('SELECT f.code,b.name building,f.unit_type,f.floor,f.base_rent FROM flats f LEFT JOIN buildings b ON b.id=f.building_id ORDER BY f.code').all(),
    columns: [['code', 'Unit'], ['building', 'Building'], ['unit_type', 'Type'], ['floor', 'Floor'], ['base_rent', 'Base Rent']],
    template: ['U NO', 'Building', 'Type', 'Floor', 'Base Rent'],
  },
  buildings: {
    rows: () => db.prepare('SELECT code,name,name_ar,address,owner,purchase_value FROM buildings ORDER BY name').all(),
    columns: [['code', 'Code'], ['name', 'Name'], ['name_ar', 'Name (AR)'], ['address', 'Address'], ['owner', 'Owner'], ['purchase_value', 'Purchase Value']],
    template: ['Code', 'Name', 'Name (AR)', 'Address', 'Owner', 'Purchase Value'],
  },
  contracts: {
    rows: () => db.prepare('SELECT c.contract_no,t.name tenant,f.code flat,c.start_date,c.end_date,c.monthly_rent,c.vat_percent,c.deposit,c.status FROM contracts c JOIN tenants t ON t.id=c.tenant_id JOIN flats f ON f.id=c.flat_id ORDER BY c.id DESC').all(),
    columns: [['contract_no', 'Agreement No'], ['tenant', 'Tenant Name'], ['flat', 'U NO'], ['start_date', 'Per-Frm'], ['end_date', 'Per-To'], ['monthly_rent', 'Rent'], ['vat_percent', 'VAT %'], ['deposit', 'Deposit'], ['status', 'Status']],
    template: ['Tenant Name', 'U NO', 'Per-Frm', 'Per-To', 'Rent', 'Agreement No', 'Remarks'],
  },
  invoices: {
    rows: () => db.prepare('SELECT i.invoice_no,t.name tenant,f.code flat,i.period,i.due_date,i.rent_amount,i.vat_amount,i.total,i.paid_amount,i.status FROM invoices i JOIN tenants t ON t.id=i.tenant_id JOIN flats f ON f.id=i.flat_id ORDER BY i.due_date DESC').all(),
    columns: [['invoice_no', 'Invoice No'], ['tenant', 'Tenant'], ['flat', 'Unit'], ['period', 'Period'], ['due_date', 'Due Date'], ['rent_amount', 'Rent'], ['vat_amount', 'VAT'], ['total', 'Total'], ['paid_amount', 'Paid'], ['status', 'Status']],
    template: ['Tenant', 'Unit', 'Period', 'Rent', 'VAT %'],
  },
  'vendor-bills': {
    rows: () => db.prepare('SELECT b.bill_no,b.bdate,v.name vendor,a.name account,b.description,b.amount,b.vat_amount,b.total,b.status FROM vendor_bills b LEFT JOIN vendors v ON v.id=b.vendor_id JOIN accounts a ON a.code=b.expense_code ORDER BY b.bdate DESC').all(),
    columns: [['bill_no', 'Bill No'], ['bdate', 'Date'], ['vendor', 'Vendor'], ['account', 'Account'], ['description', 'Description'], ['amount', 'Amount'], ['vat_amount', 'VAT'], ['total', 'Total'], ['status', 'Status']],
    template: ['Date', 'Vendor', 'Account Code', 'Description', 'Amount', 'VAT %'],
  },
  categories: { rows: () => db.prepare('SELECT entity,name,name_ar FROM categories').all(), columns: [['entity', 'Entity'], ['name', 'Name'], ['name_ar', 'Name AR']], template: ['Entity', 'Name', 'Name AR'] },
  assets: {
    rows: () => db.prepare('SELECT a.code,a.name,b.name building,a.category,a.cost,a.salvage_value,a.life_years,a.accum_depreciation,a.status FROM assets a LEFT JOIN buildings b ON b.id=a.building_id ORDER BY a.name').all(),
    columns: [['code', 'Code'], ['name', 'Name'], ['building', 'Building'], ['category', 'Category'], ['cost', 'Cost'], ['salvage_value', 'Salvage'], ['life_years', 'Life (yrs)'], ['accum_depreciation', 'Accum Dep'], ['status', 'Status']],
    template: ['Code', 'Name', 'Category', 'Cost', 'Salvage', 'Life (yrs)', 'Purchase Date'],
  },
  payments: {
    rows: () => db.prepare('SELECT p.voucher_no,p.pdate,t.name tenant,f.code flat,p.amount,p.applied_amount,p.advance_amount,p.method FROM payments p JOIN tenants t ON t.id=p.tenant_id LEFT JOIN flats f ON f.id=p.flat_id ORDER BY p.pdate DESC').all(),
    columns: [['voucher_no', 'Voucher'], ['pdate', 'Date'], ['tenant', 'Tenant'], ['flat', 'Unit'], ['amount', 'Amount'], ['applied_amount', 'Applied'], ['advance_amount', 'Advance'], ['method', 'Method']],
    template: ['Date', 'Payee/Tenant', 'Flat', 'Amount'],
  },
  'vendor-bills': {
    rows: () => db.prepare('SELECT b.bill_no,b.bdate,v.name vendor,a.name account,b.description,b.amount,b.vat_amount,b.total,b.status FROM vendor_bills b LEFT JOIN vendors v ON v.id=b.vendor_id JOIN accounts a ON a.code=b.expense_code ORDER BY b.bdate DESC').all(),
    columns: [['bill_no', 'Bill No'], ['bdate', 'Date'], ['vendor', 'Vendor'], ['account', 'Account'], ['description', 'Description'], ['amount', 'Amount'], ['vat_amount', 'VAT'], ['total', 'Total'], ['status', 'Status']],
    template: ['Date', 'Vendor', 'Account', 'Description', 'Amount', 'VAT'],
  },
  'vendor-payments': {
    rows: () => db.prepare('SELECT p.voucher_no,p.pdate,v.name vendor,p.amount,p.method FROM vendor_payments p LEFT JOIN vendors v ON v.id=p.vendor_id ORDER BY p.pdate DESC').all(),
    columns: [['voucher_no', 'Voucher'], ['pdate', 'Date'], ['vendor', 'Vendor'], ['amount', 'Amount'], ['method', 'Method']],
  },
  employees: {
    rows: () => db.prepare('SELECT name,job_title,salary,active FROM employees ORDER BY name').all(),
    columns: [['name', 'Name'], ['job_title', 'Job Title'], ['salary', 'Salary'], ['active', 'Active']],
    template: ['Name', 'Job Title', 'Salary'],
  },
  cheques: {
    rows: () => db.prepare('SELECT direction,cheque_no,party,amount,issue_date,due_date,status FROM cheques ORDER BY due_date').all(),
    columns: [['direction', 'Direction'], ['cheque_no', 'Cheque No'], ['party', 'Party'], ['amount', 'Amount'], ['issue_date', 'Issue Date'], ['due_date', 'Due Date'], ['status', 'Status']],
    template: ['Direction (incoming/outgoing)', 'Cheque No', 'Bank', 'Party', 'Amount', 'Issue Date', 'Due Date'],
  },
  accounts: {
    rows: () => db.prepare('SELECT code,name,name_ar,type,normal_balance FROM accounts ORDER BY code').all(),
    columns: [['code', 'Code'], ['name', 'Name'], ['name_ar', 'Name (AR)'], ['type', 'Type'], ['normal_balance', 'Normal']],
    template: ['Code', 'Name', 'Name (AR)', 'Type', 'Normal'],
  },
  banks: {
    rows: () => db.prepare('SELECT name,branch,account_no,iban,swift,currency FROM banks ORDER BY name').all(),
    columns: [['name', 'Bank'], ['branch', 'Branch'], ['account_no', 'Account No'], ['iban', 'IBAN'], ['swift', 'SWIFT'], ['currency', 'Currency']],
    template: ['Bank', 'Branch', 'Account No', 'IBAN', 'SWIFT', 'Currency'],
  },
  'bank-statement': {
    rows: () => db.prepare(`SELECT s.txn_date,s.description,s.debit,s.credit,s.reconciled,b.name bank
      FROM bank_statement_lines s LEFT JOIN banks b ON b.id=s.bank_id ORDER BY s.txn_date`).all(),
    columns: [['bank', 'Bank'], ['txn_date', 'Date'], ['description', 'Description'], ['debit', 'Debit (out)'], ['credit', 'Credit (in)'], ['reconciled', 'Reconciled']],
    template: ['Date', 'Description', 'Debit (out)', 'Credit (in)'],
  },
  journals: {
    rows: () => db.prepare(`SELECT j.jdate,j.reference,j.memo,l.account_code,a.name account,l.debit,l.credit
      FROM journal_lines l JOIN journals j ON j.id=l.journal_id JOIN accounts a ON a.code=l.account_code ORDER BY j.jdate DESC, j.id LIMIT 2000`).all(),
    columns: [['reference', 'Ref'], ['jdate', 'Date'], ['account_code', 'Account Code'], ['account', 'Account'], ['debit', 'Debit'], ['credit', 'Credit'], ['memo', 'Memo']],
    template: ['Ref', 'Date', 'Account Code', 'Debit', 'Credit', 'Memo', 'Building'],
  },
};

function sendWorkbook(res, aoa, name) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
  res.send(buf);
}

router.get('/export/:type', (req, res) => {
  const reg = REG[req.params.type];
  if (!reg) return res.status(404).json({ error: 'unknown type' });
  const rows = reg.rows();
  const aoa = [reg.columns.map((c) => c[1])];
  for (const r of rows) aoa.push(reg.columns.map((c) => r[c[0]] ?? ''));
  sendWorkbook(res, aoa, req.params.type + '-export');
});

router.get('/template/:type', (req, res) => {
  const reg = REG[req.params.type];
  if (!reg || !reg.template) return res.status(404).json({ error: 'no template' });
  sendWorkbook(res, [reg.template], req.params.type + '-template');
});

// export any report table (rows passed as query not practical -> dedicated)
router.get('/export-report/:name', (req, res) => {
  const { name } = req.params;
  let aoa;
  if (name === 'trial-balance') {
    const r = R.trialBalance(req.query.upto, 'en');
    aoa = [['Code', 'Account', 'Debit', 'Credit'], ...r.rows.map((x) => [x.code, x.name, x.debit, x.credit]), ['', 'Total', r.total_debit, r.total_credit]];
  } else if (name === 'aging') {
    const r = R.receivablesAging(req.query.asOf);
    aoa = [['Tenant', 'Current', '1-30', '31-60', '61-90', '91-180', '180+', 'Total'], ...r.rows.map((x) => [x.tenant, x.current, x.d30, x.d60, x.d90, x.d180, x.d180p, x.total])];
  } else if (name === 'income-statement') {
    const r = R.incomeStatement(req.query.from, req.query.to, 'en');
    aoa = [['Section', 'Code', 'Account', 'Amount'],
      ...r.income.map((x) => ['Income', x.code, x.name, x.amt]), ['', '', 'Total Income', r.total_income],
      ...r.expense.map((x) => ['Expense', x.code, x.name, x.amt]), ['', '', 'Total Expense', r.total_expense], ['', '', 'Net', r.net]];
  } else if (name === 'balance-sheet') {
    const r = R.balanceSheet(req.query.upto, 'en');
    aoa = [['Section', 'Code', 'Account', 'Amount'],
      ...r.assets.map((x) => ['Asset', x.code, x.name, x.amt]), ['', '', 'Total Assets', r.total_assets],
      ...r.liabilities.map((x) => ['Liability', x.code, x.name, x.amt]), ['', '', 'Total Liabilities', r.total_liabilities],
      ...r.equity.map((x) => ['Equity', x.code, x.name, x.amt]), ['', '', 'Net Income', r.net_income], ['', '', 'Total Equity', r.total_equity]];
  } else if (name === 'general-ledger') {
    const acc = req.query.account;
    aoa = [['Date', 'Ref', 'Account', 'Party', 'Memo', 'Debit', 'Credit', 'Balance']];
    if (acc) {
      const r = R.accountLedger({ account: acc, from: req.query.from, to: req.query.to }, 'en');
      if (Math.abs(r.opening) > 0.005) aoa.push(['', '', '', '', 'Opening', '', '', r.opening]);
      for (const x of r.rows) aoa.push([x.jdate, x.reference, x.account_name, x.tenant || x.vendor || '', x.memo, x.debit, x.credit, x.balance]);
      aoa.push(['', '', '', '', 'Total', r.total_debit, r.total_credit, r.closing]);
    } else {
      const r = R.generalLedgerFull({ from: req.query.from, to: req.query.to }, 'en');
      for (const a of r.accounts) {
        aoa.push([`${a.code} - ${a.name}`]);
        if (Math.abs(a.opening) > 0.005) aoa.push(['', '', '', '', 'Opening', '', '', a.opening]);
        for (const x of a.rows) aoa.push([x.jdate, x.reference, '', x.party, x.memo, x.debit, x.credit, x.balance]);
        aoa.push(['', '', '', '', 'Total', a.total_debit, a.total_credit, a.closing]);
        aoa.push([]);
      }
    }
  } else if (name === 'income-statement-consolidated') {
    const r = R.incomeStatementConsolidated(req.query.year, 'en', req.query.building_id ? Number(req.query.building_id) : null);
    const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const hdr = ['Code', 'Account', ...MO, 'Total'];
    const line = (x) => [x.code, x.name, ...x.months, x.total];
    aoa = [[`Consolidated Income Statement — ${r.year}`], hdr,
      ['', 'INCOME'], ...r.income.map(line), ['', 'Total Income', ...r.total_income.months, r.total_income.total],
      ['', ''], ['', 'EXPENSES'], ...r.expense.map(line), ['', 'Total Expense', ...r.total_expense.months, r.total_expense.total],
      ['', ''], ['', 'NET PROFIT', ...r.net.months, r.net.total]];
  } else return res.status(404).json({ error: 'unknown report' });
  sendWorkbook(res, aoa, name);
});

module.exports = router;
