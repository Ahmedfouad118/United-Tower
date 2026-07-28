// DOM + formatting helpers, modal, toast, table, toolbar, actions, print.
const UI = (() => {
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (n, dec = 3) => (n == null || n === '' || isNaN(n)) ? '0.000' : Number(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const money = (n) => fmt(n, 3);
  const int = (n) => Number(n || 0).toLocaleString('en-US');
  const dateStr = (d) => d ? String(d).slice(0, 10) : '';
  const today = () => new Date().toISOString().slice(0, 10);
  const curMonth = () => new Date().toISOString().slice(0, 7);

  function toast(msg, type = 'ok') {
    const el2 = el(`<div class="toast ${type === 'err' ? 'err' : 'ok'}">${esc(msg)}</div>`);
    document.getElementById('toast-root').appendChild(el2);
    setTimeout(() => el2.remove(), 3200);
  }

  function modal({ title, bodyHTML, footerHTML, wide, onMount }) {
    const bg = el(`<div class="modal-bg"><div class="modal ${wide ? 'lg' : ''}">
      <div class="m-hd"><h3>${esc(title)}</h3><button class="x">&times;</button></div>
      <div class="m-bd">${bodyHTML}</div>
      ${footerHTML ? `<div class="m-ft">${footerHTML}</div>` : ''}
    </div></div>`);
    const close = () => bg.remove();
    bg.querySelector('.x').onclick = close;
    bg.onclick = (e) => { if (e.target === bg) close(); };
    document.getElementById('modal-root').appendChild(bg);
    if (onMount) onMount(bg, close);
    return { bg, close };
  }

  function table(cols, rows, { foot, empty } = {}) {
    if (!rows || !rows.length) return `<div class="empty">${empty || t('no_data')}</div>`;
    const head = cols.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('');
    const body = rows.map((r) => '<tr>' + cols.map((c) => {
      const v = c.render ? c.render(r) : r[c.key];
      return `<td class="${c.num ? 'num' : ''}">${v == null ? '' : v}</td>`;
    }).join('') + '</tr>').join('');
    const footer = foot ? `<tfoot><tr>${foot.map((f) => `<td class="${f.num ? 'num' : ''}">${f.v == null ? '' : f.v}</td>`).join('')}</tr></tfoot>` : '';
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${footer}</table></div>`;
  }

  const badge = (text, cls) => `<span class="badge ${cls}">${esc(text)}</span>`;
  const statusBadge = (s) => {
    const map = { active: ['b-green'], expired: ['b-amber'], vacated: ['b-gray'], terminated: ['b-red'],
      open: ['b-red'], issued: ['b-blue'], partial: ['b-amber'], paid: ['b-green'], recognized: ['b-green'],
      waived: ['b-gray'], cancelled: ['b-gray'], unpaid: ['b-red'], occupied: ['b-red'], vacant: ['b-green'],
      pending: ['b-amber'], cleared: ['b-green'], bounced: ['b-red'] };
    const L = { active: 'نشط', expired: 'منتهي', vacated: 'خالي', terminated: 'مُنهى', open: 'مستحق', issued: 'صادرة',
      partial: 'جزئي', paid: 'مسدد', recognized: 'محقق', waived: 'ملغي', cancelled: 'ملغاة', unpaid: 'غير مدفوع',
      occupied: 'محجوز', vacant: 'متاح', pending: 'معلق', cleared: 'محصّل', bounced: 'مرتد' };
    const c = (map[s] || ['b-gray'])[0];
    return badge(L[s] || s, c);
  };

  function barChart(data, valueKey = 'total', labelKey = 'm') {
    if (!data || !data.length) return `<div class="empty">${t('no_data')}</div>`;
    const max = Math.max(...data.map((d) => Number(d[valueKey]) || 0), 1);
    return `<div class="bars">${data.map((d) => {
      const h = Math.round(((Number(d[valueKey]) || 0) / max) * 100);
      return `<div class="bar"><div class="vl">${int(Math.round(d[valueKey]))}</div>
        <div class="col" style="height:${h}%"></div><div class="lb">${esc(String(d[labelKey]).slice(2))}</div></div>`;
    }).join('')}</div>`;
  }

  // ---- Toolbar: search + template + export + import + new -------------------
  // cfg: {search:bool, type:'tenants', onNew, onImport, exportType, templateType}
  function toolbar(cfg) {
    const b = [];
    if (cfg.search !== false) b.push(`<input class="tb-search" placeholder="${t('search')}">`);
    b.push('<div class="spacer"></div>');
    if (cfg.templateType) b.push(`<button class="btn tb-template">⬇ ${t('template')}</button>`);
    if (cfg.exportType) b.push(`<button class="btn tb-export">📊 ${t('export')}</button>`);
    if (cfg.onImport) b.push(`<button class="btn tb-import">⬆ ${t('import')}</button>`);
    if (cfg.extra) b.push(cfg.extra);
    if (cfg.onNew) b.push(`<button class="btn primary tb-new">＋ ${cfg.newLabel || t('add')}</button>`);
    return `<div class="toolbar">${b.join('')}</div>`;
  }
  // wire toolbar buttons within container `c`
  function wireToolbar(c, cfg, drawFn, allRows) {
    const s = c.querySelector('.tb-search');
    if (s && cfg.searchFn) s.oninput = (e) => drawFn(cfg.searchFn(allRows, e.target.value.toLowerCase()));
    const tpl = c.querySelector('.tb-template');
    if (tpl) tpl.onclick = () => API.download('/template/' + cfg.templateType, cfg.templateType + '-template.xlsx').catch((e) => toast(e.message, 'err'));
    const exp = c.querySelector('.tb-export');
    if (exp) exp.onclick = () => API.download((cfg.exportReport ? '/export-report/' : '/export/') + cfg.exportType, cfg.exportType + '.xlsx').catch((e) => toast(e.message, 'err'));
    const imp = c.querySelector('.tb-import');
    if (imp) imp.onclick = cfg.onImport;
    const nw = c.querySelector('.tb-new');
    if (nw) nw.onclick = cfg.onNew;
  }

  // ---- Row action icons ----------------------------------------------------
  const A = { view: '👁', edit: '✏️', delete: '🗑', print: '🖨', email: '✉️', terminate: '⛔', pdf: '📄' };
  function actions(id, which = ['view', 'edit', 'delete']) {
    return `<span class="row-actions">` + which.map((a) =>
      `<button class="ico-btn" data-act="${a}" data-id="${id}" title="${t(a)}">${A[a]}</button>`).join('') + `</span>`;
  }

  // ---- Import modal (per screen) ------------------------------------------
  function importModal(type, extraFields, done, extraData) {
    modal({
      title: t('import'),
      bodyHTML: `<div class="field"><label>ملف Excel (.xlsx)</label><input type="file" id="imp-file" accept=".xlsx,.xls"></div>
        ${extraFields || ''}
        <p class="muted" style="font-size:12px">نزّل النموذج، املأه، ثم ارفعه هنا.</p>
        <div id="imp-res" style="margin-top:10px"></div>`,
      footerHTML: `<button class="btn" id="imp-tpl">⬇ ${t('template')}</button><button class="btn primary" id="imp-go">${t('import')}</button>`,
      onMount: (bg, close) => {
        bg.querySelector('#imp-tpl').onclick = () => API.download('/template/' + type, type + '.xlsx').catch((e) => toast(e.message, 'err'));
        bg.querySelector('#imp-go').onclick = async () => {
          const f = bg.querySelector('#imp-file').files[0];
          if (!f) return toast('اختر ملف', 'err');
          const fd = new FormData(); fd.append('file', f);
          if (bg.querySelector('#imp-backfill')?.checked) fd.append('backfill', 'true');
          if (extraData) for (const [k, v] of Object.entries(extraData)) fd.append(k, v);
          bg.querySelector('#imp-res').innerHTML = '<span class="muted">جاري…</span>';
          try {
            const r = await API.upload('/import/' + type, fd);
            bg.querySelector('#imp-res').innerHTML = `<span class="badge b-green">تم ${r.inserted}</span> <span class="badge b-gray">تخطي ${r.skipped}</span> ${r.errors && r.errors.length ? `<span class="badge b-red">أخطاء ${r.errors.length}</span>` : ''}`;
            toast(`تم استيراد ${r.inserted}`); if (done) done();
          } catch (e) { bg.querySelector('#imp-res').innerHTML = `<span class="badge b-red">${esc(e.message)}</span>`; }
        };
      },
    });
  }

  // ---- Generic add/edit form modal ----------------------------------------
  // fields: [{key,label,type,options,required,value,full,readonly}]
  function formModal({ title, fields, values = {}, onSave, wide }) {
    const inputHTML = (f) => {
      const v = values[f.key] ?? f.value ?? '';
      if (f.type === 'select')
        return `<select data-k="${f.key}" ${f.readonly ? 'disabled' : ''}>${(f.options || []).map((o) =>
          `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
      if (f.type === 'checkbox')
        return `<input type="checkbox" data-k="${f.key}" style="width:auto" ${v ? 'checked' : ''}>`;
      if (f.type === 'file')
        return `<input type="file" data-file="${f.key}" accept="${f.accept || '*'}">${v ? ` <span class="muted" style="font-size:11px">مرفق موجود ✓</span>` : ''}`;
      if (f.type === 'textarea') return `<textarea data-k="${f.key}" rows="2">${esc(v)}</textarea>`;
      return `<input data-k="${f.key}" type="${f.type || 'text'}" ${f.step ? `step="${f.step}"` : ''} value="${esc(v)}" ${f.readonly ? 'readonly' : ''}>`;
    };
    modal({
      title, wide,
      bodyHTML: `<div class="form-grid">${fields.map((f) =>
        `<div class="field ${f.full ? 'full' : ''}"><label>${esc(f.label)}${f.required ? ' *' : ''}</label>${inputHTML(f)}</div>`).join('')}</div>`,
      footerHTML: `<button class="btn primary" id="fm-save">${t('save')}</button><button class="btn" id="fm-cancel">${t('cancel')}</button>`,
      onMount: (bg, close) => {
        bg.querySelector('#fm-cancel').onclick = close;
        bg.querySelector('#fm-save').onclick = async () => {
          const out = {};
          bg.querySelectorAll('[data-k]').forEach((inp) => {
            out[inp.dataset.k] = inp.type === 'checkbox' ? (inp.checked ? 1 : 0) : (inp.type === 'number' ? (inp.value === '' ? null : +inp.value) : inp.value);
          });
          // read file inputs -> base64
          for (const inp of bg.querySelectorAll('[data-file]')) {
            const f = inp.files && inp.files[0];
            if (f) out[inp.dataset.file] = await new Promise((rs) => { const r = new FileReader(); r.onload = () => rs(r.result); r.readAsDataURL(f); });
            else out[inp.dataset.file] = values[inp.dataset.file] || null;
          }
          for (const f of fields) if (f.required && (out[f.key] === '' || out[f.key] == null)) return toast(`${f.label} مطلوب`, 'err');
          try { await onSave(out, close); } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  // ---- Clean print (opens new window with only the content) ---------------
  function printReport(title, contentHTML) {
    const w = window.open('', '_blank', 'width=900,height=700');
    const dir = I18N.dir();
    w.document.write(`<!doctype html><html dir="${dir}" lang="${I18N.getLang()}"><head><meta charset="utf-8"><title>${esc(title)}</title>
      <style>
        *{box-sizing:border-box} body{font-family:"Segoe UI",Tahoma,sans-serif;color:#1f2a44;margin:0;padding:28px}
        .ph{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #1f6feb;padding-bottom:12px;margin-bottom:18px}
        .ph h1{font-size:20px;margin:0} .ph .co{font-size:15px;font-weight:700;color:#1f6feb}
        .ph .dt{font-size:12px;color:#6b7a90}
        table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:8px}
        th,td{padding:7px 10px;border-bottom:1px solid #e3e9f2;text-align:${dir === 'rtl' ? 'right' : 'left'}}
        th{background:#f4f7fb;color:#41506b;font-weight:600}
        td.num,th.num{text-align:${dir === 'rtl' ? 'left' : 'right'};font-variant-numeric:tabular-nums}
        tfoot td{font-weight:700;border-top:2px solid #c9d6ea;background:#f7f9fc}
        .krow{display:flex;gap:22px;margin:10px 0}
        h3{margin:16px 0 6px;font-size:14px}
        @media print{body{padding:6mm}}
      </style></head><body>
      <div class="ph"><div><div class="co">${esc(t('app_name'))}</div><div class="dt">GHALA 299/1</div></div>
        <div style="text-align:${dir === 'rtl' ? 'left' : 'right'}"><h1>${esc(title)}</h1><div class="dt">${new Date().toLocaleDateString('en-GB')}</div></div></div>
      ${contentHTML}
      <script>window.onload=function(){setTimeout(function(){window.print()},250)}<\/script>
      </body></html>`);
    w.document.close();
  }

  return { el, esc, fmt, money, int, dateStr, today, curMonth, toast, modal, table, badge, statusBadge,
    barChart, toolbar, wireToolbar, actions, importModal, formModal, printReport };
})();
