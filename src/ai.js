// AI assistant — a Claude-powered chat with read access to the ledger and the
// ability to post journals / generate invoices / record receipts on request.
// The Anthropic API key comes from settings (ai_api_key) or env UT_ANTHROPIC_KEY.
const express = require('express');
const { db } = require('./db');
const { authMiddleware, requireRole } = require('./auth');
const { postJournal } = require('./ledger');
const svc = require('./services');

const router = express.Router();
router.use(authMiddleware);

const getKey = () =>
  process.env.UT_ANTHROPIC_KEY ||
  (db.prepare("SELECT value FROM settings WHERE key='ai_api_key'").get() || {}).value || '';

const MODEL = 'claude-sonnet-5';

// ---- Tools the assistant can call ----------------------------------------
const TOOLS = [
  { name: 'query_db', description: 'Run a READ-ONLY SQL SELECT against the accounting database and return rows as JSON. Use this to answer any question about tenants, contracts, invoices, payments, journals, account balances, reports, etc.',
    input_schema: { type: 'object', properties: { sql: { type: 'string', description: 'A single SQL SELECT statement (SQLite).' } }, required: ['sql'] } },
  { name: 'post_journal', description: 'Post a balanced double-entry journal. lines is an array of {account_code, debit, credit, memo}. Sum of debit must equal sum of credit.',
    input_schema: { type: 'object', properties: { jdate: { type: 'string' }, memo: { type: 'string' }, reference: { type: 'string' },
      lines: { type: 'array', items: { type: 'object', properties: { account_code: { type: 'string' }, debit: { type: 'number' }, credit: { type: 'number' }, memo: { type: 'string' } }, required: ['account_code'] } } }, required: ['jdate', 'lines'] } },
  { name: 'generate_invoices', description: 'Generate the monthly rent invoices for all active contracts for a period (YYYY-MM).',
    input_schema: { type: 'object', properties: { period: { type: 'string' } }, required: ['period'] } },
  { name: 'record_receipt', description: 'Record a tenant receipt (سند قبض). Amount is auto-allocated to the tenant\'s open invoices.',
    input_schema: { type: 'object', properties: { tenant_id: { type: 'number' }, amount: { type: 'number' }, pdate: { type: 'string' }, method: { type: 'string' }, memo: { type: 'string' } }, required: ['tenant_id', 'amount'] } },
];

function schemaHint() {
  const accts = db.prepare("SELECT code,name,type FROM accounts WHERE is_active=1 ORDER BY code").all()
    .map((a) => `${a.code} ${a.name} (${a.type})`).join('; ');
  return `Database tables: accounts(code,name,name_ar,type,normal_balance); journals(id,jdate,jtype,reference,memo,source_table,source_id); journal_lines(id,journal_id,account_code,debit,credit,building_id,flat_id,tenant_id,vendor_id,memo); tenants(id,name,phone,email); vendors(id,name); flats(id,code,building_id); buildings(id,name); contracts(id,contract_no,flat_id,tenant_id,start_date,end_date,monthly_rent,vat_percent,status); invoices(id,invoice_no,tenant_id,flat_id,period,due_date,rent_amount,vat_amount,total,paid_amount,status); payments(id,voucher_no,pdate,tenant_id,amount,applied_amount,advance_amount,method); vendor_bills(id,vendor_id,bdate,expense_code,amount,total,status); employees(id,name,salary); cheques(id,direction,cheque_no,amount,due_date,status).
Account balance = SUM(debit)-SUM(credit) over journal_lines for that account_code. Chart of accounts: ${accts}. Currency OMR (3 decimals). Today is ${new Date().toISOString().slice(0, 10)}.`;
}

function runTool(name, input, user) {
  if (name === 'query_db') {
    const sql = String(input.sql || '').trim();
    if (!/^select/i.test(sql) || /[;]\s*\S/.test(sql) || /\b(insert|update|delete|drop|alter|create|attach|pragma)\b/i.test(sql))
      return { error: 'only a single read-only SELECT is allowed' };
    try { return { rows: db.prepare(sql).all().slice(0, 200) }; } catch (e) { return { error: e.message }; }
  }
  if (!['admin', 'accountant'].includes(user.role)) return { error: 'no permission to modify data' };
  try {
    if (name === 'post_journal') {
      const id = postJournal({ jdate: input.jdate, jtype: 'manual', reference: input.reference || 'AI', memo: input.memo, created_by: user.id }, input.lines);
      return { ok: true, journal_id: id };
    }
    if (name === 'generate_invoices') return svc.issueInvoicesForPeriod(input.period, user.id);
    if (name === 'record_receipt') return svc.recordPayment({ ...input }, user.id);
  } catch (e) { return { error: e.message }; }
  return { error: 'unknown tool' };
}

router.post('/ai/chat', async (req, res) => {
  const key = getKey();
  if (!key) return res.status(400).json({ error: 'لم يتم ضبط مفتاح الذكاء الاصطناعي. أدخله في الإعدادات ← بيانات البناية.' });
  const messages = Array.isArray(req.body.messages) ? req.body.messages.slice(-20) : [{ role: 'user', content: String(req.body.message || '') }];
  const system = `أنت مساعد محاسبي داخل نظام "برج المتحدة" لإدارة العقارات. تجاوب بالعربية باختصار ووضوح. لديك أدوات للاستعلام عن قاعدة البيانات وتنفيذ العمليات (قيود/فواتير/سندات قبض). استعلم من قاعدة البيانات قبل أي إجابة رقمية. قبل تنفيذ أي عملية كتابية (قيد/فاتورة) نفّذها فقط لو طلب المستخدم صراحةً. ${schemaHint()}`;
  try {
    let msgs = messages.map((m) => ({ role: m.role, content: m.content }));
    for (let step = 0; step < 6; step++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, tools: TOOLS, messages: msgs }),
      });
      const data = await r.json();
      if (data.type === 'error' || data.error) return res.status(400).json({ error: (data.error && data.error.message) || 'AI error' });
      msgs.push({ role: 'assistant', content: data.content });
      const toolUses = (data.content || []).filter((b) => b.type === 'tool_use');
      if (!toolUses.length) {
        const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        return res.json({ reply: text, messages: msgs });
      }
      const results = toolUses.map((tu) => ({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(runTool(tu.name, tu.input, req.user)) }));
      msgs.push({ role: 'user', content: results });
    }
    res.json({ reply: 'تم تجاوز عدد الخطوات المسموح.', messages: msgs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
