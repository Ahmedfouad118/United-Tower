// All application screens. Each: async render(container, params).
const Pages = (() => {
  const { esc, money, int, fmt, dateStr, today, curMonth, toast, modal, table, badge, statusBadge,
    barChart, toolbar, wireToolbar, actions, importModal, formModal, printReport } = UI;
  const loading = (c) => c.innerHTML = '<div class="spinner"></div>';
  const canWrite = () => ['admin', 'accountant'].includes((API.user() || {}).role);
  const isAdmin = () => (API.user() || {}).role === 'admin';
  // permission-aware action check for the CURRENT screen's module (UT.mod)
  const canDo = (action) => (window.UT && UT.can) ? UT.can(UT.mod, action) : canWrite();

  // ---- reference cache ----
  const cache = {};
  const ref = async (name, ep) => cache[name] || (cache[name] = await API.get(ep || ('/' + name)));
  const clearCache = () => Object.keys(cache).forEach((k) => delete cache[k]);
  const opt = (arr, val, label, sel) => arr.map((x) => `<option value="${x[val]}" ${String(x[val]) === String(sel) ? 'selected' : ''}>${esc(x[label])}</option>`).join('');
  const nameOf = (arr, id, key = 'name') => { const x = (arr || []).find((r) => String(r.id) === String(id)); return x ? x[key] : ''; };
  const printTable = (title, cols, rows) => printReport(title, table(cols, rows));

  // =========================================================== GENERIC MASTER
  async function masterScreen(c, cfg) {
    loading(c);
    const rows = await API.get('/' + cfg.endpoint);
    cache[cfg.endpoint] = rows;
    const tbCfg = {
      search: true, searchFn: cfg.searchFn || ((rs, q) => rs.filter((r) => JSON.stringify(Object.values(r)).toLowerCase().includes(q))),
      type: cfg.type, exportType: cfg.type, templateType: cfg.template ? cfg.type : null,
      onImport: (cfg.import && canDo('add')) ? () => importModal(cfg.type, cfg.importExtra, () => masterScreen(c, cfg)) : null,
      newLabel: cfg.newLabel, onNew: canDo('add') ? () => openForm(cfg) : null,
    };
    c.innerHTML = toolbar(tbCfg) + `<div class="card"><div class="hd"><h3>${esc(cfg.title)}</h3>
      <button class="btn sm btn-print">🖨 ${t('print')}</button></div><div id="mtbl"></div></div>`;
    const idKey = cfg.idKey || 'id';
    const rowActs = (cfg.rowActions || ['edit', 'delete']).filter((a) => a === 'view' ? canDo('view') : canDo(a));
    const cols = cfg.columns.concat(rowActs.length ? [{ key: '_a', label: t('actions'), render: (r) => actions(r[idKey], rowActs) }] : []);
    const draw = (rs) => c.querySelector('#mtbl').innerHTML = table(cols, rs);
    draw(rows);
    wireToolbar(c, tbCfg, draw, rows);
    c.querySelector('.btn-print').onclick = () => printTable(cfg.title, cfg.columns, rows);
    c.querySelector('#mtbl').onclick = (e) => {
      const btn = e.target.closest('[data-act]'); if (!btn) return;
      const id = btn.dataset.id, row = rows.find((r) => String(r[idKey]) === String(id));
      if (btn.dataset.act === 'delete') return delRow(cfg, id, () => masterScreen(c, cfg));
      if (btn.dataset.act === 'edit') return openForm(cfg, row, () => masterScreen(c, cfg));
      if (btn.dataset.act === 'view' && cfg.onView) return cfg.onView(row);
    };
    function openForm(cfg2, row) {
      formModal({
        title: (row ? t('edit') : t('add')) + ' — ' + cfg2.title, wide: cfg2.wide,
        fields: cfg2.fields, values: row || {},
        onSave: async (data, close) => {
          if (row) await API.put('/' + cfg2.endpoint + '/' + row[idKey], data);
          else await API.post('/' + cfg2.endpoint, data);
          toast(t('saved')); close(); clearCache(); masterScreen(c, cfg2);
        },
      });
    }
  }
  async function delRow(cfg, id, done) {
    if (!confirm(t('confirm_delete'))) return;
    try { await API.del('/' + cfg.endpoint + '/' + id); toast(t('deleted')); clearCache(); done(); }
    catch (e) { toast(e.message, 'err'); }
  }

  // =========================================================== DASHBOARD
  async function dashboard(c) {
    loading(c);
    const d = await API.get('/reports/dashboard' + (window.UT ? UT.bq(true) : ''));
    const ag = d.aging_buckets;
    const exp = d.expiring_contracts || [];
    const kpi = (lbl, val, sub, ico, cls) => `<div class="card kpi ${cls}"><div class="ico">${ico}</div>
      <div class="lbl">${lbl}</div><div class="val mono">${val}</div><div class="sub">${sub}</div></div>`;
    c.innerHTML = `
      <div class="toolbar"><div class="spacer"></div><button class="btn" id="dashprint">🖨 ${t('print')}</button></div>
      <div class="grid g-4">
        ${kpi(t('occupancy_rate'), d.occupancy_rate + '%', `${d.occupied} ${t('occupied')} · ${d.vacant} ${t('vacant')}`, '🏢', 'k-blue')}
        ${kpi(t('collected_month'), money(d.collected_this_month), 'OMR', '💰', 'k-green')}
        ${kpi(t('outstanding'), money(d.outstanding_receivables), '', '📈', 'k-amber')}
        ${kpi(t('advance_held'), money(d.advance_held), t('deposits_held') + ': ' + money(d.deposits_held), '🔒', 'k-teal')}
      </div>
      <div class="grid g-2" style="margin-top:16px">
        <div class="card"><div class="hd"><h3>${t('monthly_collection')}</h3></div><div class="bd">${barChart(d.monthly_collection, 'total', 'm')}</div></div>
        <div class="card"><div class="hd"><h3>${t('aging')}</h3></div><div class="bd">${agingBars(ag)}</div></div>
      </div>
      <div class="grid g-2" style="margin-top:16px">
        <div class="card"><div class="hd"><h3>${t('top_debtors')}</h3><a class="btn sm" href="#/ar_aging">${t('m_ar_aging')}</a></div>
          <div class="bd">${table([{ key: 'tenant', label: t('tenant') }, { key: 'total', label: t('total'), num: true, render: (r) => money(r.total) }], d.top_debtors)}</div></div>
        <div class="card"><div class="hd"><h3>${t('m_cashflow')}</h3></div><div class="bd">${barChart(d.cash_flow, 'expected_inflow', 'period')}</div></div>
      </div>
      <div class="card" style="margin-top:16px"><div class="hd"><h3>⚠️ عقود قرب انتهاؤها (خلال 60 يوم)</h3><span class="badge ${exp.length ? 'b-amber' : 'b-green'}">${exp.length}</span></div>
        <div class="bd">${table([
          { key: 'flat', label: t('unit') }, { key: 'tenant', label: t('tenant') }, { key: 'building', label: t('building') },
          { key: 'end_date', label: t('end_date'), render: (r) => dateStr(r.end_date) },
          { key: 'days_left', label: 'باقي (يوم)', num: true, render: (r) => `<span class="${r.days_left <= 15 ? 'neg' : ''}"><b>${r.days_left}</b></span>` },
          { key: 'monthly_rent', label: t('rent'), num: true, render: (r) => money(r.monthly_rent) },
        ], exp, { empty: 'لا يوجد عقود قرب انتهائها' })}</div></div>`;
    c.querySelector('#dashprint').onclick = () => printReport(t('m_dashboard'), c.innerHTML.replace(/<div class="toolbar">[\s\S]*?<\/div><\/div>/, ''));
  }
  function agingBars(ag) {
    const rows = [['حالي', ag.current], ['30', ag.d30], ['60', ag.d60], ['90', ag.d90], ['180', ag.d180], ['+180', ag.d180p]];
    const max = Math.max(...rows.map((r) => r[1]), 1);
    return `<div class="bars">${rows.map(([l, v]) => `<div class="bar"><div class="vl">${int(Math.round(v))}</div>
      <div class="col" style="height:${Math.round(v / max * 100)}%;background:linear-gradient(180deg,#e5484d,#d9820b)"></div><div class="lb">${l}</div></div>`).join('')}</div>`;
  }

  // =========================================================== OCCUPANCY
  async function occupancy(c) {
    loading(c);
    const date = c._date || today();
    const o = await API.get('/reports/occupancy?onDate=' + date);
    c.innerHTML = `<div class="toolbar">
        <div class="field" style="margin:0"><label>${t('date')}</label><input type="date" id="od" value="${date}"></div>
        <div class="spacer"></div>
        <span class="badge b-green">${t('vacant')} ${o.vacant}</span><span class="badge b-red">${t('occupied')} ${o.occupied}</span>
        <span class="badge b-blue">${t('total')} ${o.total}</span></div>
      <div class="card"><div class="bd"><div class="occ-grid">
        ${o.flats.map((f) => `<div class="flat-cell ${f.status === 'occupied' ? 'occ' : 'vac'}"><div class="dot"></div>
          <div class="code">${esc(f.flat)}</div><div class="who">${f.status === 'occupied' ? esc(f.tenant) : t('vacant')}</div>
          ${f.status === 'occupied' ? `<div class="who">${dateStr(f.end_date)} · ${money(f.monthly_rent)}</div>` : `<div class="who">${money(f.base_rent)}</div>`}</div>`).join('')}
      </div></div></div>`;
    c.querySelector('#od').onchange = (e) => { c._date = e.target.value; occupancy(c); };
  }

  // =========================================================== CONTRACTS
  async function contracts(c) {
    loading(c);
    const [rows, fl, tn, bl] = [await API.get('/contracts' + (window.UT ? UT.bq(true) : '')), await ref('flats'), await ref('tenants'), await ref('buildings')];
    const tbCfg = { search: true, searchFn: (rs, q) => rs.filter((r) => [r.flat, r.tenant, r.contract_no].join(' ').toLowerCase().includes(q)),
      exportType: 'contracts', templateType: 'contracts',
      onImport: () => importModal('contracts', `<label style="display:block;margin-top:6px"><input type="checkbox" id="imp-backfill" style="width:auto"> توليد الفواتير بعد الاستيراد</label>`, () => contracts(c)),
      onNew: canWrite() ? () => contractForm(fl, tn, () => contracts(c)) : null, newLabel: t('m_contracts') };
    c.innerHTML = toolbar(tbCfg) + `<div class="card"><div class="hd"><h3>${t('m_contracts')}</h3><button class="btn sm btn-print">🖨 ${t('print')}</button></div><div id="ct"></div></div>`;
    const cols = [
      { key: 'flat', label: t('unit') }, { key: 'tenant', label: t('tenant') }, { key: 'contract_no', label: 'العقد' },
      { key: 'start_date', label: t('start_date'), render: (r) => dateStr(r.start_date) },
      { key: 'end_date', label: t('end_date'), render: (r) => dateStr(r.end_date) },
      { key: 'monthly_rent', label: t('rent'), num: true, render: (r) => money(r.monthly_rent) },
      { key: 'contract_type', label: 'النوع', render: (r) => ({ residential: 'سكني', commercial: 'تجاري', shop: 'محل' }[r.contract_type] || r.contract_type || '') },
      { key: 'status', label: t('status'), render: (r) => statusBadge(r.status) },
      { key: '_a', label: t('actions'), render: (r) => actions(r.id, canDo('add') || canDo('edit')
        ? (r.status === 'active' ? ['view', 'edit', 'terminate'] : ['view', 'edit']) : ['view']) },
    ];
    const draw = (rs) => c.querySelector('#ct').innerHTML = table(cols, rs);
    draw(rows); wireToolbar(c, tbCfg, draw, rows);
    c.querySelector('.btn-print').onclick = () => printTable(t('m_contracts'), cols.slice(0, -1), rows);
    c.querySelector('#ct').onclick = (e) => {
      const btn = e.target.closest('[data-act]'); if (!btn) return;
      const r = rows.find((x) => x.id === +btn.dataset.id);
      if (btn.dataset.act === 'terminate') return terminate(r.id, () => { clearCache(); contracts(c); });
      if (btn.dataset.act === 'view') return contractView(r);
      if (btn.dataset.act === 'edit') return contractForm(fl, tn, () => { clearCache(); contracts(c); }, r);
    };
  }
  function contractView(r) {
    modal({ title: 'عقد ' + (r.contract_no || r.id), bodyHTML: `<table>
      <tr><td>${t('tenant')}</td><td><b>${esc(r.tenant)}</b></td></tr>
      <tr><td>${t('unit')}</td><td>${esc(r.flat)}</td></tr>
      <tr><td>${t('start_date')} - ${t('end_date')}</td><td>${dateStr(r.start_date)} → ${dateStr(r.end_date)}</td></tr>
      <tr><td>${t('rent')}</td><td>${money(r.monthly_rent)}</td></tr>
      <tr><td>${t('vat')}</td><td>${r.vat_percent}%</td></tr>
      <tr><td>${t('deposit')}</td><td>${money(r.deposit)}</td></tr>
      <tr><td>${t('status')}</td><td>${statusBadge(r.status)}</td></tr></table>` });
  }
  function contractForm(fl, tn, done, row) {
    const edit = !!row;
    formModal({
      title: (edit ? t('edit') : t('add')) + ' — ' + t('m_contracts'), wide: true,
      values: row || {},
      fields: [
        { key: 'flat_id', label: t('unit'), type: 'select', options: fl.map((f) => ({ value: f.id, label: f.code })), required: true },
        { key: 'tenant_id', label: t('tenant'), type: 'select', options: [{ value: '', label: '— جديد —' }].concat(tn.map((x) => ({ value: x.id, label: x.name }))) },
        ...(edit ? [] : [{ key: '_newtenant', label: 'اسم عميل جديد', full: true }]),
        { key: 'contract_no', label: 'رقم العقد' },
        { key: 'contract_type', label: 'نوع الوحدة', type: 'select', options: [{ value: 'residential', label: 'سكني' }, { value: 'commercial', label: 'تجاري' }, { value: 'shop', label: 'محل' }] },
        { key: 'monthly_rent', label: t('rent'), type: 'number', step: '0.001', required: true },
        { key: 'start_date', label: t('start_date'), type: 'date', value: today(), required: true },
        { key: 'end_date', label: t('end_date'), type: 'date', required: true },
        { key: 'vat_percent', label: t('vat') + ' %', type: 'number', value: 5 },
        { key: 'deposit', label: t('deposit'), type: 'number', step: '0.001', value: 0 },
        { key: 'attachment', label: '📎 صورة العقد', type: 'file', accept: 'image/*,.pdf', full: true },
        ...(edit ? [] : [{ key: 'backfill', label: 'توليد الفواتير من بداية العقد حتى الآن', type: 'checkbox', full: true }]),
      ],
      onSave: async (data, close) => {
        if (Date.parse(data.end_date) <= Date.parse(data.start_date)) return toast('تاريخ النهاية لازم يكون بعد البداية', 'err');
        let tid = data.tenant_id;
        if (!tid && data._newtenant) tid = (await API.post('/tenants', { name: data._newtenant })).id;
        if (!tid) return toast('اختر عميل أو اكتب اسم', 'err');
        if (edit) await API.put('/contracts/' + row.id, { ...data, tenant_id: +tid });
        else await API.post('/contracts', { ...data, tenant_id: +tid });
        toast(t('saved')); close(); clearCache(); done();
      },
    });
  }
  function terminate(id, done) {
    formModal({ title: t('terminate'), fields: [
      { key: 'date', label: t('date'), type: 'date', value: today() },
      { key: 'settled_amount', label: 'مبلغ التسوية (اختياري)', type: 'number', step: '0.001' },
    ], onSave: async (d, close) => { await API.post(`/contracts/${id}/terminate`, d); toast(t('saved')); close(); done(); } });
  }

  // =========================================================== INVOICES
  async function invoices(c) {
    loading(c);
    const period = c._period || curMonth();
    const rows = await API.get('/invoices?period=' + period + (window.UT ? UT.bq() : ''));
    const tbCfg = { search: true, searchFn: (rs, q) => rs.filter((r) => [r.tenant, r.flat, r.invoice_no].join(' ').toLowerCase().includes(q)),
      exportType: 'invoices', templateType: 'invoices', onImport: () => importModal('invoices', '', () => invoices(c)),
      extra: `<div class="field" style="margin:0"><label>${t('period')}</label><input type="month" id="iper" value="${period}"></div>`,
      onNew: canWrite() ? () => genInvoices(period, () => invoices(c)) : null, newLabel: t('generate_invoices') };
    c.innerHTML = toolbar(tbCfg) + `<div class="card"><div class="hd"><h3>${t('m_invoices')} — ${period}</h3>
      <div style="display:flex;gap:6px"><button class="btn sm" id="printsel">🖨 طباعة المحدد</button><button class="btn sm" id="emailsel">📧 إيميل المحدد</button>
      ${canWrite() ? `<button class="btn sm teal" id="recog">${t('recognize')}</button>` : ''}</div></div><div id="it"></div></div>`;
    const cols = [
      { key: '_c', label: '', render: (r) => `<input type="checkbox" class="inv-chk" data-id="${r.id}">` },
      { key: 'invoice_no', label: 'رقم الفاتورة' }, { key: 'tenant', label: t('tenant') }, { key: 'flat', label: t('unit') },
      { key: 'due_date', label: t('due_date'), render: (r) => dateStr(r.due_date) },
      { key: 'rent_amount', label: t('rent'), num: true, render: (r) => money(r.rent_amount) },
      { key: 'vat_amount', label: t('vat'), num: true, render: (r) => money(r.vat_amount) },
      { key: 'total', label: t('total'), num: true, render: (r) => money(r.total) },
      { key: 'paid_amount', label: t('paid'), num: true, render: (r) => money(r.paid_amount) },
      { key: 'status', label: t('status'), render: (r) => statusBadge(r.status) },
      { key: '_a', label: t('actions'), render: (r) => actions(r.id, canWrite() && r.paid_amount <= 0 ? ['view', 'print', 'email', 'delete'] : ['view', 'print', 'email']) },
    ];
    const draw = (rs) => c.querySelector('#it').innerHTML = table(cols, rs);
    draw(rows); wireToolbar(c, tbCfg, draw, rows);
    c.querySelector('#iper').onchange = (e) => { c._period = e.target.value; invoices(c); };
    const rb = c.querySelector('#recog'); if (rb) rb.onclick = async () => { const r = await API.post('/recognition/run', { period }); toast(`تم تحقّق ${r.recognized}`); invoices(c); };
    c.querySelector('#emailsel').onclick = () => {
      const ids = [...c.querySelectorAll('.inv-chk:checked')].map((x) => +x.dataset.id);
      if (!ids.length) return toast('حدد فواتير أولاً', 'err');
      emailInvoices(ids);
    };
    c.querySelector('#printsel').onclick = () => {
      const ids = [...c.querySelectorAll('.inv-chk:checked')].map((x) => +x.dataset.id);
      const sel = rows.filter((r) => ids.includes(r.id));
      if (!sel.length) return toast('حدد فواتير أولاً', 'err');
      const html = sel.map((r) => `<div style="page-break-after:always">
        <div class="krow"><div><b>${t('tenant')}:</b> ${esc(r.tenant)}</div><div><b>${t('unit')}:</b> ${esc(r.flat)}</div><div><b>${t('period')}:</b> ${r.period}</div></div>
        <table><thead><tr><th>${t('description')}</th><th class="num">${t('amount')}</th></tr></thead><tbody>
        <tr><td>${t('rent')} ${r.period}</td><td class="num">${money(r.rent_amount)}</td></tr>
        <tr><td>${t('vat')}</td><td class="num">${money(r.vat_amount)}</td></tr></tbody>
        <tfoot><tr><td>${t('total')}</td><td class="num">${money(r.total)}</td></tr></tfoot></table></div>`).join('');
      printReport('Invoices', html);
    };
    c.querySelector('#it').onclick = (e) => {
      const btn = e.target.closest('[data-act]'); if (!btn) return;
      const r = rows.find((x) => x.id === +btn.dataset.id);
      if (btn.dataset.act === 'print') return printInvoice(r);
      if (btn.dataset.act === 'view') return printInvoice(r, true);
      if (btn.dataset.act === 'email') return emailInvoices([r.id]);
      if (btn.dataset.act === 'delete') { if (confirm(t('confirm_delete'))) API.del('/invoices/' + r.id).then(() => { toast(t('deleted')); invoices(c); }).catch((e) => toast(e.message, 'err')); return; }
    };
  }
  // Group selected invoices by customer; download one Outlook draft (.eml) each.
  async function emailInvoices(ids) {
    try {
      const groups = await API.get('/invoices/email-groups?ids=' + ids.join(','));
      const noEmail = groups.filter((g) => !g.email).map((g) => g.tenant);
      for (const g of groups.filter((g) => g.email)) {
        await API.download('/invoices/eml?ids=' + g.ids.join(','), `draft-${g.tenant}.eml`);
        await new Promise((r) => setTimeout(r, 400));
      }
      const sent = groups.length - noEmail.length;
      toast(sent ? `تم تجهيز ${sent} مسودة — افتح الملف ليفتح أوتلوك` : 'لا يوجد بريد للعملاء', sent ? 'ok' : 'err');
      if (noEmail.length) toast('بدون بريد: ' + noEmail.join('، '), 'err');
    } catch (e) { toast(e.message, 'err'); }
  }
  function genInvoices(period, done) {
    formModal({ title: t('generate_invoices'), fields: [{ key: 'period', label: t('period'), type: 'month', value: period }],
      onSave: async (d, close) => { const r = await API.post('/invoices/generate', { period: d.period }); toast(`تم إصدار ${r.created} فاتورة`); close(); done(); } });
  }
  function printInvoice(r, preview) {
    const html = `<div class="krow"><div><b>${t('tenant')}:</b> ${esc(r.tenant)}</div><div><b>${t('unit')}:</b> ${esc(r.flat)}</div>
      <div><b>${t('period')}:</b> ${r.period}</div><div><b>${t('due_date')}:</b> ${dateStr(r.due_date)}</div></div>
      <table><thead><tr><th>${t('description')}</th><th class="num">${t('amount')}</th></tr></thead><tbody>
      <tr><td>${t('rent')} ${r.period}</td><td class="num">${money(r.rent_amount)}</td></tr>
      <tr><td>${t('vat')}</td><td class="num">${money(r.vat_amount)}</td></tr></tbody>
      <tfoot><tr><td>${t('total')}</td><td class="num">${money(r.total)}</td></tr>
      <tr><td>${t('paid')}</td><td class="num">${money(r.paid_amount)}</td></tr>
      <tr><td>${t('remaining')}</td><td class="num">${money(r.total - r.paid_amount)}</td></tr></tfoot></table>`;
    if (preview) modal({ title: 'فاتورة ' + r.invoice_no, wide: true, bodyHTML: html, footerHTML: `<button class="btn primary" id="pp">🖨 ${t('print')}</button>`, onMount: (bg) => bg.querySelector('#pp').onclick = () => printReport('Invoice ' + r.invoice_no, html) });
    else printReport('Invoice ' + r.invoice_no, html);
  }

  // =========================================================== RECEIPTS (سند قبض)
  async function receipts(c) {
    loading(c);
    const [rows, tn, fl, pm] = [await API.get('/payments'), await ref('tenants'), await ref('flats'), await ref('payment_methods', '/payment-methods')];
    const tbCfg = { search: true, searchFn: (rs, q) => rs.filter((r) => [r.tenant, r.voucher_no].join(' ').toLowerCase().includes(q)),
      exportType: 'payments', onImport: () => importModal('payments', '', () => receipts(c)), templateType: 'payments',
      onNew: canWrite() ? () => receiptForm(tn, fl, pm, () => receipts(c)) : null, newLabel: 'سند قبض' };
    c.innerHTML = toolbar(tbCfg) + `<div class="card"><div class="hd"><h3>${t('m_receipts')}</h3><button class="btn sm btn-print">🖨 ${t('print')}</button></div><div id="pt"></div></div>`;
    const cols = [
      { key: 'voucher_no', label: t('voucher') }, { key: 'pdate', label: t('date'), render: (r) => dateStr(r.pdate) },
      { key: 'tenant', label: t('tenant') }, { key: 'flat', label: t('unit') },
      { key: 'amount', label: t('amount'), num: true, render: (r) => money(r.amount) },
      { key: 'applied_amount', label: 'سداد', num: true, render: (r) => money(r.applied_amount) },
      { key: 'advance_amount', label: 'مقدم', num: true, render: (r) => money(r.advance_amount) },
      { key: '_a', label: t('actions'), render: (r) => actions(r.id, canDo('edit') ? ['print', 'edit', 'delete'] : ['print']) },
    ];
    const draw = (rs) => c.querySelector('#pt').innerHTML = table(cols, rs);
    draw(rows); wireToolbar(c, tbCfg, draw, rows);
    c.querySelector('.btn-print').onclick = () => printTable(t('m_receipts'), cols.slice(0, -1), rows);
    c.querySelector('#pt').onclick = async (e) => {
      const btn = e.target.closest('[data-act]'); if (!btn) return;
      const r = rows.find((x) => x.id === +btn.dataset.id);
      if (btn.dataset.act === 'delete') { if (confirm(t('confirm_delete'))) { await API.del('/payments/' + r.id); toast(t('deleted')); receipts(c); } }
      if (btn.dataset.act === 'print') voucherPrint('سند قبض', r, r.tenant);
      if (btn.dataset.act === 'edit') receiptForm(tn, fl, pm, () => receipts(c), r);
    };
  }
  function receiptForm(tn, fl, pm, done, row) {
    const edit = !!row;
    formModal({ title: 'سند قبض' + (edit ? ' (تعديل)' : ''), wide: true, values: row || {}, fields: [
      { key: 'tenant_id', label: t('tenant'), type: 'select', options: tn.map((x) => ({ value: x.id, label: x.name })), required: true },
      { key: 'flat_id', label: t('unit'), type: 'select', options: [{ value: '', label: '—' }].concat(fl.map((f) => ({ value: f.id, label: f.code }))) },
      { key: 'amount', label: t('amount'), type: 'number', step: '0.001', required: true },
      { key: 'pdate', label: t('date'), type: 'date', value: today() },
      { key: 'method', label: t('method'), type: 'select', options: [{ value: 'bank', label: 'تحويل بنكي' }, { value: 'cash', label: 'نقدي' }, { value: 'cheque', label: 'شيك' }, { value: 'card', label: 'شبكة' }] },
      { key: 'cash_account', label: t('account'), type: 'select', options: [{ value: '10400', label: 'بنك' }, { value: '10000', label: 'خزينة' }] },
      { key: 'cheque_no', label: 'رقم الشيك' },
      { key: 'memo', label: t('description'), full: true },
    ], onSave: async (d, close) => {
      const r = edit ? await API.put('/payments/' + row.id, d) : await API.post('/payments', d);
      toast(`تم — سداد ${money(r.applied)} · مقدم ${money(r.advance)}`); close(); done();
    } });
  }
  function voucherPrint(title, r, party) {
    const html = `<div class="krow"><div><b>${t('voucher')}:</b> ${esc(r.voucher_no || '')}</div><div><b>${t('date')}:</b> ${dateStr(r.pdate)}</div></div>
      <table><tr><td>الطرف</td><td><b>${esc(party || '')}</b></td></tr>
      <tr><td>${t('amount')}</td><td class="num">${money(r.amount)}</td></tr>
      <tr><td>${t('method')}</td><td>${esc(r.method || '')}</td></tr>
      <tr><td>${t('description')}</td><td>${esc(r.memo || '')}</td></tr></table>
      <div class="krow" style="margin-top:40px"><div>المستلم: ______</div><div>المحاسب: ______</div><div>المدير: ______</div></div>`;
    printReport(title + ' ' + (r.voucher_no || ''), html);
  }

  return { masterScreen, dashboard, occupancy, contracts, invoices, receipts,
    _h: { ref, clearCache, canWrite, isAdmin, opt, nameOf, printReport, printTable, voucherPrint, importModal, cache } };
})();
