// Oman Tax Authority "Taxpayer Checklist" workbook, filled from the books:
//   Std Rated Sales - Box 1(a)  = every customer invoice that carries VAT   (output)
//   Input Tax - Box 6(a)        = every vendor bill that carries VAT        (input)
// The authority's own workbook is the template (assets/vat_checklist_template.xlsx, personal data
// removed), so sheets, columns, widths, fonts and borders stay exactly as the authority issues them.
// Details start on the template's first data row; the Total row follows the last detail row.
const path = require('path');
const ExcelJS = require('exceljs');
const { db } = require('./db');

const TEMPLATE = path.join(__dirname, '..', 'assets', 'vat_checklist_template.xlsx');
const setting = (k, d = '') => (db.prepare('SELECT value FROM settings WHERE key=?').get(k) || {}).value || d;
const r3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const ymd = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const dmy = (s) => { const x = String(s).slice(0, 10).split('-'); return `${x[2]}/${x[1]}/${x[0]}`; };
const dmy2 = (s) => { const x = String(s).slice(0, 10).split('-'); return `${x[2]}/${x[1]}/${x[0].slice(2)}`; };
const lastDay = (period) => { const [y, m] = period.split('-').map(Number); return `${period}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };

// copy style of a template row onto another row (all columns)
function cloneRowStyle(ws, fromRow, toRow, cols) {
  for (let c = 1; c <= cols; c++) ws.getCell(toRow, c).style = JSON.parse(JSON.stringify(ws.getCell(fromRow, c).style || {}));
  ws.getRow(toRow).height = ws.getRow(fromRow).height;
}
// make room: the template has `slots` detail rows; if there are more details, insert blank rows
// above the first spare row so the Total / notes block moves down with its formatting.
function ensureRows(ws, firstRow, slots, needed, cols) {
  const extra = needed - slots;
  if (extra <= 0) return;
  const at = firstRow + slots; // first row after the template's detail block
  ws.spliceRows(at, 0, ...Array.from({ length: extra }, () => []));
  for (let i = 0; i < extra; i++) cloneRowStyle(ws, firstRow, at + i, cols);
}

function outputInvoices(from, to) {
  return db.prepare(
    `SELECT i.invoice_no, i.idate, i.period, i.rent_amount, i.service_amount, i.vat_amount, i.total,
            t.name tenant, t.tax_no tenant_vatin, f.code flat
       FROM invoices i JOIN tenants t ON t.id=i.tenant_id LEFT JOIN flats f ON f.id=i.flat_id
      WHERE i.status!='cancelled' AND i.vat_amount>0 AND i.idate>=? AND i.idate<=?
      ORDER BY i.idate, i.id`).all(from, to);
}
function inputBills(from, to) {
  return db.prepare(
    `SELECT b.bill_no, b.bdate, b.description, b.amount, b.vat_amount, v.name vendor, v.tax_no vendor_vatin
       FROM vendor_bills b LEFT JOIN vendors v ON v.id=b.vendor_id
      WHERE b.vat_amount>0 AND b.bdate>=? AND b.bdate<=?
      ORDER BY b.bdate, b.id`).all(from, to);
}

async function buildVatChecklist(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) throw new Error('from/to must be YYYY-MM-DD');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);
  const vatin = setting('vat_number'), legal = setting('company_name') || '';

  // ---- cover sheet: identification + return period end
  const chk = wb.getWorksheet('Taxpayer Checklist');
  chk.getCell('D5').value = vatin; chk.getCell('D6').value = legal; chk.getCell('D7').value = ymd(to);

  // ---- OUTPUT: Std Rated Sales - Box 1(a)
  const out = wb.getWorksheet('Std Rated Sales - Box 1(a)');
  const inv = outputInvoices(from, to);
  const OUT_FIRST = 4, OUT_SLOTS = 13;
  ensureRows(out, OUT_FIRST, OUT_SLOTS, inv.length, 11);
  inv.forEach((x, i) => {
    const r = OUT_FIRST + i, net = r3(x.rent_amount + (x.service_amount || 0));
    out.getCell(r, 1).value = i + 1;
    out.getCell(r, 2).value = vatin;
    out.getCell(r, 3).value = legal;
    out.getCell(r, 4).value = x.invoice_no;
    out.getCell(r, 5).value = ymd(x.idate);
    out.getCell(r, 6).value = `(From ${dmy(`${x.period}-01`)} to ${dmy(lastDay(x.period))})`;
    out.getCell(r, 7).value = net;
    // keep the authority's formula when the VAT really is 5% of the amount, else show the booked VAT
    out.getCell(r, 8).value = Math.abs(r3(net * 0.05) - r3(x.vat_amount)) < 0.0015
      ? { formula: `G${r}*0.05`, result: r3(x.vat_amount) } : r3(x.vat_amount);
    out.getCell(r, 9).value = x.tenant;
    out.getCell(r, 10).value = x.tenant_vatin || null;
    out.getCell(r, 11).value = x.flat ? `Rent — ${String(x.flat).trim()}` : 'Rent';
  });
  const outLast = OUT_FIRST + Math.max(inv.length, OUT_SLOTS) - 1;
  const outTot = outLast + 2; // template keeps one blank row between the details and the Total row
  out.getCell(outTot, 7).value = { formula: `SUM(G${OUT_FIRST}:G${outLast})`, result: r3(inv.reduce((s, x) => s + x.rent_amount + (x.service_amount || 0), 0)) };
  out.getCell(outTot, 8).value = { formula: `SUM(H${OUT_FIRST}:H${outLast})`, result: r3(inv.reduce((s, x) => s + x.vat_amount, 0)) };

  // ---- INPUT: Input Tax - Box 6(a)
  const inp = wb.getWorksheet('Input Tax - Box 6(a)');
  const bills = inputBills(from, to);
  const IN_FIRST = 4, IN_SLOTS = 7;
  ensureRows(inp, IN_FIRST, IN_SLOTS, bills.length, 13);
  bills.forEach((b, i) => {
    const r = IN_FIRST + i;
    inp.getCell(r, 1).value = i + 1;
    inp.getCell(r, 2).value = vatin;
    inp.getCell(r, 3).value = legal;
    inp.getCell(r, 4).value = b.bill_no;
    inp.getCell(r, 5).value = ymd(b.bdate);
    inp.getCell(r, 6).value = ymd(b.bdate);
    inp.getCell(r, 7).value = `${dmy2(from)}-${dmy2(to)}`;
    inp.getCell(r, 8).value = r3(b.amount);
    inp.getCell(r, 9).value = Math.abs(r3(b.amount * 0.05) - r3(b.vat_amount)) < 0.0015
      ? { formula: `H${r}*0.05`, result: r3(b.vat_amount) } : r3(b.vat_amount);
    inp.getCell(r, 10).value = { formula: `I${r}`, result: r3(b.vat_amount) };
    inp.getCell(r, 11).value = b.vendor || '';
    inp.getCell(r, 12).value = b.vendor_vatin || null;
    inp.getCell(r, 13).value = b.description || '';
  });
  const inLast = IN_FIRST + Math.max(bills.length, IN_SLOTS) - 1;
  const inTot = inLast + 4; // template: details to row 10, Total on row 14
  const sum = (k) => r3(bills.reduce((s, b) => s + (k === 'amount' ? b.amount : b.vat_amount), 0));
  inp.getCell(inTot, 8).value = { formula: `SUM(H${IN_FIRST}:H${inLast})`, result: sum('amount') };
  inp.getCell(inTot, 9).value = { formula: `SUM(I${IN_FIRST}:I${inLast})`, result: sum('vat') };
  inp.getCell(inTot, 10).value = { formula: `SUM(J${IN_FIRST}:J${inLast})`, result: sum('vat') };
  inp.getCell(inTot + 2, 10).value = { formula: "'RCM Purchases - Box 2(b)'!O22", result: 0 };
  inp.getCell(inTot + 4, 10).value = { formula: `J${inTot}+J${inTot + 2}`, result: sum('vat') };

  const buf = await wb.xlsx.writeBuffer();
  return { buffer: Buffer.from(buf), output: { count: inv.length, vat: r3(inv.reduce((s, x) => s + x.vat_amount, 0)) }, input: { count: bills.length, vat: sum('vat') } };
}

module.exports = { buildVatChecklist, outputInvoices, inputBills };
