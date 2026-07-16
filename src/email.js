// Invoice email: builds an Outlook-ready .eml draft (X-Unsent) with the
// invoice(s) attached, addressed to the customer. Opening the .eml launches
// Outlook with a ready-to-review draft. Bulk = one draft per customer.
const express = require('express');
const { db } = require('./db');
const { authMiddleware } = require('./auth');

const router = express.Router();
router.use(authMiddleware);

const setting = (k, def) => (db.prepare('SELECT value FROM settings WHERE key=?').get(k) || {}).value || def;
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const enc = (s) => `=?UTF-8?B?${b64(String(s || ''))}?=`; // RFC2047 header encoding

function invoiceHTML(inv) {
  const company = setting('company_name', 'United Tower');
  const logo = setting('company_logo', '');
  const cr = setting('cr_number', ''); const vatNo = setting('vat_number', '');
  const money = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  return `<!doctype html><html dir="rtl"><head><meta charset="utf-8"><style>
    body{font-family:'Segoe UI',Tahoma,sans-serif;color:#1f2a44;padding:24px}
    .hd{display:flex;justify-content:space-between;border-bottom:3px solid #1f6feb;padding-bottom:12px;margin-bottom:16px}
    .co{font-size:20px;font-weight:800;color:#1f6feb}.muted{color:#6b7a90;font-size:12px}
    table{width:100%;border-collapse:collapse;margin-top:10px}th,td{padding:8px 10px;border-bottom:1px solid #e3e9f2;text-align:right}
    th{background:#f4f7fb}.tot td{font-weight:700;border-top:2px solid #c9d6ea}
    .num{text-align:left;font-variant-numeric:tabular-nums}</style></head><body>
    <div class="hd"><div>${logo ? `<img src="${logo}" style="height:48px">` : ''}<div class="co">${company}</div>
      <div class="muted">${cr ? 'س.ت: ' + cr : ''} ${vatNo ? '· الرقم الضريبي: ' + vatNo : ''}</div></div>
      <div style="text-align:left"><h2 style="margin:0">فاتورة ضريبية</h2><div class="muted">${inv.invoice_no}</div>
      <div class="muted">${String(inv.due_date).slice(0, 10)}</div></div></div>
    <p><b>العميل:</b> ${inv.tenant} &nbsp; <b>الوحدة:</b> ${inv.flat} &nbsp; <b>الشهر:</b> ${inv.period}</p>
    <table><thead><tr><th>البيان</th><th class="num">المبلغ</th></tr></thead><tbody>
    <tr><td>إيجار ${inv.period}</td><td class="num">${money(inv.rent_amount)}</td></tr>
    <tr><td>ض.ق.م 5%</td><td class="num">${money(inv.vat_amount)}</td></tr></tbody>
    <tfoot><tr class="tot"><td>الإجمالي</td><td class="num">${money(inv.total)}</td></tr></tfoot></table>
    </body></html>`;
}

function buildEml({ from, to, subject, bodyHtml, attachments }) {
  const B = 'UT_BOUND_9271';
  const lines = [
    `From: ${from}`, `To: ${to}`, `Subject: ${enc(subject)}`,
    'X-Unsent: 1', 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${B}"`, '',
    `--${B}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(bodyHtml), '',
  ];
  for (const a of attachments) {
    lines.push(`--${B}`, `Content-Type: text/html; charset=utf-8; name="${a.name}"`,
      'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${a.name}"`, '', b64(a.html), '');
  }
  lines.push(`--${B}--`, '');
  return lines.join('\r\n');
}

// GET /invoices/eml?ids=1,2,3  -> one draft addressed to the (shared) customer
router.get('/invoices/eml', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((x) => +x).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'no invoices' });
  const rows = db.prepare(
    `SELECT i.*, t.name tenant, t.email tenant_email, f.code flat FROM invoices i
     JOIN tenants t ON t.id=i.tenant_id JOIN flats f ON f.id=i.flat_id
     WHERE i.id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  const to = rows[0].tenant_email || '';
  const from = setting('send_email', '');
  const months = [...new Set(rows.map((r) => r.period))].join('، ');
  const subject = `فاتورة إيجار شهر ${months} — ${setting('company_name', 'United Tower')}`;
  const body = `<div dir="rtl" style="font-family:Tahoma">تحية طيبة،<br><br>إليكم فاتورة/فواتير الإيجار لشهر ${months}.<br>
    ${rows.map((r) => `الوحدة ${r.flat}: ${Number(r.total).toFixed(3)} ر.ع`).join('<br>')}<br><br>مع خالص التقدير،<br>${setting('company_name', 'United Tower')}</div>`;
  const eml = buildEml({ from, to, subject, bodyHtml: body,
    attachments: rows.map((r) => ({ name: `${r.invoice_no}.html`, html: invoiceHTML(r) })) });
  res.setHeader('Content-Type', 'message/rfc822');
  res.setHeader('Content-Disposition', `attachment; filename="draft-${rows[0].tenant.replace(/[^a-zA-Z0-9]/g, '_')}.eml"`);
  res.send(eml);
});

// info for bulk grouping (frontend groups by customer, then calls /invoices/eml per group)
router.get('/invoices/email-groups', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((x) => +x).filter(Boolean);
  if (!ids.length) return res.json([]);
  const rows = db.prepare(
    `SELECT i.id, i.tenant_id, t.name tenant, t.email FROM invoices i JOIN tenants t ON t.id=i.tenant_id
     WHERE i.id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const groups = {};
  for (const r of rows) (groups[r.tenant_id] = groups[r.tenant_id] || { tenant: r.tenant, email: r.email, ids: [] }).ids.push(r.id);
  res.json(Object.values(groups));
});

module.exports = router;
