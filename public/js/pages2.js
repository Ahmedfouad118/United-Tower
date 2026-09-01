// Vendors, finance, reports, masters, users/permissions.
Object.assign(Pages, (() => {
  const { esc, money, int, dateStr, today, curMonth, toast, modal, table, badge, statusBadge, toolbar, wireToolbar, actions, importModal, formModal, printReport } = UI;
  const { ref, clearCache, canWrite, isAdmin, canDo, printTable, voucherPrint, cache } = Pages._h;
  const loading = (c) => c.innerHTML = '<div class="spinner"></div>';
  const M = (c, cfg) => Pages.masterScreen(c, cfg);
  const catOpts = async (entity) => (await ref('categories')).filter((x) => x.entity === entity).map((x) => ({ value: x.id, label: x.name }));

  // ---- Masters (via generic screen) ----
  const customers = (c) => M(c, {
    title: t('m_customers'), endpoint: 'tenants', type: 'tenants', template: true, import: true, wide: true,
    columns: [{ key: 'code', label: t('code') }, { key: 'name', label: t('name') }, { key: 'phone', label: t('phone') },
      { key: 'email', label: t('email') }, { key: 'opening_balance', label: t('opening_balance'), num: true, render: (r) => money(r.opening_balance) }],
    fields: [{ key: 'name', label: t('name'), required: true }, { key: 'phone', label: t('phone') }, { key: 'email', label: t('email') },
      { key: 'civil_id', label: t('civil_id') }, { key: 'opening_balance', label: t('opening_balance'), type: 'number', step: '0.001', value: 0 }, { key: 'notes', label: 'ملاحظات', full: true }],
    rowActions: ['view', 'edit', 'delete'],
    onView: (r) => { location.hash = '#/statement?tenant=' + r.id; },
    newLabel: t('new_customer'),
  });
  const vendors = (c) => M(c, {
    title: t('m_vendors'), endpoint: 'vendors', type: 'vendors', template: true, import: true, wide: true,
    columns: [{ key: 'code', label: t('code') }, { key: 'name', label: t('name') }, { key: 'phone', label: t('phone') },
      { key: 'email', label: t('email') }, { key: 'tax_no', label: 'الرقم الضريبي' }, { key: 'opening_balance', label: t('opening_balance'), num: true, render: (r) => money(r.opening_balance) }],
    fields: [{ key: 'name', label: t('name'), required: true }, { key: 'phone', label: t('phone') }, { key: 'email', label: t('email') },
      { key: 'tax_no', label: 'الرقم الضريبي' }, { key: 'opening_balance', label: t('opening_balance'), type: 'number', step: '0.001', value: 0 }],
  });
  async function buildings(c) {
    return M(c, { title: t('m_buildings'), endpoint: 'buildings', type: 'buildings', template: true, import: true, wide: true,
      columns: [{ key: 'code', label: t('code') }, { key: 'name', label: t('name') }, { key: 'name_ar', label: 'عربي' }, { key: 'address', label: 'العنوان' }, { key: 'owner', label: 'المالك' }, { key: 'purchase_value', label: 'قيمة الشراء', num: true, render: (r) => money(r.purchase_value) }],
      fields: [{ key: 'code', label: t('code'), required: true }, { key: 'name', label: t('name'), required: true }, { key: 'name_ar', label: 'الاسم عربي' }, { key: 'address', label: 'العنوان', full: true }, { key: 'owner', label: 'المالك' }, { key: 'purchase_value', label: 'قيمة الشراء', type: 'number', step: '0.001', value: 0 }] });
  }
  async function units(c) {
    const bl = await ref('buildings');
    await M(c, { title: t('m_units'), endpoint: 'flats', type: 'flats', template: true, import: true,
      columns: [{ key: 'code', label: t('unit') }, { key: 'building_id', label: t('building'), render: (r) => esc(Pages._h.nameOf(bl, r.building_id)) }, { key: 'unit_type', label: 'النوع' }, { key: 'floor', label: 'الطابق' }, { key: 'base_rent', label: t('rent'), num: true, render: (r) => money(r.base_rent) }],
      fields: [{ key: 'code', label: t('unit'), required: true }, { key: 'building_id', label: t('building'), type: 'select', options: bl.map((b) => ({ value: b.id, label: b.name })) }, { key: 'unit_type', label: 'النوع' }, { key: 'floor', label: 'الطابق' }, { key: 'base_rent', label: t('rent'), type: 'number', step: '0.001', value: 260 }] });
    // Admin: clean up legacy duplicate units (same code, different spacing/case)
    const tb = c.querySelector('.toolbar');
    if (tb && isAdmin()) {
      const b = document.createElement('button'); b.className = 'btn'; b.textContent = '🧹 دمج الوحدات المكررة';
      b.onclick = async () => {
        if (!confirm('سيتم دمج الوحدات اللي ليها نفس الرقم (مع اختلاف المسافات/الحروف) في وحدة واحدة، مع نقل كل العقود والفواتير والقيود إليها. لن تُفقد أي حركة. متابعة؟')) return;
        try { const r = await API.post('/flats/merge-duplicates', {}); toast(r.units_removed ? `تم دمج ${r.groups_merged} مجموعة · إزالة ${r.units_removed} وحدة مكررة` : 'لا توجد وحدات مكررة'); clearCache(); units(c); }
        catch (e) { toast(e.message, 'err'); }
      };
      tb.insertBefore(b, tb.querySelector('.tb-new') || null);
    }
  }
  async function categories(c) {
    return M(c, { title: t('m_categories'), endpoint: 'categories', type: 'categories',
      columns: [{ key: 'entity', label: 'النوع' }, { key: 'name', label: t('name') }, { key: 'name_ar', label: 'عربي' }],
      fields: [{ key: 'entity', label: 'يخص', type: 'select', options: [{ value: 'customer', label: 'عملاء' }, { value: 'vendor', label: 'موردين' }, { value: 'unit', label: 'وحدات' }, { value: 'expense', label: 'مصروفات' }] }, { key: 'name', label: t('name'), required: true }, { key: 'name_ar', label: 'عربي' }] });
  }
  async function paymethods(c) {
    const ac = await ref('accounts');
    return M(c, { title: t('m_paymethods'), endpoint: 'payment-methods', type: 'payment_methods',
      columns: [{ key: 'name', label: t('name') }, { key: 'name_ar', label: 'عربي' }, { key: 'kind', label: 'النوع' }, { key: 'gl_account', label: 'الحساب' }],
      fields: [{ key: 'name', label: t('name'), required: true }, { key: 'name_ar', label: 'عربي' }, { key: 'kind', label: 'النوع', type: 'select', options: ['cash', 'bank', 'cheque', 'card', 'online'].map((k) => ({ value: k, label: k })) }, { key: 'gl_account', label: 'الحساب', type: 'select', options: ac.filter((a) => a.type === 'asset').map((a) => ({ value: a.code, label: a.code + ' ' + a.name })) }] });
  }
  async function banks(c) {
    const ac = await ref('accounts');
    return M(c, { title: t('m_banks'), endpoint: 'banks', type: 'banks', template: true, import: true, wide: true,
      columns: [{ key: 'name', label: t('name') }, { key: 'branch', label: 'الفرع' }, { key: 'account_no', label: 'رقم الحساب' }, { key: 'iban', label: 'IBAN' }, { key: 'currency', label: 'العملة' }],
      fields: [{ key: 'name', label: t('name'), required: true }, { key: 'name_ar', label: 'عربي' }, { key: 'branch', label: 'الفرع' }, { key: 'account_no', label: 'رقم الحساب' }, { key: 'iban', label: 'IBAN' }, { key: 'swift', label: 'SWIFT' }, { key: 'gl_account', label: 'الحساب', type: 'select', options: ac.filter((a) => a.type === 'asset').map((a) => ({ value: a.code, label: a.code + ' ' + a.name })) }] });
  }
  async function employees(c) {
    await Pages.masterScreen(c, { title: t('m_employees'), endpoint: 'employees', type: 'employees', template: true, import: true,
      columns: [{ key: 'name', label: t('name') }, { key: 'job_title', label: t('job_title') }, { key: 'salary', label: t('salary'), num: true, render: (r) => money(r.salary) }, { key: 'active', label: t('status'), render: (r) => r.active ? badge('نشط', 'b-green') : badge('موقوف', 'b-gray') }],
      fields: [{ key: 'name', label: t('name'), required: true }, { key: 'job_title', label: t('job_title') }, { key: 'salary', label: t('salary'), type: 'number', step: '0.001', value: 0 }] });
    // add payroll button to toolbar
    const tb = c.querySelector('.toolbar');
    if (tb && canWrite()) {
      const b = document.createElement('button'); b.className = 'btn teal'; b.textContent = t('run_payroll') + ' ' + curMonth();
      b.onclick = async () => { if (confirm('ترحيل رواتب هذا الشهر؟')) { const r = await API.post('/payroll/run', { period: curMonth() }); toast(`تم ترحيل ${r.posted}`); } };
      tb.insertBefore(b, tb.querySelector('.tb-new') || null);
    }
  }

  // ---- Chart of accounts (admin CRUD) ----
  async function coa(c) {
    return M(c, { title: t('m_coa'), endpoint: 'accounts', type: 'accounts', template: true, idKey: 'code',
      searchFn: (rs, q) => rs.filter((r) => (r.code + ' ' + r.name + ' ' + (r.name_ar || '')).toLowerCase().includes(q)),
      columns: [{ key: 'code', label: t('code') }, { key: 'name', label: 'Name' }, { key: 'name_ar', label: 'عربي' },
        { key: 'type', label: 'النوع' }, { key: 'normal_balance', label: 'الطبيعة' }],
      fields: [{ key: 'code', label: t('code'), required: true }, { key: 'name', label: 'Name (EN)', required: true }, { key: 'name_ar', label: 'الاسم عربي' },
        { key: 'type', label: 'النوع', type: 'select', options: ['asset', 'liability', 'equity', 'income', 'expense'].map((x) => ({ value: x, label: x })) },
        { key: 'normal_balance', label: 'الطبيعة', type: 'select', options: [{ value: 'D', label: 'مدين D' }, { value: 'C', label: 'دائن C' }] }],
      rowActions: isAdmin() ? ['edit', 'delete'] : [],
    });
  }
  // NOTE: masterScreen uses PUT /accounts/:id; accounts key is `code`. Patch endpoint id.
  // handled by overriding below in vendorBills? -> we special-case in api (PUT /accounts/:code). masterScreen sends id=row.id (undefined). Fix: give accounts rows an id=code alias via view. Simpler: custom coa edit.

  // ---- Vendor bills ----
  async function vendorBills(c) {
    loading(c);
    const [rows, vn, ac, bl] = [await API.get('/vendor-bills'), await ref('vendors'), await ref('accounts'), await ref('buildings')];
    const exAcc = ac.filter((a) => a.type === 'expense');
    const tbCfg = { search: true, searchFn: (rs, q) => rs.filter((r) => [r.vendor, r.description, r.bill_no].join(' ').toLowerCase().includes(q)),
      exportType: 'vendor-bills', templateType: 'vendor-bills', onImport: () => importModal('vendor-bills', '', () => vendorBills(c)),
      onNew: canWrite() ? () => billForm(vn, exAcc, bl, () => vendorBills(c)) : null, newLabel: t('m_bills') };
    c.innerHTML = toolbar(tbCfg) + `<div class="card"><div class="hd"><h3>${t('m_bills')}</h3><button class="btn sm btn-print">🖨</button></div><div id="bt"></div></div>`;
    const cols = [{ key: 'bill_no', label: 'رقم' }, { key: 'bdate', label: t('date'), render: (r) => dateStr(r.bdate) }, { key: 'vendor', label: t('vendor') },
      { key: 'account_name', label: t('account'), render: (r) => esc(r.account_name) }, { key: 'description', label: t('description') },
      { key: 'total', label: t('total'), num: true, render: (r) => money(r.total) }, { key: 'status', label: t('status'), render: (r) => statusBadge(r.status) }];
    const draw = (rs) => c.querySelector('#bt').innerHTML = table(cols, rs);
    draw(rows); wireToolbar(c, tbCfg, draw, rows);
    c.querySelector('.btn-print').onclick = () => printTable(t('m_bills'), cols, rows);
  }
  function billForm(vn, exAcc, bl, done) {
    formModal({ title: t('m_bills'), wide: true, fields: [
      { key: 'vendor_id', label: t('vendor'), type: 'select', options: [{ value: '', label: '—' }].concat(vn.map((v) => ({ value: v.id, label: v.name }))) },
      { key: 'expense_code', label: 'البند', type: 'select', options: exAcc.map((a) => ({ value: a.code, label: a.code + ' - ' + (a.name_ar || a.name) })) },
      { key: 'building_id', label: t('building'), type: 'select', options: [{ value: '', label: '—' }].concat(bl.map((b) => ({ value: b.id, label: b.name }))) },
      { key: 'amount', label: t('amount'), type: 'number', step: '0.001', required: true },
      { key: 'vat_percent', label: t('vat') + ' % (تُحسب تلقائياً)', type: 'number', step: '0.5', value: 5 },
      { key: 'bdate', label: t('date'), type: 'date', value: today() },
      { key: 'paid', label: 'مدفوع فوراً', type: 'checkbox' },
      { key: 'attachment', label: '📎 صورة الفاتورة', type: 'file', accept: 'image/*,.pdf', full: true },
      { key: 'description', label: t('description'), full: true },
    ], onSave: async (d, close) => { d.vat_amount = Math.round((d.amount || 0) * (d.vat_percent || 0)) / 100; await API.post('/vendor-bills', d); toast(t('saved')); close(); done(); } });
  }
  // ---- Vendor payments (سند صرف) ----
  async function vendorPayments(c) {
    loading(c);
    const [rows, vn] = [await API.get('/vendor-payments'), await ref('vendors')];
    const tbCfg = { search: true, searchFn: (rs, q) => rs.filter((r) => [r.vendor, r.voucher_no].join(' ').toLowerCase().includes(q)),
      exportType: 'vendor-payments', onNew: canWrite() ? () => vpayForm(vn, () => vendorPayments(c)) : null, newLabel: 'سند صرف' };
    c.innerHTML = toolbar(tbCfg) + `<div class="card"><div class="hd"><h3>${t('m_vpayments')}</h3><button class="btn sm btn-print">🖨</button></div><div id="vt"></div></div>`;
    const cols = [{ key: 'voucher_no', label: t('voucher'), render: (r) => r.journal_id ? `<a href="#" class="drill" data-jid="${r.journal_id}">${esc(r.voucher_no)}</a>` : esc(r.voucher_no) }, { key: 'pdate', label: t('date'), render: (r) => dateStr(r.pdate) }, { key: 'vendor', label: t('vendor') },
      { key: 'amount', label: t('amount'), num: true, render: (r) => money(r.amount) }, { key: 'method', label: t('method') },
      { key: '_a', label: t('actions'), render: (r) => actions(r.id, ['print']) }];
    const draw = (rs) => c.querySelector('#vt').innerHTML = table(cols, rs);
    draw(rows); wireToolbar(c, tbCfg, draw, rows);
    c.querySelector('.btn-print').onclick = () => printTable(t('m_vpayments'), cols.slice(0, -1), rows);
    c.querySelector('#vt').onclick = (e) => {
      const drill = e.target.closest('.drill[data-jid]'); if (drill) { e.preventDefault(); return Pages.viewJournal(drill.dataset.jid); }
      const b = e.target.closest('[data-act]'); if (b) voucherPrint('سند صرف', rows.find((x) => x.id === +b.dataset.id), rows.find((x) => x.id === +b.dataset.id).vendor);
    };
  }
  function vpayForm(vn, done) {
    formModal({ title: 'سند صرف', wide: true, fields: [
      { key: 'vendor_id', label: t('vendor'), type: 'select', options: vn.map((v) => ({ value: v.id, label: v.name })), required: true },
      { key: 'amount', label: t('amount'), type: 'number', step: '0.001', required: true },
      { key: 'pdate', label: t('date'), type: 'date', value: today() },
      { key: 'method', label: t('method'), type: 'select', options: [{ value: 'bank', label: 'بنك' }, { value: 'cash', label: 'نقدي' }, { value: 'cheque', label: 'شيك' }] },
      { key: 'cheque_no', label: 'رقم الشيك' }, { key: 'memo', label: t('description'), full: true },
    ], onSave: async (d, close) => { await API.post('/vendor-payments', d); toast(t('saved')); close(); done(); } });
  }

  // ---- Reports: report wrapper with print + export ----
  function reportShell(c, titleKey, controlsHTML, exportName) {
    c.innerHTML = `<div class="toolbar">${controlsHTML}<div class="spacer"></div>
      ${exportName ? `<button class="btn" id="rexp">📊 ${t('export')}</button>` : `<button class="btn" id="rxls">📊 Excel</button>`}
      <button class="btn" id="rprint">🖨 ${t('print')}</button></div><div class="card" id="rbody"></div>`;
    if (exportName) c.querySelector('#rexp').onclick = () => API.download('/export-report/' + exportName + (c._qs || ''), exportName + '.xlsx').catch((e) => toast(e.message, 'err'));
    const xls = c.querySelector('#rxls');
    if (xls) xls.onclick = () => UI.exportTableToExcel(t(titleKey), c.querySelector('#rbody').innerHTML);
  }
  function bindPrint(c, title) { c.querySelector('#rprint').onclick = () => printReport(title, c.querySelector('#rbody').innerHTML); }

  // ---- Account drill-down: click any total/amount -> see the movements ------
  // opts: {title, account | accounts:[codes], from, to, tenant_id, vendor_id, building_id}
  async function accountDrill(opts = {}) {
    const qp = new URLSearchParams();
    if (opts.account) qp.set('account', opts.account);
    if (opts.accounts && opts.accounts.length) qp.set('accounts', opts.accounts.join(','));
    ['from', 'to', 'tenant_id', 'vendor_id', 'building_id', 'flat_id'].forEach((k) => { if (opts[k]) qp.set(k, opts[k]); });
    let r;
    try { r = await API.get('/reports/account-ledger?' + qp.toString()); }
    catch (e) { return toast(e.message, 'err'); }
    if (!r.rows.length && !Math.abs(r.opening)) return toast('لا توجد حركات على هذا الحساب في الفترة', 'err');
    const cols = [
      { key: 'jdate', label: t('date'), render: (x) => dateStr(x.jdate) },
      { key: 'reference', label: t('reference'), render: (x) => `<a href="#" class="drill" data-jid="${x.journal_id}">${esc(x.reference || ('#' + x.journal_id))}</a>` },
      { key: 'account_name', label: t('account') },
      { key: 'party', label: t('tenant') + '/' + t('vendor'), render: (x) => esc(x.tenant || x.vendor || '') },
      { key: 'memo', label: t('description'), render: (x) => esc(x.memo || '') },
      { key: 'debit', label: t('debit'), num: true, render: (x) => x.debit ? money(x.debit) : '' },
      { key: 'credit', label: t('credit'), num: true, render: (x) => x.credit ? money(x.credit) : '' },
      { key: 'balance', label: t('balance'), num: true, render: (x) => money(x.balance) },
    ];
    const openRow = Math.abs(r.opening) > 0.005
      ? `<tr><td></td><td></td><td></td><td></td><td><i>${t('opening')}</i></td><td></td><td></td><td class="num"><b>${money(r.opening)}</b></td></tr>` : '';
    const body = table(cols, r.rows, {
      foot: [{ v: '' }, { v: '' }, { v: '' }, { v: '' }, { v: t('total') }, { v: money(r.total_debit), num: true }, { v: money(r.total_credit), num: true }, { v: money(r.closing), num: true }],
    }).replace('<tbody>', '<tbody>' + openRow);
    modal({
      title: opts.title || t('movements'), wide: true, bodyHTML: body + `<p class="muted" style="font-size:11px;margin-top:8px">اضغط على «المرجع» لعرض القيد الكامل (جه منين).</p>`,
      footerHTML: `<button class="btn" id="dprint">🖨 ${t('print')}</button>`,
      onMount: (bg) => {
        bg.querySelector('#dprint').onclick = () => printReport(opts.title || t('movements'), body);
        bg.querySelector('.m-bd').addEventListener('click', (e) => { const a = e.target.closest('.drill[data-jid]'); if (a) { e.preventDefault(); viewJournal(a.dataset.jid); } });
      },
    });
  }
  // expose for other page modules
  Pages.accountDrill = accountDrill;

  // ---- Reusable journal viewer (the actual double-entry behind a line) -----
  async function viewJournal(id) {
    let j; try { j = await API.get('/journals/' + id); } catch (e) { return toast(e.message, 'err'); }
    if (!j) return;
    const html = `<p class="muted">${esc(j.memo || '')} — ${dateStr(j.jdate)}${j.reference ? ' · ' + esc(j.reference) : ''}</p>` +
      table([{ key: 'account_code', label: t('code') }, { key: 'account_name', label: t('account') },
        { key: 'party', label: t('tenant') + '/' + t('vendor'), render: (x) => esc(x.tenant || x.vendor || '') },
        { key: 'debit', label: t('debit'), num: true, render: (x) => x.debit ? money(x.debit) : '' },
        { key: 'credit', label: t('credit'), num: true, render: (x) => x.credit ? money(x.credit) : '' }], j.lines);
    modal({ title: `قيد #${j.id}`, wide: true, bodyHTML: html, footerHTML: `<button class="btn" id="xj">📊 Excel</button><button class="btn" id="pj">🖨 ${t('print')}</button>`,
      onMount: (bg) => { bg.querySelector('#pj').onclick = () => printReport('Journal #' + j.id, html); bg.querySelector('#xj').onclick = () => UI.exportTableToExcel('قيد ' + j.id, html); } });
  }
  Pages.viewJournal = viewJournal;
  const drillA = (label, attrs) => `<a href="#" class="drill" ${attrs}>${label}</a>`;

  // ---- Consolidated Income Statement (month-by-month, horizontal analysis) --
  const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  async function incomeStatementConsolidated(c) {
    const year = c._year || String(new Date().getFullYear());
    reportShell(c, 'm_is_consolidated', `<div class="field" style="margin:0"><label>${t('year')}</label><input type="number" id="yr" value="${year}" style="width:100px"></div>`, 'income-statement-consolidated');
    c._qs = '?year=' + year + (window.UT ? UT.bq() : '');
    const r = await API.get('/reports/income-statement-consolidated?year=' + year + (window.UT ? UT.bq() : ''));
    const mo = (i) => MONTHS_AR[i] || (i + 1);
    const head = `<tr><th>${t('code')}</th><th>${t('account')}</th>${MONTHS_AR.map((m) => `<th class="num">${m}</th>`).join('')}<th class="num">${t('total')}</th></tr>`;
    const cell = (v, acc, m) => `<td class="num">${v ? drillA(money(v), `data-acc="${acc}" data-mo="${m}"`) : ''}</td>`;
    const dataRow = (x) => `<tr><td>${esc(x.code)}</td><td>${esc(x.name)}</td>${x.months.map((v, i) => cell(v, x.code, i)).join('')}<td class="num">${x.total ? drillA(`<b>${money(x.total)}</b>`, `data-acc="${x.code}"`) : ''}</td></tr>`;
    const totRow = (lbl, tot, cls) => `<tr class="tot"><td></td><td><b>${lbl}</b></td>${tot.months.map((v) => `<td class="num ${cls}">${money(v)}</td>`).join('')}<td class="num ${cls}"><b>${money(tot.total)}</b></td></tr>`;
    c.querySelector('#rbody').innerHTML = `<div class="table-wrap"><table>
      <thead>${head}</thead>
      <tbody>
        <tr class="sec"><td colspan="${MONTHS_AR.length + 3}"><b>${t('income')}</b></td></tr>
        ${r.income.map(dataRow).join('') || `<tr><td colspan="${MONTHS_AR.length + 3}" class="muted">${t('no_data')}</td></tr>`}
        ${totRow(t('total_income'), r.total_income, 'pos')}
        <tr class="sec"><td colspan="${MONTHS_AR.length + 3}"><b>${t('expense')}</b></td></tr>
        ${r.expense.map(dataRow).join('') || `<tr><td colspan="${MONTHS_AR.length + 3}" class="muted">${t('no_data')}</td></tr>`}
        ${totRow(t('total_expense'), r.total_expense, 'neg')}
        ${totRow(t('net'), r.net, '')}
      </tbody></table></div>`;
    // click a month cell or account total -> movements for that account
    c.querySelector('#rbody').onclick = (e) => {
      const a = e.target.closest('.drill'); if (!a) return; e.preventDefault();
      const acc = a.dataset.acc; if (!acc) return;
      const moIdx = a.dataset.mo != null ? Number(a.dataset.mo) : null;
      const from = moIdx != null ? `${year}-${String(moIdx + 1).padStart(2, '0')}-01` : `${year}-01-01`;
      const to = moIdx != null ? `${year}-${String(moIdx + 1).padStart(2, '0')}-31` : `${year}-12-31`;
      accountDrill({ title: `${acc} — ${moIdx != null ? mo(moIdx) + ' ' : ''}${year}`, account: acc, from, to, building_id: (window.UT && UT.building) || null });
    };
    c.querySelector('#yr').onchange = (e) => { c._year = e.target.value; incomeStatementConsolidated(c); };
    bindPrint(c, t('m_is_consolidated'));
  }

  // ---- General Ledger report (search accounts, see movements) ---------------
  async function generalLedger(c) {
    const ac = await ref('accounts');
    const from = c._from || (new Date().getFullYear() + '-01-01'), to = c._to || today();
    const acc = c._acc || '';
    const accLabel = acc ? ((ac.find((a) => a.code === acc) || {}) ) : null;
    const accVal = accLabel && accLabel.code ? (accLabel.code + ' - ' + (accLabel.name_ar || accLabel.name)) : '';
    reportShell(c, 'm_gl', `
      <div class="field" style="margin:0"><label>${t('account')}</label>
        <input id="glacc" list="glaccdl" placeholder="${t('all_accounts')} — ابحث بالكود أو الاسم" style="min-width:300px" value="${esc(accVal)}">
        <datalist id="glaccdl">${ac.filter((a) => !a.is_group).map((a) => `<option value="${esc(a.code + ' - ' + (a.name_ar || a.name))}"></option>`).join('')}</datalist></div>
      <div class="field" style="margin:0"><label>${t('from')}</label><input type="date" id="glf" value="${from}"></div>
      <div class="field" style="margin:0"><label>${t('to')}</label><input type="date" id="glt" value="${to}"></div>
      <button class="btn primary" id="glgo">${t('run')}</button>`, 'general-ledger');
    const parseAcc = () => { const raw = c.querySelector('#glacc').value.trim(); const m = raw.match(/^\s*([0-9A-Za-z]+)/); return m ? m[1] : ''; };
    const jref = (x) => `<a href="#" class="drill" data-jid="${x.journal_id}">${esc(x.reference || ('#' + x.journal_id))}</a>`;
    const run = async () => {
      const a = parseAcc(), f = c.querySelector('#glf').value, tt = c.querySelector('#glt').value;
      const bq = (window.UT && UT.building) ? '&building_id=' + UT.building : '';
      c._qs = `?from=${f}&to=${tt}${a ? '&account=' + a : ''}${bq}`;
      const rb = c.querySelector('#rbody');
      if (!a) {
        // ALL accounts -> full GL grouped per account (each with its own balance)
        const r = await API.get(`/reports/general-ledger-full?from=${f}&to=${tt}${bq}`);
        rb.innerHTML = r.accounts.map((ac) => {
          const openRow = Math.abs(ac.opening) > 0.005 ? `<tr><td></td><td></td><td><i>${t('opening')}</i></td><td></td><td></td><td class="num"><b>${money(ac.opening)}</b></td></tr>` : '';
          const body = table([
            { key: 'jdate', label: t('date'), render: (x) => dateStr(x.jdate) },
            { key: 'reference', label: t('reference'), render: jref },
            { key: 'party', label: t('tenant') + '/' + t('vendor'), render: (x) => esc(x.party || '') },
            { key: 'memo', label: t('description'), render: (x) => esc(x.memo || '') },
            { key: 'debit', label: t('debit'), num: true, render: (x) => x.debit ? money(x.debit) : '' },
            { key: 'credit', label: t('credit'), num: true, render: (x) => x.credit ? money(x.credit) : '' },
            { key: 'balance', label: t('balance'), num: true, render: (x) => money(x.balance) },
          ], ac.rows, { foot: [{ v: '' }, { v: '' }, { v: '' }, { v: t('total') }, { v: money(ac.total_debit), num: true }, { v: money(ac.total_credit), num: true }, { v: money(ac.closing), num: true }] }).replace('<tbody>', '<tbody>' + openRow);
          return `<div style="margin-bottom:18px"><h3 style="margin:0 0 4px">${esc(ac.code)} — ${esc(ac.name)}</h3>${body}</div>`;
        }).join('') || `<div class="empty">${t('no_data')}</div>`;
        return;
      }
      const qp = new URLSearchParams(); qp.set('account', a); if (f) qp.set('from', f); if (tt) qp.set('to', tt);
      if (window.UT && UT.building) qp.set('building_id', UT.building);
      const r = await API.get('/reports/account-ledger?' + qp.toString());
      const openRow = Math.abs(r.opening) > 0.005
        ? `<tr><td></td><td></td><td></td><td></td><td><i>${t('opening')}</i></td><td></td><td></td><td class="num"><b>${money(r.opening)}</b></td></tr>` : '';
      rb.innerHTML = table([
        { key: 'jdate', label: t('date'), render: (x) => dateStr(x.jdate) },
        { key: 'reference', label: t('reference'), render: jref },
        { key: 'account_name', label: t('account') },
        { key: 'party', label: t('tenant') + '/' + t('vendor'), render: (x) => esc(x.tenant || x.vendor || '') },
        { key: 'memo', label: t('description'), render: (x) => esc(x.memo || '') },
        { key: 'debit', label: t('debit'), num: true, render: (x) => x.debit ? money(x.debit) : '' },
        { key: 'credit', label: t('credit'), num: true, render: (x) => x.credit ? money(x.credit) : '' },
        { key: 'balance', label: t('balance'), num: true, render: (x) => money(x.balance) },
      ], r.rows, { foot: [{ v: '' }, { v: '' }, { v: '' }, { v: '' }, { v: t('total') }, { v: money(r.total_debit), num: true }, { v: money(r.total_credit), num: true }, { v: money(r.closing), num: true }] })
        .replace('<tbody>', '<tbody>' + openRow);
    };
    c.querySelector('#glgo').onclick = () => { c._acc = parseAcc(); c._from = c.querySelector('#glf').value; c._to = c.querySelector('#glt').value; run(); };
    c.querySelector('#glacc').addEventListener('change', () => c.querySelector('#glgo').click());
    c.querySelector('#rbody').addEventListener('click', (e) => { const a = e.target.closest('.drill[data-jid]'); if (a) { e.preventDefault(); viewJournal(a.dataset.jid); } });
    bindPrint(c, t('m_gl'));
    run();
  }

  // ---- Liquidity report (current assets vs current liabilities) ------------
  async function liquidity(c) {
    const upto = c._upto || today();
    reportShell(c, 'm_liquidity', `<div class="field" style="margin:0"><label>${t('to')}</label><input type="date" id="u" value="${upto}"></div>`, null);
    const r = await API.get('/reports/liquidity?upto=' + upto);
    const sec = (title, rows, total, cls) => `<h3>${title}</h3><table><tbody>${rows.map((x) => `<tr><td>${esc(x.code)}</td><td>${esc(x.name)}</td><td class="num">${money(x.amt)}</td></tr>`).join('') || `<tr><td colspan="3" class="muted">${t('no_data')}</td></tr>`}</tbody><tfoot><tr><td></td><td>${t('total')}</td><td class="num ${cls}"><b>${money(total)}</b></td></tr></tfoot></table>`;
    const kpi = (lbl, val, sub, cls) => `<div class="card kpi ${cls}"><div class="lbl">${lbl}</div><div class="val mono">${val}</div><div class="sub">${sub}</div></div>`;
    c.querySelector('#rbody').innerHTML = `<div class="bd">
      <div class="grid g-4" style="margin-bottom:16px">
        ${kpi('رأس المال العامل', money(r.working_capital), 'أصول متداولة − التزامات', r.working_capital >= 0 ? 'k-green' : 'k-red')}
        ${kpi('نسبة التداول', r.current_ratio, 'الأصول ÷ الالتزامات (>1 جيد)', r.current_ratio >= 1 ? 'k-green' : 'k-amber')}
        ${kpi('السيولة السريعة', r.quick_ratio, 'Quick Ratio', r.quick_ratio >= 1 ? 'k-green' : 'k-amber')}
        ${kpi('نسبة النقدية', r.cash_ratio, 'النقدية ÷ الالتزامات', 'k-blue')}
      </div>
      ${sec('الأصول المتداولة (نقدية + ذمم مدينة — تتحصّل خلال سنة)', r.current_assets, r.total_current_assets, 'pos')}
      ${sec('الالتزامات المتداولة (ذمم دائنة + مقدمات + ض.ق.م — تُدفع خلال سنة)', r.current_liabilities, r.total_current_liabilities, 'neg')}
      <p class="muted" style="margin-top:10px">رأس المال العامل = <b>${money(r.working_capital)}</b> — ${r.working_capital >= 0 ? 'عندك فائض سيولة يغطي التزاماتك القصيرة ✅' : 'التزاماتك القصيرة أكبر من أصولك المتداولة ⚠️'}</p>
    </div>`;
    c.querySelector('#u').onchange = (e) => { c._upto = e.target.value; liquidity(c); };
    bindPrint(c, t('m_liquidity'));
  }

  async function trialBalance(c) {
    const upto = c._upto || today();
    reportShell(c, 'm_tb', `<div class="field" style="margin:0"><label>${t('to')}</label><input type="date" id="u" value="${upto}"></div>`, 'trial-balance');
    c._qs = '?upto=' + upto;
    const r = await API.get('/reports/trial-balance?upto=' + upto);
    c.querySelector('#rbody').innerHTML = table([{ key: 'code', label: t('code'), render: (x) => drillA(esc(x.code), `data-acc="${esc(x.code)}"`) }, { key: 'name', label: t('account') },
      { key: 'debit', label: t('debit'), num: true, render: (x) => x.debit ? money(x.debit) : '' }, { key: 'credit', label: t('credit'), num: true, render: (x) => x.credit ? money(x.credit) : '' }],
      r.rows, { foot: [{ v: '' }, { v: t('total') }, { v: money(r.total_debit), num: true }, { v: money(r.total_credit), num: true }] });
    c.querySelector('#rbody').onclick = (e) => {
      const a = e.target.closest('.drill'); if (!a || !a.dataset.acc) return; e.preventDefault();
      accountDrill({ title: a.dataset.acc, account: a.dataset.acc, to: upto, building_id: (window.UT && UT.building) || null });
    };
    c.querySelector('#u').onchange = (e) => { c._upto = e.target.value; trialBalance(c); };
    bindPrint(c, t('m_tb'));
  }
  async function incomeStatement(c) {
    const from = c._from || (curMonth() + '-01'), to = c._to || today();
    reportShell(c, 'm_is', `<div class="field" style="margin:0"><label>${t('from')}</label><input type="date" id="f" value="${from}"></div>
      <div class="field" style="margin:0"><label>${t('to')}</label><input type="date" id="t2" value="${to}"></div>`, 'income-statement');
    c._qs = `?from=${from}&to=${to}`;
    const r = await API.get(`/reports/income-statement?from=${from}&to=${to}`);
    const rowH = (x) => `<tr><td>${esc(x.code)}</td><td>${esc(x.name)}</td><td class="num">${drillA(money(x.amt), `data-acc="${esc(x.code)}"`)}</td></tr>`;
    const incCodes = r.income.map((x) => x.code).join(','), expCodes = r.expense.map((x) => x.code).join(',');
    c.querySelector('#rbody').innerHTML = `<div class="bd"><h3>${t('income')}</h3><table><tbody>${r.income.map(rowH).join('') || ''}</tbody>
      <tfoot><tr><td></td><td>${t('total_income')}</td><td class="num">${drillA(money(r.total_income), `data-accs="${incCodes}"`)}</td></tr></tfoot></table>
      <h3>${t('expense')}</h3><table><tbody>${r.expense.map(rowH).join('') || ''}</tbody>
      <tfoot><tr><td></td><td>${t('total_expense')}</td><td class="num">${drillA(money(r.total_expense), `data-accs="${expCodes}"`)}</td></tr></tfoot></table>
      <h3 style="margin-top:14px">${t('net')}: <span class="${r.net >= 0 ? 'pos' : 'neg'}">${money(r.net)}</span></h3></div>`;
    c.querySelector('#rbody').onclick = (e) => {
      const a = e.target.closest('.drill'); if (!a) return; e.preventDefault();
      const bid = (window.UT && UT.building) || null;
      if (a.dataset.acc) accountDrill({ title: a.dataset.acc, account: a.dataset.acc, from, to, building_id: bid });
      else if (a.dataset.accs) accountDrill({ title: t('total'), accounts: a.dataset.accs.split(',').filter(Boolean), from, to, building_id: bid });
    };
    c.querySelector('#f').onchange = (e) => { c._from = e.target.value; incomeStatement(c); };
    c.querySelector('#t2').onchange = (e) => { c._to = e.target.value; incomeStatement(c); };
    bindPrint(c, t('m_is'));
  }
  async function balanceSheet(c) {
    const upto = c._upto || today();
    reportShell(c, 'm_bs', `<div class="field" style="margin:0"><label>${t('to')}</label><input type="date" id="u" value="${upto}"></div>`, 'balance-sheet');
    c._qs = '?upto=' + upto;
    const r = await API.get('/reports/balance-sheet?upto=' + upto);
    const sec = (title, rows, total) => `<h3>${title}</h3><table><tbody>${rows.map((x) => `<tr><td>${esc(x.code)}</td><td>${esc(x.name)}</td><td class="num">${money(x.amt)}</td></tr>`).join('')}</tbody><tfoot><tr><td></td><td>${t('total')}</td><td class="num">${money(total)}</td></tr></tfoot></table>`;
    c.querySelector('#rbody').innerHTML = `<div class="bd">${sec('الأصول', r.assets, r.total_assets)}
      ${sec('الالتزامات', r.liabilities, r.total_liabilities)}
      ${sec('حقوق الملكية', r.equity.concat([{ code: '', name: 'صافي الدخل', amt: r.net_income }]), r.total_equity)}</div>`;
    c.querySelector('#u').onchange = (e) => { c._upto = e.target.value; balanceSheet(c); };
    bindPrint(c, t('m_bs'));
  }
  async function arAging(c) { await agingScreen(c, 'aging', t('m_ar_aging'), t('tenant')); }
  async function apAging(c) { await agingScreen(c, 'payables-aging', t('m_ap_aging'), t('vendor')); }
  async function agingScreen(c, endpoint, title, who) {
    const asOf = c._asOf || today();
    reportShell(c, title, `<div class="field" style="margin:0"><label>${t('to')}</label><input type="date" id="a" value="${asOf}"></div>`, endpoint === 'aging' ? 'aging' : null);
    c._qs = '?asOf=' + asOf;
    const r = await API.get('/reports/' + endpoint + '?asOf=' + asOf + (endpoint === 'aging' && window.UT ? UT.bq() : ''));
    c.querySelector('#rbody').innerHTML = table([{ key: 'w', label: who, render: (x) => esc(x.tenant || x.vendor) },
      { key: 'current', label: t('current'), num: true, render: (x) => money(x.current) }, { key: 'd30', label: '1-30', num: true, render: (x) => money(x.d30) },
      { key: 'd60', label: '31-60', num: true, render: (x) => money(x.d60) }, { key: 'd90', label: '61-90', num: true, render: (x) => money(x.d90) },
      { key: 'd180', label: '91-180', num: true, render: (x) => money(x.d180) }, { key: 'd180p', label: '+180', num: true, render: (x) => money(x.d180p) },
      { key: 'total', label: t('total'), num: true, render: (x) => `<b>${money(x.total)}</b>` }], r.rows,
      { foot: [{ v: t('total') }, ...(r.totals ? ['current', 'd30', 'd60', 'd90', 'd180', 'd180p'].map((k) => ({ v: money(r.totals[k]), num: true })) : [{}, {}, {}, {}, {}, {}]), { v: money(r.grand_total), num: true }] });
    c.querySelector('#a').onchange = (e) => { c._asOf = e.target.value; agingScreen(c, endpoint, title, who); };
    bindPrint(c, title);
  }
  async function statement(c, params) {
    const [fl, tn, contracts] = [await ref('flats'), await ref('tenants'), await API.get('/contracts')];
    const flatId = c._flat ?? params.flat ?? '', tenantId = c._tenant ?? params.tenant ?? '';
    reportShell(c, 'm_statement', `
      <div class="field" style="margin:0"><label>${t('unit')}</label><select id="sf"><option value="">${t('unit')}</option>${Pages._h.opt(fl, 'id', 'code', flatId)}</select></div>
      <div class="field" style="margin:0"><label>${t('tenant')}</label><select id="st"><option value="">${t('tenant')}</option>${Pages._h.opt(tn, 'id', 'name', tenantId)}</select></div>
      <div class="field" style="margin:0"><label>${t('from')}</label><input type="date" id="sfrom"></div>
      <div class="field" style="margin:0"><label>${t('to')}</label><input type="date" id="sto"></div>
      <button class="btn primary" id="go">${t('run')}</button>`, null);
    const run = async () => {
      const qp = new URLSearchParams();
      const f = c.querySelector('#sf').value, tt = c.querySelector('#st').value, fr = c.querySelector('#sfrom').value, to = c.querySelector('#sto').value;
      if (f) qp.set('flat_id', f); if (tt) qp.set('tenant_id', tt); if (fr) qp.set('from', fr); if (to) qp.set('to', to);
      const r = await API.get('/reports/flat-statement?' + qp);
      c.querySelector('#rbody').innerHTML = table([{ key: 'jdate', label: t('date'), render: (x) => dateStr(x.jdate) },
        { key: 'flat', label: t('unit') }, { key: 'tenant', label: t('tenant') }, { key: 'account_name', label: t('account') }, { key: 'memo', label: t('description') },
        { key: 'debit', label: t('debit'), num: true, render: (x) => x.debit ? money(x.debit) : '' }, { key: 'credit', label: t('credit'), num: true, render: (x) => x.credit ? money(x.credit) : '' },
        { key: 'balance', label: t('balance'), num: true, render: (x) => money(x.balance) }], r.lines,
        { foot: [{ v: '' }, { v: '' }, { v: '' }, { v: '' }, { v: t('total') }, { v: money(r.total_debit), num: true }, { v: money(r.total_credit), num: true }, { v: money(r.balance), num: true }] });
    };
    // when a unit is picked, show only the tenants who rented THAT unit
    const stSel = c.querySelector('#st');
    const fillTenants = (fid) => {
      const names = fid ? contracts.filter((c2) => String(c2.flat_id) === String(fid)).map((c2) => ({ id: c2.tenant_id, name: c2.tenant }))
        : tn.map((x) => ({ id: x.id, name: x.name }));
      const uniq = [...new Map(names.map((x) => [x.id, x])).values()];
      stSel.innerHTML = `<option value="">${t('tenant')}</option>` + Pages._h.opt(uniq, 'id', 'name', c.querySelector('#st').value);
    };
    c.querySelector('#sf').onchange = (e) => fillTenants(e.target.value);
    if (flatId) fillTenants(flatId);
    c.querySelector('#go').onclick = run;
    bindPrint(c, t('m_statement'));
    if (flatId || tenantId) run(); else c.querySelector('#rbody').innerHTML = `<div class="empty">اختر شقة (تظهر أسماء من سكنوها) و/أو عميل ثم ${t('run')}</div>`;
  }
  // ---- Bank reconciliation -------------------------------------------------
  async function reconciliation(c) {
    loading(c);
    const bl = await ref('banks', '/banks');
    if (!bl.length) { c.innerHTML = `<div class="empty">أضف حساب بنكي أولاً من «${t('m_banks')}»</div>`; return; }
    const bankId = c._bank || bl[0].id;
    const r = await API.get('/reconciliation/' + bankId);
    const diffOk = Math.abs(r.difference) < 0.005;
    c.innerHTML = `
      <div class="toolbar">
        <div class="field" style="margin:0"><label>${t('m_banks')}</label><select id="rb">${bl.map((b) => `<option value="${b.id}" ${String(b.id) === String(bankId) ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>
        <div class="spacer"></div>
        <button class="btn" id="rtpl">⬇ ${t('template')}</button>
        <button class="btn" id="rimp">⬆ رفع كشف البنك</button>
        <button class="btn teal" id="rauto">⚡ مطابقة تلقائية</button>
        <button class="btn" id="rprint">🖨 ${t('print')}</button></div>
      <div class="grid g-4">
        <div class="card kpi k-blue"><div class="lbl">رصيد الدفاتر (النظام)</div><div class="val mono">${money(r.book_balance)}</div></div>
        <div class="card kpi k-teal"><div class="lbl">رصيد كشف البنك</div><div class="val mono">${money(r.statement_balance)}</div></div>
        <div class="card kpi ${diffOk ? 'k-green' : 'k-red'}"><div class="lbl">الفرق</div><div class="val mono">${money(r.difference)}</div>
          <div class="sub">${diffOk ? '✓ مطابق' : 'يحتاج تسوية'}</div></div>
        <div class="card kpi k-amber"><div class="lbl">غير مطابق</div><div class="val mono">${r.unmatched_statement} / ${r.unmatched_ledger}</div>
          <div class="sub">كشف البنك / الدفاتر</div></div>
      </div>
      <div class="grid g-2" style="margin-top:16px">
        <div class="card"><div class="hd"><h3>كشف البنك (المرفوع)</h3></div><div id="stbl"></div></div>
        <div class="card"><div class="hd"><h3>حركة الدفاتر (النظام)</h3></div><div id="ltbl"></div></div>
      </div>`;
    c.querySelector('#stbl').innerHTML = table([
      { key: 'txn_date', label: t('date'), render: (x) => dateStr(x.txn_date) },
      { key: 'description', label: t('description') },
      { key: 'debit', label: 'سحب', num: true, render: (x) => x.debit ? money(x.debit) : '' },
      { key: 'credit', label: 'إيداع', num: true, render: (x) => x.credit ? money(x.credit) : '' },
      { key: 'reconciled', label: 'مطابق', render: (x) => `<input type="checkbox" class="rec-chk" data-id="${x.id}" ${x.reconciled ? 'checked' : ''}>` },
      { key: '_d', label: '', render: (x) => `<button class="ico-btn" data-del="${x.id}">🗑</button>` },
    ], r.statement, { empty: 'ارفع كشف حساب البنك (Excel) للبدء' });
    c.querySelector('#ltbl').innerHTML = table([
      { key: 'jdate', label: t('date'), render: (x) => dateStr(x.jdate) },
      { key: 'reference', label: 'المرجع' }, { key: 'memo', label: t('description') },
      { key: 'debit', label: 'وارد', num: true, render: (x) => x.debit ? money(x.debit) : '' },
      { key: 'credit', label: 'صادر', num: true, render: (x) => x.credit ? money(x.credit) : '' },
      { key: 'reconciled', label: 'مطابق', render: (x) => x.reconciled ? badge('✓', 'b-green') : badge('—', 'b-gray') },
    ], r.ledger);
    c.querySelector('#rb').onchange = (e) => { c._bank = e.target.value; reconciliation(c); };
    c.querySelector('#rtpl').onclick = () => API.download('/template/bank-statement', 'bank-statement-template.xlsx').catch((e) => toast(e.message, 'err'));
    c.querySelector('#rimp').onclick = () => importModal('bank-statement', `<input type="hidden" id="imp-bank" value="${bankId}">`, () => reconciliation(c), { bank_id: bankId });
    c.querySelector('#rauto').onclick = async () => {
      try { const m = await API.post(`/reconciliation/${bankId}/auto-match`, {}); toast(`تمت مطابقة ${m.matched} حركة · باقي ${m.remaining}`); reconciliation(c); }
      catch (e) { toast(e.message, 'err'); }
    };
    c.querySelector('#rprint').onclick = () => printReport('التسوية البنكية — ' + r.bank,
      `<div class="krow"><div><b>رصيد الدفاتر:</b> ${money(r.book_balance)}</div><div><b>رصيد البنك:</b> ${money(r.statement_balance)}</div><div><b>الفرق:</b> ${money(r.difference)}</div></div>` +
      '<h3>كشف البنك</h3>' + c.querySelector('#stbl').innerHTML + '<h3>حركة الدفاتر</h3>' + c.querySelector('#ltbl').innerHTML);
    c.querySelector('#stbl').onclick = async (e) => {
      const chk = e.target.closest('.rec-chk'); const del = e.target.closest('[data-del]');
      if (chk) { await API.put('/reconciliation/line/' + chk.dataset.id, { reconciled: chk.checked }); reconciliation(c); }
      if (del && confirm(t('confirm_delete'))) { await API.del('/reconciliation/line/' + del.dataset.del); reconciliation(c); }
    };
  }

  async function customersSummary(c) {
    reportShell(c, 'm_cust_summary', '', null);
    const r = await API.get('/reports/customers-summary');
    c.querySelector('#rbody').innerHTML = table([
      { key: 'tenant', label: t('tenant'), render: (x) => `<a href="#/statement?tenant=${x.id}">${esc(x.tenant)}</a>` },
      { key: 'phone', label: t('phone') },
      { key: 'receivable', label: 'مدين (مستحق)', num: true, render: (x) => x.receivable ? drillA(money(x.receivable), `data-tid="${x.id}" data-kind="recv"`) : money(x.receivable) },
      { key: 'advance', label: 'دفعات مقدمة', num: true, render: (x) => x.advance ? drillA(money(x.advance), `data-tid="${x.id}" data-kind="adv"`) : money(x.advance) },
      { key: 'net', label: 'الصافي', num: true, render: (x) => `<b class="${x.net > 0 ? 'neg' : 'pos'}">${money(x.net)}</b>` }],
      r, { foot: [{ v: t('total') }, { v: '' }, { v: money(r.reduce((s, x) => s + x.receivable, 0)), num: true }, { v: money(r.reduce((s, x) => s + x.advance, 0)), num: true }, { v: money(r.reduce((s, x) => s + x.net, 0)), num: true }] });
    c.querySelector('#rbody').onclick = (e) => {
      const a = e.target.closest('.drill'); if (!a || !a.dataset.tid) return; e.preventDefault();
      const name = (r.find((x) => String(x.id) === a.dataset.tid) || {}).tenant || '';
      accountDrill({ title: name, tenant_id: a.dataset.tid, accounts: a.dataset.kind === 'adv' ? ['21500'] : ['11000', '11100'] });
    };
    bindPrint(c, t('m_cust_summary'));
  }
  async function propertyPL(c) {
    reportShell(c, 'm_ppl', '', null);
    const r = await API.get('/reports/property-pl');
    c.querySelector('#rbody').innerHTML = table([{ key: 'building', label: t('building') }, { key: 'income', label: t('income'), num: true, render: (x) => money(x.income) },
      { key: 'expense', label: t('expense'), num: true, render: (x) => money(x.expense) }, { key: 'net', label: t('net'), num: true, render: (x) => `<b>${money(x.net)}</b>` }], r);
    bindPrint(c, t('m_ppl'));
  }
  async function roi(c) {
    reportShell(c, 'm_roi', '', null);
    const r = await API.get('/reports/roi');
    c.querySelector('#rbody').innerHTML = table([{ key: 'building', label: t('building') }, { key: 'purchase_value', label: 'قيمة الشراء', num: true, render: (x) => money(x.purchase_value) },
      { key: 'annual_net', label: 'صافي الربح', num: true, render: (x) => money(x.annual_net) }, { key: 'roi_percent', label: 'ROI %', num: true, render: (x) => x.roi_percent + '%' }], r);
    bindPrint(c, t('m_roi'));
  }
  async function comparison(c) {
    reportShell(c, 'm_comparison', '', null);
    const r = await API.get('/reports/building-comparison');
    c.querySelector('#rbody').innerHTML = table([{ key: 'building', label: t('building') },
      { key: 'units', label: t('m_units'), num: true }, { key: 'occupancy_rate', label: t('occupancy_rate'), num: true, render: (x) => x.occupancy_rate + '%' },
      { key: 'income', label: t('income'), num: true, render: (x) => money(x.income) }, { key: 'expense', label: t('expense'), num: true, render: (x) => money(x.expense) },
      { key: 'net', label: t('net'), num: true, render: (x) => `<b>${money(x.net)}</b>` }, { key: 'roi_percent', label: 'ROI %', num: true, render: (x) => x.roi_percent + '%' }], r);
    bindPrint(c, t('m_comparison'));
  }
  async function cashflow(c) {
    reportShell(c, 'm_cashflow', '', null);
    const r = await API.get('/reports/cash-flow');
    c.querySelector('#rbody').innerHTML = table([{ key: 'period', label: t('period') }, { key: 'expected_inflow', label: 'المتوقع', num: true, render: (x) => money(x.expected_inflow) }], r);
    bindPrint(c, t('m_cashflow'));
  }
  async function vat(c) {
    const from = c._from || '', to = c._to || today();
    reportShell(c, 'm_vat', `<div class="field" style="margin:0"><label>${t('from')}</label><input type="date" id="f" value="${from}"></div><div class="field" style="margin:0"><label>${t('to')}</label><input type="date" id="t2" value="${to}"></div>`, null);
    const r = await API.get(`/reports/vat?from=${from}&to=${to}`);
    c.querySelector('#rbody').innerHTML = `<div class="bd">
      <div class="section-title">أساس الاستحقاق (من الفواتير)</div>
      <table>
        <tr><td>ض.ق.م مستحقة (على الفواتير الصادرة)</td><td class="num"><b>${money(r.vat_due)}</b></td></tr>
        <tr><td>ض.ق.م محصّلة فعلاً</td><td class="num pos">${money(r.vat_collected)}</td></tr>
        <tr><td>ض.ق.م غير محصّلة (ضمن ذمم العملاء)</td><td class="num neg">${money(r.vat_outstanding)}</td></tr></table>
      <div class="section-title" style="margin-top:14px">التسوية مع الضرائب</div>
      <table>
        <tr><td>ض.ق.م المخرجات (Output) — حساب 23200</td><td class="num">${drillA(money(r.output_vat), 'data-acc="23200"')}</td></tr>
        <tr><td>ض.ق.م المدخلات (Input) — حساب 11600</td><td class="num">${drillA(money(r.input_vat), 'data-acc="11600"')}</td></tr>
        <tfoot><tr><td>صافي المستحق للضرائب</td><td class="num"><b>${drillA(money(r.net_payable), 'data-accs="23200,11600"')}</b></td></tr></tfoot></table>
      <p class="muted" style="font-size:11px;margin-top:8px">اضغط على أي رقم في «التسوية مع الضرائب» لعرض الحركات والقيود اللي كوّنته.</p></div>`;
    c.querySelector('#rbody').onclick = (e) => {
      const a = e.target.closest('.drill'); if (!a) return; e.preventDefault();
      if (a.dataset.acc) accountDrill({ title: 'ض.ق.م ' + a.dataset.acc, account: a.dataset.acc, from, to });
      else if (a.dataset.accs) accountDrill({ title: 'صافي ض.ق.م', accounts: a.dataset.accs.split(','), from, to });
    };
    c.querySelector('#f').onchange = (e) => { c._from = e.target.value; vat(c); };
    c.querySelector('#t2').onchange = (e) => { c._to = e.target.value; vat(c); };
    bindPrint(c, t('m_vat'));
  }
  async function assets(c) {
    const bl = await ref('buildings');
    await Pages.masterScreen(c, { title: t('m_assets'), endpoint: 'assets', type: 'assets', template: true, import: false, wide: true,
      columns: [{ key: 'name', label: t('name') }, { key: 'category', label: t('category') },
        { key: 'cost', label: 'التكلفة', num: true, render: (r) => money(r.cost) },
        { key: 'accum_depreciation', label: 'مجمع الإهلاك', num: true, render: (r) => money(r.accum_depreciation) },
        { key: 'nbv', label: 'القيمة الدفترية', num: true, render: (r) => money(r.cost - r.accum_depreciation) },
        { key: 'status', label: t('status'), render: (r) => statusBadge(r.status) }],
      fields: [{ key: 'name', label: t('name'), required: true }, { key: 'name_ar', label: 'عربي' },
        { key: 'building_id', label: t('building'), type: 'select', options: [{ value: '', label: '—' }].concat(bl.map((b) => ({ value: b.id, label: b.name }))) },
        { key: 'category', label: t('category'), type: 'select', options: [{ value: 'building', label: 'مبنى' }, { value: 'furniture', label: 'أثاث' }, { value: 'equipment', label: 'معدات' }, { value: 'vehicle', label: 'سيارة' }] },
        { key: 'cost', label: 'التكلفة', type: 'number', step: '0.001', required: true },
        { key: 'salvage_value', label: 'قيمة الخردة', type: 'number', step: '0.001', value: 0 },
        { key: 'life_years', label: 'العمر (سنوات)', type: 'number', value: 5 },
        { key: 'purchase_date', label: 'تاريخ الشراء', type: 'date' }] });
    const tb = c.querySelector('.toolbar');
    if (tb && canWrite()) {
      const b = document.createElement('button'); b.className = 'btn teal'; b.textContent = 'ترحيل إهلاك ' + curMonth();
      b.onclick = async () => { if (confirm('ترحيل إهلاك هذا الشهر لكل الأصول؟')) { try { const r = await API.post('/assets/depreciation/run', { period: curMonth() }); toast(`تم ترحيل إهلاك ${r.posted} أصل`); assets(c); } catch (e) { toast(e.message, 'err'); } } };
      tb.insertBefore(b, tb.querySelector('.tb-new') || null);
    }
  }
  async function depreciation(c) {
    reportShell(c, 'm_depreciation', '', null);
    const r = await API.get('/reports/depreciation' + (window.UT ? UT.bq(true) : ''));
    c.querySelector('#rbody').innerHTML = table([{ key: 'name', label: t('name') }, { key: 'building', label: t('building') },
      { key: 'cost', label: 'التكلفة', num: true, render: (x) => money(x.cost) }, { key: 'monthly', label: 'إهلاك شهري', num: true, render: (x) => money(x.monthly) },
      { key: 'accum_depreciation', label: 'مجمع الإهلاك', num: true, render: (x) => money(x.accum_depreciation) },
      { key: 'net_book_value', label: 'القيمة الدفترية', num: true, render: (x) => `<b>${money(x.net_book_value)}</b>` }], r);
    bindPrint(c, t('m_depreciation'));
  }
  async function cheques(c) {
    loading(c);
    const [rows, bl] = [await API.get('/cheques'), await ref('banks', '/banks')];
    const tbCfg = { search: true, searchFn: (rs, q) => rs.filter((r) => [r.cheque_no, r.party].join(' ').toLowerCase().includes(q)),
      exportType: 'cheques', templateType: 'cheques', onImport: () => importModal('cheques', '', () => cheques(c)),
      onNew: canWrite() ? () => chequeForm(bl, () => cheques(c)) : null, newLabel: 'شيك جديد' };
    c.innerHTML = toolbar(tbCfg) + `<div class="card"><div class="hd"><h3>${t('m_cheques')}</h3><button class="btn sm btn-print">🖨</button></div><div id="cht"></div></div>`;
    const cols = [{ key: 'direction', label: 'النوع', render: (r) => r.direction === 'incoming' ? 'وارد (قبض)' : 'صادر (صرف)' },
      { key: 'cheque_no', label: 'رقم الشيك' }, { key: 'party', label: 'الطرف' }, { key: 'amount', label: t('amount'), num: true, render: (r) => money(r.amount) },
      { key: 'due_date', label: t('due_date'), render: (r) => dateStr(r.due_date) }, { key: 'status', label: t('status'), render: (r) => statusBadge(r.status) },
      { key: '_a', label: t('actions'), render: (r) => r.status === 'pending' && canWrite() ? `<button class="btn sm primary" data-rel="${r.id}">تحصيل/صرف (ترحيل)</button>` : '' }];
    const draw = (rs) => c.querySelector('#cht').innerHTML = table(cols, rs);
    draw(rows); wireToolbar(c, tbCfg, draw, rows);
    c.querySelector('.btn-print').onclick = () => printTable(t('m_cheques'), cols.slice(0, -1), rows);
    c.querySelector('#cht').onclick = async (e) => {
      const b = e.target.closest('[data-rel]'); if (!b) return;
      if (!confirm('ترحيل الشيك للبنك المختار وعمل القيد؟')) return;
      try { await API.post('/cheques/' + b.dataset.rel + '/release', {}); toast('تم الترحيل للبنك'); cheques(c); } catch (er) { toast(er.message, 'err'); }
    };
  }
  function chequeForm(bl, done) {
    formModal({ title: 'شيك جديد', wide: true, fields: [
      { key: 'direction', label: 'النوع', type: 'select', options: [{ value: 'incoming', label: 'وارد (قبض من عميل)' }, { value: 'outgoing', label: 'صادر (صرف لمورد)' }] },
      { key: 'cheque_no', label: 'رقم الشيك', required: true },
      { key: 'bank_id', label: 'البنك', type: 'select', options: bl.map((b) => ({ value: b.id, label: b.name })) },
      { key: 'party', label: 'الطرف (اسم)' },
      { key: 'amount', label: t('amount'), type: 'number', step: '0.001', required: true },
      { key: 'issue_date', label: 'تاريخ الإصدار', type: 'date', value: today() },
      { key: 'due_date', label: t('due_date'), type: 'date', required: true },
    ], onSave: async (d, close) => { await API.post('/cheques', d); toast(t('saved')); close(); done(); } });
  }

  // ---- Cheques dashboard (to-collect vs to-pay, with roll-over of overdue) --
  async function chequesDashboard(c) {
    const asOf = c._asOf || today();
    reportShell(c, 'm_cheques_dash', `<div class="field" style="margin:0"><label>${t('date')}</label><input type="date" id="a" value="${asOf}"></div>`, null);
    const r = await API.get('/reports/cheques-dashboard?asOf=' + asOf);
    const kpi = (lbl, val, sub, cls) => `<div class="card kpi ${cls}"><div class="lbl">${lbl}</div><div class="val mono">${val}</div><div class="sub">${sub}</div></div>`;
    const stBadge = (x) => { const d = (x.due_date || '').slice(0, 10); return d && d < asOf ? badge('متأخر', 'b-red') : (d === asOf ? badge('اليوم', 'b-amber') : badge('قادم', 'b-blue')); };
    const chTbl = (list) => table([
      { key: 'due_date', label: t('due_date'), render: (x) => dateStr(x.due_date) },
      { key: 'cheque_no', label: 'رقم الشيك' },
      { key: 'party', label: 'الطرف' },
      { key: 'amount', label: t('amount'), num: true, render: (x) => money(x.amount) },
      { key: 'st', label: t('status'), render: stBadge },
    ], list, { empty: 'لا يوجد' });
    const inc = r.incoming, out = r.outgoing;
    c.querySelector('#rbody').innerHTML = `<div class="bd">
      <div class="grid g-4" style="margin-bottom:16px">
        ${kpi('وارد مستحق تحصيله الآن', money(inc.due_now.amount), inc.due_now.count + ' شيك (متأخر + اليوم)', inc.due_now.amount ? 'k-amber' : 'k-green')}
        ${kpi('صادر مستحق صرفه الآن', money(out.due_now.amount), out.due_now.count + ' شيك', out.due_now.amount ? 'k-red' : 'k-green')}
        ${kpi('وارد قادم', money(inc.upcoming.amount), inc.upcoming.count + ' شيك', 'k-blue')}
        ${kpi('صادر قادم', money(out.upcoming.amount), out.upcoming.count + ' شيك', 'k-teal')}
      </div>
      <h3>🟢 شيكات واردة (تحصيل من العملاء) — مستحقة الآن</h3>${chTbl(inc.due_now.list)}
      <h3 style="margin-top:14px">شيكات واردة قادمة</h3>${chTbl(inc.upcoming.list)}
      <h3 style="margin-top:18px">🔴 شيكات صادرة (صرف للموردين) — مستحقة الآن</h3>${chTbl(out.due_now.list)}
      <h3 style="margin-top:14px">شيكات صادرة قادمة</h3>${chTbl(out.upcoming.list)}
      <p class="muted" style="margin-top:10px">أي شيك فات تاريخ استحقاقه ولم يُحصّل يظل ضمن «مستحق الآن» تلقائيًا لحد ما ترحّله من شاشة «${t('m_cheques')}».</p>
    </div>`;
    c.querySelector('#a').onchange = (e) => { c._asOf = e.target.value; chequesDashboard(c); };
    bindPrint(c, t('m_cheques_dash'));
  }

  // ---- Journals ----
  const JL = { invoice: 'فاتورة', recognition: 'تحقق إيراد', receipt: 'قبض', payment: 'صرف', expense: 'مصروف', deposit: 'تأمين', opening: 'افتتاحي', manual: 'يدوي', adjustment: 'تسوية' };
  async function journals(c) {
    loading(c);
    const rows = await API.get('/journals');
    const tbCfg = { search: true, searchFn: (rs, q) => rs.filter((r) => [r.reference, r.memo, r.jtype].join(' ').toLowerCase().includes(q)),
      exportType: 'journals', templateType: 'journals', onImport: () => importModal('journals', '', () => journals(c)),
      onNew: canWrite() ? () => manualJournal(null, () => journals(c)) : null, newLabel: 'قيد يدوي' };
    const canDel = canDo('delete');
    c.innerHTML = toolbar(tbCfg) + `<div class="card"><div class="hd"><h3>${t('m_journals')}</h3><div style="display:flex;gap:6px">${canDel ? UI.bulkDelHTML() : ''}<button class="btn sm btn-print">🖨</button></div></div><div id="jt"></div></div>`;
    const cols = [...(canDel ? [{ key: '_s', label: '<input type="checkbox" class="sel-all">', render: (r) => `<input type="checkbox" class="row-sel" data-id="${r.id}">` }] : []),
      { key: 'jdate', label: t('date'), render: (r) => dateStr(r.jdate) }, { key: 'jtype', label: 'النوع', render: (r) => JL[r.jtype] || r.jtype },
      { key: 'reference', label: 'المرجع' }, { key: 'memo', label: t('description') },
      { key: 'total', label: 'الإجمالي', num: true, render: (r) => `<b>${money(r.total)}</b>` },
      { key: '_a', label: t('actions'), render: (r) => actions(r.id, canDo('edit') ? ['view', 'edit', 'print', 'delete'] : ['view', 'print']) }];
    const draw = (rs) => { c.querySelector('#jt').innerHTML = table(cols, rs); UI.makeSortable(c); UI.wireBulk(c, (id) => API.del('/journals/' + id), () => journals(c)); };
    draw(rows); wireToolbar(c, tbCfg, draw, rows);
    c.querySelector('.btn-print').onclick = () => printTable(t('m_journals'), cols.filter((x) => x.key !== '_s' && x.key !== '_a'), rows);
    c.querySelector('#jt').onclick = async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const id = b.dataset.id, r = rows.find((x) => String(x.id) === String(id));
      const sysWarn = r && r.jtype !== 'manual' ? '\n\n⚠️ ده قيد نظامي (ناتج عن فاتورة/سند/إهلاك). التعديل عليه بيفصله عن مستنده الأصلي.' : '';
      if (b.dataset.act === 'delete') { if (confirm(t('confirm_delete') + sysWarn)) { try { await API.del('/journals/' + id); toast(t('deleted')); journals(c); } catch (er) { toast(er.message, 'err'); } } return; }
      const j = await API.get('/journals/' + id);
      if (b.dataset.act === 'edit') { if (sysWarn && !confirm('تعديل القيد؟' + sysWarn)) return; return manualJournal(j, () => journals(c)); }
      const html = `<p class="muted">${esc(j.memo || '')} — ${dateStr(j.jdate)}</p>` +
        table([{ key: 'account_code', label: t('code') }, { key: 'account_name', label: t('account') }, { key: 'building', label: t('building') },
          { key: 'debit', label: t('debit'), num: true, render: (x) => x.debit ? money(x.debit) : '' }, { key: 'credit', label: t('credit'), num: true, render: (x) => x.credit ? money(x.credit) : '' }], j.lines);
      if (b.dataset.act === 'print') return printReport('Journal #' + j.id, html);
      modal({ title: `قيد #${j.id}`, wide: true, bodyHTML: html, footerHTML: `<button class="btn" id="pj">🖨 ${t('print')}</button>`, onMount: (bg) => bg.querySelector('#pj').onclick = () => printReport('Journal #' + j.id, html) });
    };
  }
  async function manualJournal(existing, done) {
    const [ac, bl] = [await ref('accounts'), await ref('buildings')];
    let lines = existing ? existing.lines.map((l) => ({ account_code: l.account_code, debit: l.debit, credit: l.credit, building_id: l.building_id })) : [{}, {}];
    modal({ title: existing ? 'تعديل قيد #' + existing.id : 'قيد يومية يدوي', wide: true,
      bodyHTML: `<div class="form-grid"><div class="field"><label>${t('date')}</label><input id="jd" type="date" value="${existing ? dateStr(existing.jdate) : today()}"></div>
        <div class="field"><label>المرجع</label><input id="jr" value="${existing ? esc(existing.reference || '') : ''}"></div>
        <div class="field"><label>${t('building')}</label><select id="jb"><option value="">— كل —</option>${bl.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></div>
        <div class="field"><label>${t('description')}</label><input id="jm" value="${existing ? esc(existing.memo || '') : ''}"></div></div>
        <table><thead><tr><th>${t('account')}</th><th>${t('debit')}</th><th>${t('credit')}</th><th></th></tr></thead><tbody id="jlb"></tbody></table>
        <button class="btn sm" id="addr" style="margin-top:8px">＋ سطر</button> <span class="muted" id="jbal" style="margin-inline-start:12px"></span>`,
      footerHTML: `<button class="btn primary" id="js">${t('save')}</button>`,
      onMount: (bg, close) => {
        const jbId = () => bg.querySelector('#jb').value || null;
        const render = () => { bg.querySelector('#jlb').innerHTML = lines.map((l, i) => `<tr>
          <td><select data-i="${i}" data-k="account_code" style="min-width:180px">${ac.map((a) => `<option value="${a.code}" ${a.code === l.account_code ? 'selected' : ''}>${esc(a.code + ' - ' + (a.name_ar || a.name))}</option>`).join('')}</select></td>
          <td><input data-i="${i}" data-k="debit" type="number" step="0.001" style="width:100px" value="${l.debit || ''}"></td>
          <td><input data-i="${i}" data-k="credit" type="number" step="0.001" style="width:100px" value="${l.credit || ''}"></td>
          <td><button class="ico-btn" data-del="${i}" title="حذف السطر">🗑</button></td></tr>`).join(''); bal(); };
        const sync = () => bg.querySelectorAll('#jlb [data-i]').forEach((inp) => { lines[+inp.dataset.i][inp.dataset.k] = inp.dataset.k === 'account_code' ? inp.value : (+inp.value || 0); });
        const bal = () => { const d = lines.reduce((s, l) => s + (+l.debit || 0), 0), cr = lines.reduce((s, l) => s + (+l.credit || 0), 0); bg.querySelector('#jbal').innerHTML = `مدين ${UI.money(d)} · دائن ${UI.money(cr)} ${Math.abs(d - cr) < 0.005 ? '<span class="pos">✓ متوازن</span>' : '<span class="neg">فرق ' + UI.money(d - cr) + '</span>'}`; };
        render();
        bg.querySelector('#jlb').addEventListener('input', () => { sync(); bal(); });
        bg.querySelector('#jlb').addEventListener('click', (e) => { const d = e.target.closest('[data-del]'); if (d) { sync(); lines.splice(+d.dataset.del, 1); if (!lines.length) lines.push({}); render(); } });
        bg.querySelector('#addr').onclick = () => { sync(); lines.push({}); render(); };
        bg.querySelector('#js').onclick = async () => { sync(); const b = jbId();
          const payload = { jdate: bg.querySelector('#jd').value, reference: bg.querySelector('#jr').value, memo: bg.querySelector('#jm').value, lines: lines.filter((l) => l.account_code && (l.debit || l.credit)).map((l) => ({ ...l, building_id: b })) };
          try { if (existing) await API.put('/journals/' + existing.id, payload); else await API.post('/journals', payload); toast(t('saved')); close(); done(); } catch (e) { toast(e.message, 'err'); } };
      } });
  }

  // ---- Grouped journals report (each day+type batch as ONE combined entry) --
  async function groupedJournals(c) {
    const from = c._from || (new Date().getFullYear() + '-01-01'), to = c._to || today();
    const grp = c._grp || 'month';
    const gOpt = (v, lbl) => `<option value="${v}" ${grp === v ? 'selected' : ''}>${lbl}</option>`;
    reportShell(c, 'm_gjournals', `<div class="field" style="margin:0"><label>${t('from')}</label><input type="date" id="f" value="${from}"></div>
      <div class="field" style="margin:0"><label>${t('to')}</label><input type="date" id="t2" value="${to}"></div>
      <div class="field" style="margin:0"><label>التجميع</label><select id="grp">${gOpt('day', 'يومي')}${gOpt('month', 'شهري')}${gOpt('range', 'الفترة كلها')}</select></div>`, null);
    const r = await API.get(`/reports/grouped-journals?from=${from}&to=${to}&group=${grp}`);
    const GJL = { invoice: 'فواتير عملاء', recognition: 'تحقق إيراد', receipt: 'سندات قبض', payment: 'سندات صرف', expense: 'مصروفات/فواتير موردين', deposit: 'تأمينات', opening: 'افتتاحي', manual: 'يدوي', adjustment: 'تسويات' };
    c.querySelector('#rbody').innerHTML = r.map((g) => `<div style="margin-bottom:16px"><h3 style="margin:0 0 4px">${dateStr(g.jdate)} — ${GJL[g.jtype] || g.jtype}</h3>${
      table([{ key: 'account_code', label: t('code') }, { key: 'account_name', label: t('account') },
        { key: 'debit', label: t('debit'), num: true, render: (x) => x.debit ? money(x.debit) : '' },
        { key: 'credit', label: t('credit'), num: true, render: (x) => x.credit ? money(x.credit) : '' }], g.lines,
        { foot: [{ v: '' }, { v: t('total') }, { v: money(g.total_debit), num: true }, { v: money(g.total_credit), num: true }] })
    }</div>`).join('') || `<div class="empty">${t('no_data')}</div>`;
    c.querySelector('#f').onchange = (e) => { c._from = e.target.value; groupedJournals(c); };
    c.querySelector('#t2').onchange = (e) => { c._to = e.target.value; groupedJournals(c); };
    c.querySelector('#grp').onchange = (e) => { c._grp = e.target.value; groupedJournals(c); };
    bindPrint(c, t('m_gjournals'));
  }

  // ---- Legacy-system journals (one combined monthly entry, Peachtree-ready) --
  async function legacyJournals(c) {
    const from = c._from || (new Date().getFullYear() + '-01-01'), to = c._to || today();
    const side = c._side || 'all';
    const sOpt = (v, lbl) => `<option value="${v}" ${side === v ? 'selected' : ''}>${lbl}</option>`;
    reportShell(c, 'm_legacy', `<div class="field" style="margin:0"><label>${t('from')}</label><input type="date" id="f" value="${from}"></div>
      <div class="field" style="margin:0"><label>${t('to')}</label><input type="date" id="t2" value="${to}"></div>
      <div class="field" style="margin:0"><label>النوع</label><select id="side">${sOpt('all', 'الكل')}${sOpt('revenue', 'الإيرادات')}${sOpt('expense', 'المصروفات')}</select></div>`, null);
    const r = await API.get(`/reports/legacy-journals?from=${from}&to=${to}&side=${side}`);
    const monthName = (p) => { const [y, m] = p.split('-'); return ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'][(+m) - 1] + ' ' + y; };
    const amtLink = (x, per, sideVal) => { const v = sideVal === 'debit' ? x.debit : x.credit; return v ? `<a href="#" class="drill" data-acc="${esc(x.account_code)}" data-name="${esc(x.account_name)}" data-per="${per}" data-side="${sideVal}">${money(v)}</a>` : ''; };
    c.querySelector('#rbody').innerHTML = r.map((g) => {
      const rowsH = g.lines.map((x) => `<tr><td>${esc(x.account_code)}</td><td>${esc(x.account_name)}</td><td class="num">${amtLink(x, g.period, 'debit')}</td><td class="num">${amtLink(x, g.period, 'credit')}</td></tr>`).join('');
      return `<div style="margin-bottom:18px"><h3 style="margin:0 0 4px">قيد ${monthName(g.period)} — ${side === 'revenue' ? 'إيرادات' : side === 'expense' ? 'مصروفات' : 'مجمّع'}</h3>
        <div class="table-wrap"><table><thead><tr><th>${t('code')}</th><th>${t('account')}</th><th class="num">${t('debit')}</th><th class="num">${t('credit')}</th></tr></thead>
        <tbody>${rowsH}</tbody><tfoot><tr><td></td><td>${t('total')}</td><td class="num">${money(g.total_debit)}</td><td class="num">${money(g.total_credit)}</td></tr></tfoot></table></div></div>`;
    }).join('') || `<div class="empty">${t('no_data')}</div>`;
    c.querySelector('#rbody').onclick = async (e) => {
      const a = e.target.closest('.drill[data-acc]'); if (!a) return; e.preventDefault();
      let dr; try { dr = await API.get(`/reports/legacy-drill?account=${a.dataset.acc}&period=${a.dataset.per}&side=${a.dataset.side}`); } catch (er) { return toast(er.message, 'err'); }
      const sideAr = a.dataset.side === 'debit' ? 'مدين' : 'دائن';
      const kindLbl = dr.kind === 'unpaid' ? 'مين ما دفعش استحقاق الشهر' : dr.kind === 'old' ? 'مين دفع من القديم' : sideAr;
      const title = `${a.dataset.acc} ${a.dataset.name} — ${kindLbl} (${a.dataset.per})`;
      const body = table([{ key: 'party', label: t('tenant') + '/' + t('vendor'), render: (x) => esc(x.party) },
        { key: 'flat', label: t('unit'), render: (x) => esc(x.flat || '') },
        { key: 'amount', label: t('amount'), num: true, render: (x) => money(x.amount) }], dr.rows,
        { foot: [{ v: t('total') }, { v: '' }, { v: money(dr.total), num: true }] });
      modal({ title, wide: true, bodyHTML: body, footerHTML: `<button class="btn" id="dx">📊 Excel</button><button class="btn" id="dp">🖨 ${t('print')}</button>`,
        onMount: (bg) => { bg.querySelector('#dp').onclick = () => printReport(title, body); bg.querySelector('#dx').onclick = () => UI.exportTableToExcel(title, body); } });
    };
    c.querySelector('#f').onchange = (e) => { c._from = e.target.value; legacyJournals(c); };
    c.querySelector('#t2').onchange = (e) => { c._to = e.target.value; legacyJournals(c); };
    c.querySelector('#side').onchange = (e) => { c._side = e.target.value; legacyJournals(c); };
    bindPrint(c, t('m_legacy'));
  }

  // ---- Users & permissions ----
  // per-screen permissions grouped by category (each screen keyed by its nav path)
  const PGROUPS = [
    ['الرئيسية', [['dashboard', 'لوحة التحكم']]],
    ['الأملاك', [['buildings', 'البنايات'], ['units', 'الوحدات'], ['calendar', 'كالندر الإشغال']]],
    ['العملاء (ذمم مدينة)', [['customers', 'العملاء'], ['contracts', 'العقود'], ['invoices', 'الفواتير الشهرية'], ['receipts', 'سندات القبض'], ['cust_summary', 'ملخص حسابات العملاء'], ['statement', 'كشف حساب'], ['ar_aging', 'أعمار الذمم المدينة']]],
    ['الموردون (ذمم دائنة)', [['vendors', 'الموردون'], ['bills', 'فواتير الموردين'], ['vpayments', 'سندات الصرف'], ['ap_aging', 'أعمار الذمم الدائنة']]],
    ['المالية', [['coa', 'شجرة الحسابات'], ['journals', 'القيود اليومية'], ['gjournals', 'القيود المجمعة'], ['legacy', 'قيود النظام القديم'], ['tb', 'ميزان المراجعة'], ['is', 'قائمة الدخل'], ['is_consolidated', 'قائمة الدخل المجمعة'], ['gl', 'دفتر الأستاذ'], ['bs', 'المركز المالي'], ['liquidity', 'تقرير السيولة'], ['cashflow', 'التدفق النقدي'], ['ppl', 'أرباح العقارات'], ['roi', 'العائد ROI'], ['comparison', 'مقارنة أداء البنايات']]],
    ['الخزينة والبنوك', [['banks', 'الحسابات البنكية'], ['cheques', 'الشيكات'], ['cheques_dash', 'متابعة الشيكات'], ['reconciliation', 'التسوية البنكية']]],
    ['الأصول', [['assets', 'الأصول الثابتة'], ['depreciation', 'جدول الإهلاك']]],
    ['الضرائب', [['vat', 'تقرير ض.ق.م']]],
    ['الموارد البشرية', [['employees', 'الموظفون والرواتب']]],
    ['الإعدادات', [['company', 'بيانات البناية'], ['categories', 'التصنيفات'], ['paymethods', 'طرق الدفع'], ['users', 'المستخدمون والصلاحيات']]],
  ];
  async function users(c) {
    loading(c);
    const rows = await API.get('/users');
    const tbCfg = { search: false, onNew: () => userForm(null, () => users(c)), newLabel: 'مستخدم' };
    c.innerHTML = toolbar(tbCfg) + `<div class="card"><div class="hd"><h3>${t('m_users')}</h3></div><div id="ut"></div></div>`;
    const cols = [{ key: 'username', label: t('username') }, { key: 'full_name', label: t('name') },
      { key: 'role', label: t('role'), render: (r) => badge(t(r.role), 'b-blue') }, { key: 'active', label: t('status'), render: (r) => r.active ? badge('نشط', 'b-green') : badge('موقوف', 'b-gray') },
      { key: '_a', label: t('actions'), render: (r) => actions(r.id, ['edit']) + `<button class="ico-btn" data-act="perms" data-id="${r.id}" title="${t('permissions')}">🔐</button>` }];
    c.querySelector('#ut').innerHTML = table(cols, rows);
    wireToolbar(c, tbCfg, () => {}, rows);
    c.querySelector('#ut').onclick = (e) => { const b = e.target.closest('[data-act]'); if (!b) return; const r = rows.find((x) => x.id === +b.dataset.id);
      if (b.dataset.act === 'edit') userForm(r, () => users(c)); if (b.dataset.act === 'perms') permsForm(r, () => users(c)); };
  }
  function userForm(row, done) {
    formModal({ title: row ? t('edit') : 'مستخدم جديد', fields: [
      { key: 'username', label: t('username'), required: !row, readonly: !!row, value: row ? row.username : '' },
      { key: 'full_name', label: t('name'), value: row ? row.full_name : '' },
      { key: 'password', label: t('password') + (row ? ' (اتركه فارغاً)' : ''), type: 'text' },
      { key: 'role', label: t('role'), type: 'select', options: [{ value: 'accountant', label: t('accountant') }, { value: 'admin', label: t('admin') }, { value: 'viewer', label: t('viewer') }], value: row ? row.role : 'accountant' },
    ], onSave: async (d, close) => { if (row) await API.put('/users/' + row.id, d); else await API.post('/users', d); toast(t('saved')); close(); done(); } });
  }
  async function permsForm(row, done) {
    const [perms, allBld, myBld] = [await API.get('/users/' + row.id + '/permissions'), await ref('buildings'), await API.get('/users/' + row.id + '/buildings')];
    const pm = {}; perms.forEach((p) => pm[p.module] = p);
    modal({ title: t('permissions') + ' — ' + row.full_name, wide: true,
      bodyHTML: `<div class="section-title">البنايات المسموح بها (فارغ = لا شيء / الأدمن يرى الكل)</div>
        <div class="grid g-3" style="gap:6px">${allBld.map((b) => `<label style="font-weight:500"><input type="checkbox" data-bld="${b.id}" style="width:auto" ${myBld.includes(b.id) ? 'checked' : ''}> ${esc(b.name)}</label>`).join('')}</div>
        <div class="section-title" style="margin-top:16px">صلاحيات الشاشات (كل شاشة على حدة — زي SPUR)</div>
        <label style="font-weight:600;display:block;margin-bottom:8px"><input type="checkbox" id="perm-all" style="width:auto"> تحديد الكل</label>
        <table><thead><tr><th>الشاشة</th><th>عرض</th><th>إضافة</th><th>تعديل</th><th>مسح</th></tr></thead><tbody>
        ${PGROUPS.map(([grp, items]) => `<tr class="perm-grp"><td colspan="5" style="background:#eef2f7;font-weight:700">${esc(grp)}
            <label style="float:left;font-weight:500;font-size:11px"><input type="checkbox" class="grp-all" data-grp="${esc(grp)}" style="width:auto"> الكل</label></td></tr>` +
          items.map(([m, lbl]) => { const p = pm[m] || {}; return `<tr data-grp="${esc(grp)}"><td style="padding-inline-start:22px">${esc(lbl)}</td>
          ${['can_view', 'can_add', 'can_edit', 'can_delete'].map((k) => `<td><input type="checkbox" data-m="${m}" data-k="${k}" ${p[k] ? 'checked' : ''}></td>`).join('')}</tr>`; }).join('')).join('')}
        </tbody></table>`,
      footerHTML: `<button class="btn primary" id="ps">${t('save')}</button>`,
      onMount: (bg, close) => {
      const allChk = bg.querySelector('#perm-all');
      if (allChk) allChk.onchange = () => bg.querySelectorAll('[data-m]').forEach((i) => { i.checked = allChk.checked; });
      bg.querySelectorAll('.grp-all').forEach((g) => g.onchange = () => bg.querySelectorAll(`tr[data-grp="${g.dataset.grp}"] [data-m]`).forEach((i) => { i.checked = g.checked; }));
      bg.querySelector('#ps').onclick = async () => {
        const map = {}; bg.querySelectorAll('[data-m]').forEach((i) => { map[i.dataset.m] = map[i.dataset.m] || { module: i.dataset.m }; map[i.dataset.m][i.dataset.k] = i.checked ? 1 : 0; });
        const blds = [...bg.querySelectorAll('[data-bld]:checked')].map((i) => +i.dataset.bld);
        await API.put('/users/' + row.id + '/permissions', { permissions: Object.values(map) });
        await API.put('/users/' + row.id + '/buildings', { building_ids: blds });
        toast(t('saved')); close(); done();
      };
      } });
  }
  async function company(c) {
    loading(c);
    const s = await API.get('/settings');
    c.innerHTML = `<div class="card" style="max-width:720px"><div class="hd"><h3>${t('m_company')}</h3><div style="display:flex;gap:6px">${isAdmin() ? '<button class="btn" id="creconcile">🧹 توحيد الأرصدة الافتتاحية</button>' : ''}<button class="btn" id="cbackup">💾 نسخة احتياطية</button><button class="btn primary" id="csave">${t('save')}</button></div></div><div class="bd">
      <div class="form-grid">
        <div class="field"><label>اسم الشركة (EN)</label><input id="company_name" value="${esc(s.company_name || '')}"></div>
        <div class="field"><label>الاسم عربي</label><input id="company_name_ar" value="${esc(s.company_name_ar || '')}"></div>
        <div class="field"><label>رقم السجل التجاري</label><input id="cr_number" value="${esc(s.cr_number || '')}"></div>
        <div class="field"><label>الرقم الضريبي (VAT)</label><input id="vat_number" value="${esc(s.vat_number || '')}"></div>
        <div class="field"><label>ض.ق.م %</label><input id="vat_percent" value="${esc(s.vat_percent || '5')}"></div>
        <div class="field"><label>العملة</label><input id="currency" value="${esc(s.currency || 'OMR')}" readonly></div>
        <div class="field full"><label>📧 البريد الذي تُرسل منه الفواتير</label><input id="send_email" type="email" value="${esc(s.send_email || '')}" placeholder="accounts@usoman.com"></div>
        <div class="field full"><label>🤖 مفتاح المساعد الذكي (Anthropic API Key)</label><input id="ai_api_key" type="password" value="${esc(s.ai_api_key || '')}" placeholder="sk-ant-..."><span class="muted" style="font-size:11px">لتفعيل زر المساعد الذكي 🤖 اللي بيعمل قيود وفواتير ويجاوب من بياناتك.</span></div>
        <div class="field full"><label>الشعار (Logo)</label><input type="file" id="logo_file" accept="image/*">
          <div style="margin-top:8px">${s.company_logo ? `<img id="logo_prev" src="${s.company_logo}" style="height:52px;border:1px solid var(--line);border-radius:8px;padding:4px">` : '<span class="muted" id="logo_prev">لا يوجد شعار</span>'}</div></div>
      </div>
      <p class="muted">إيميل الإرسال والشعار والأرقام دي بتظهر في الفواتير والمسودات اللي بتتبعت للعملاء. لإدارة البنايات استخدم «${t('m_buildings')}».</p>
    </div></div>`;
    let logoData = s.company_logo || '';
    c.querySelector('#logo_file').onchange = (e) => {
      const f = e.target.files[0]; if (!f) return;
      const rd = new FileReader(); rd.onload = () => { logoData = rd.result; const p = c.querySelector('#logo_prev'); const img = p.tagName === 'IMG' ? p : (() => { const i = document.createElement('img'); i.id = 'logo_prev'; i.style.cssText = 'height:52px;border:1px solid var(--line);border-radius:8px;padding:4px'; p.replaceWith(i); return i; })(); img.src = rd.result; };
      rd.readAsDataURL(f);
    };
    c.querySelector('#cbackup').onclick = () => API.download('/backup', 'united-tower-backup.db').catch((e) => toast(e.message, 'err'));
    const rec = c.querySelector('#creconcile');
    if (rec) rec.onclick = async () => {
      if (!confirm('هيشيل أرصدة (ذمم مدينة/موردين/مقدم) الإجمالية من القيد الافتتاحي اليدوي OB-2025 (لأنها متسجلة لكل عميل/مورد على حدة) ويعيد التوازن على حقوق الملكية الافتتاحية 39999.\n\n⚠️ خُد نسخة احتياطية الأول! متابعة؟')) return;
      try { const r = await API.post('/opening/reconcile', {}); toast(r.removed ? `تم حذف ${r.removed} سطر مكرر · تسوية 39999 بمبلغ ${money(r.rebalanced_to_39999)}` : (r.message || 'لا توجد أرصدة مكررة')); }
      catch (e) { toast(e.message, 'err'); }
    };
    c.querySelector('#csave').onclick = async () => {
      const keys = ['company_name', 'company_name_ar', 'cr_number', 'vat_number', 'vat_percent', 'send_email', 'ai_api_key'];
      const payload = { company_logo: logoData };
      keys.forEach((k) => payload[k] = c.querySelector('#' + k).value);
      try { await API.put('/settings', payload); toast(t('saved')); } catch (e) { toast(e.message, 'err'); }
    };
  }

  return { customers, vendors, buildings, units, categories, paymethods, banks, employees, coa,
    vendorBills, vendorPayments, trialBalance, incomeStatement, incomeStatementConsolidated, generalLedger, balanceSheet, arAging, apAging,
    statement, propertyPL, roi, cashflow, comparison, vat, cheques, chequesDashboard, journals, groupedJournals, legacyJournals, users, company, assets, depreciation, customersSummary, reconciliation, liquidity };
})());
