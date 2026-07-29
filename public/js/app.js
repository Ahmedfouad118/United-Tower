// Router + collapsible nav + language switcher + boot
(() => {
  const { esc, toast } = UI;
  // global building filter + permission state (shared across screens)
  window.UT = window.UT || { building: localStorage.getItem('ut_building') || '', buildings: [] };
  window.UT.bq = (first) => UT.building ? (first ? '?' : '&') + 'building_id=' + UT.building : '';
  UT.perms = UT.perms || null;   // null until /me loads
  UT.role = (API.user() || {}).role;
  UT.mod = null;                 // module of the current screen (set on route)
  // permission check: admin bypasses; if the user has NO permission rows at all
  // we fall back to role (so users configured before permissions still work).
  UT.can = (mod, action) => {
    if (UT.role === 'admin') return true;
    if (!UT.perms || !UT.perms.length) return UT.role === 'accountant' || action === 'view';
    const p = UT.perms.find((x) => x.module === mod);
    return !!(p && p['can_' + action]);
  };

  // Navigation: groups with collapsible sub-items. page = Pages fn name.
  const NAV = [
    { single: true, path: 'dashboard', icon: '📊', label: 'm_dashboard', page: 'dashboard', mod: 'dashboard' },
    { id: 'properties', icon: '🏢', label: 'm_properties', items: [
      { path: 'buildings', label: 'm_buildings', page: 'buildings', mod: 'properties' },
      { path: 'units', label: 'm_units', page: 'units', mod: 'properties' },
      { path: 'calendar', label: 'm_calendar', page: 'occupancy', mod: 'properties' },
    ] },
    { id: 'receivable', icon: '👥', label: 'm_receivable', items: [
      { path: 'customers', label: 'm_customers', page: 'customers', mod: 'customers' },
      { path: 'contracts', label: 'm_contracts', page: 'contracts', mod: 'customers' },
      { path: 'invoices', label: 'm_invoices', page: 'invoices', mod: 'customers' },
      { path: 'receipts', label: 'm_receipts', page: 'receipts', mod: 'customers' },
      { path: 'cust_summary', label: 'm_cust_summary', page: 'customersSummary', mod: 'customers' },
      { path: 'statement', label: 'm_statement', page: 'statement', mod: 'customers' },
      { path: 'ar_aging', label: 'm_ar_aging', page: 'arAging', mod: 'customers' },
    ] },
    { id: 'payable', icon: '🚚', label: 'm_payable', items: [
      { path: 'vendors', label: 'm_vendors', page: 'vendors', mod: 'vendors' },
      { path: 'bills', label: 'm_bills', page: 'vendorBills', mod: 'vendors' },
      { path: 'vpayments', label: 'm_vpayments', page: 'vendorPayments', mod: 'vendors' },
      { path: 'ap_aging', label: 'm_ap_aging', page: 'apAging', mod: 'vendors' },
    ] },
    { id: 'finance', icon: '🏦', label: 'm_finance', items: [
      { path: 'coa', label: 'm_coa', page: 'coa', mod: 'finance' },
      { path: 'journals', label: 'm_journals', page: 'journals', mod: 'finance' },
      { path: 'tb', label: 'm_tb', page: 'trialBalance', mod: 'finance' },
      { path: 'is', label: 'm_is', page: 'incomeStatement', mod: 'finance' },
      { path: 'bs', label: 'm_bs', page: 'balanceSheet', mod: 'finance' },
      { path: 'cashflow', label: 'm_cashflow', page: 'cashflow', mod: 'finance' },
      { path: 'ppl', label: 'm_ppl', page: 'propertyPL', mod: 'finance' },
      { path: 'roi', label: 'm_roi', page: 'roi', mod: 'finance' },
      { path: 'comparison', label: 'm_comparison', page: 'comparison', mod: 'finance' },
    ] },
    { id: 'treasury', icon: '💵', label: 'm_treasury', items: [
      { path: 'banks', label: 'm_banks', page: 'banks', mod: 'treasury' },
      { path: 'cheques', label: 'm_cheques', page: 'cheques', mod: 'treasury' },
      { path: 'reconciliation', label: 'm_recon', page: 'reconciliation', mod: 'treasury' },
    ] },
    { id: 'assets', icon: '🏗️', label: 'm_assets_mod', items: [
      { path: 'assets', label: 'm_assets', page: 'assets', mod: 'assets' },
      { path: 'depreciation', label: 'm_depreciation', page: 'depreciation', mod: 'assets' },
    ] },
    { id: 'tax', icon: '🧾', label: 'm_tax', items: [
      { path: 'vat', label: 'm_vat', page: 'vat', mod: 'tax' },
    ] },
    { id: 'hr', icon: '🧑‍💼', label: 'm_hr', items: [
      { path: 'employees', label: 'm_employees', page: 'employees', mod: 'hr' },
    ] },
    { id: 'admin', icon: '⚙️', label: 'm_admin', items: [
      { path: 'company', label: 'm_company', page: 'company', mod: 'settings' },
      { path: 'categories', label: 'm_categories', page: 'categories', mod: 'settings' },
      { path: 'paymethods', label: 'm_paymethods', page: 'paymethods', mod: 'settings' },
      { path: 'users', label: 'm_users', page: 'users', admin: true, mod: 'users' },
    ] },
  ];
  const allItems = () => NAV.flatMap((g) => g.single ? [g] : g.items.map((it) => ({ ...it, group: g.id })));
  const findItem = (path) => allItems().find((it) => it.path === path);

  function parseHash() {
    const h = (location.hash || '#/dashboard').replace(/^#\//, '');
    const [path, qs] = h.split('?');
    return { path: path || 'dashboard', params: Object.fromEntries(new URLSearchParams(qs || '')) };
  }

  function langSwitch() {
    return `<div class="lang-switch">${I18N.langs.map(([l, lbl]) =>
      `<button data-lang="${l}" class="${I18N.getLang() === l ? 'active' : ''}">${lbl}</button>`).join('')}</div>`;
  }

  function loginView() {
    document.getElementById('app').innerHTML = `
      <div class="login-wrap"><form class="login-card" id="lf">
        <div class="logo">UT</div><h2>${esc(t('app_name'))}</h2><p>${esc(t('app_sub'))}</p>
        <div class="field"><label>${t('username')}</label><input id="u" value="admin"></div>
        <div class="field"><label>${t('password')}</label><input id="p" type="password"></div>
        <button class="btn primary" style="width:100%;justify-content:center;margin-top:8px">${t('login')}</button>
        <p class="muted" style="margin-top:14px;font-size:11.5px">admin / admin123</p>
        <div style="text-align:center;margin-top:10px">${langSwitch()}</div>
      </form></div>`;
    document.getElementById('lf').onsubmit = async (e) => {
      e.preventDefault();
      try { await API.login(document.getElementById('u').value, document.getElementById('p').value); location.hash = '#/dashboard'; layout(); route(); }
      catch (err) { toast(err.message, 'err'); }
    };
    wireLang();
  }

  function navHTML() {
    const isAdmin = (API.user() || {}).role === 'admin';
    return NAV.map((g) => {
      if (g.single) return (isAdmin || UT.can(g.path, 'view')) ? `<a href="#/${g.path}" data-path="${g.path}" class="nav-link"><span class="ic">${g.icon}</span>${esc(t(g.label))}</a>` : '';
      const items = g.items.filter((it) => (!it.admin || isAdmin) && (isAdmin || UT.can(it.path, 'view')));
      if (!items.length) return '';
      return `<div class="nav-group" data-group="${g.id}">
        <button class="nav-head"><span class="ic">${g.icon}</span><span class="lbl">${esc(t(g.label))}</span><span class="chev">▾</span></button>
        <div class="nav-sub">${items.map((it) => `<a href="#/${it.path}" data-path="${it.path}" class="nav-link">${esc(t(it.label))}</a>`).join('')}</div>
      </div>`;
    }).join('');
  }

  function layout() {
    const u = API.user() || {};
    document.getElementById('app').innerHTML = `
      <div class="layout">
        <aside class="sidebar">
          <div class="brand"><div class="logo">UT</div><div><h1>${esc(t('app_name'))}</h1><span>GHALA 299/1</span></div></div>
          <nav class="nav">${navHTML()}</nav>
        </aside>
        <div class="main">
          <div class="topbar"><div class="page-title" id="ptitle"></div>
            <div class="user"><select id="bldFilter" class="bld-filter" title="البناية"></select>${langSwitch()}
              <div style="text-align:start"><div style="font-weight:600">${esc(u.full_name || '')}</div>
                <div class="muted" style="font-size:11px">${esc(t(u.role) || '')}</div></div>
              <div class="avatar">${esc((u.full_name || 'U').slice(0, 1))}</div>
              <button class="btn sm" id="logout">${t('logout')}</button></div>
          </div>
          <div class="content" id="view"></div>
        </div>
      </div>`;
    document.getElementById('logout').onclick = () => { API.logout(); if (typeof AIWidget !== 'undefined') AIWidget.unmount(); location.hash = '#/login'; loginView(); };
    // collapsible groups
    document.querySelectorAll('.nav-head').forEach((h) => h.onclick = () => h.parentElement.classList.toggle('open'));
    wireLang();
    loadBuildingFilter();
    if (typeof AIWidget !== 'undefined') AIWidget.mount();
  }

  async function loadBuildingFilter() {
    const sel = document.getElementById('bldFilter'); if (!sel) return;
    try {
      const me = await API.get('/me'); UT.buildings = me.buildings || []; UT.perms = me.permissions || []; UT.role = me.role;
      // re-render nav now that permissions are known (non-admin may see fewer modules)
      const nav = document.querySelector('.nav');
      if (nav && UT.role !== 'admin') {
        nav.innerHTML = navHTML();
        nav.querySelectorAll('.nav-head').forEach((h) => h.onclick = () => h.parentElement.classList.toggle('open'));
        route();
      }
    } catch { UT.buildings = []; }
    const lang = I18N.getLang();
    sel.innerHTML = `<option value="">${lang === 'en' ? 'All Buildings' : lang === 'ur' ? 'تمام عمارتیں' : 'كل البنايات'}</option>` +
      UT.buildings.map((b) => `<option value="${b.id}" ${String(UT.building) === String(b.id) ? 'selected' : ''}>${esc(lang === 'ar' ? (b.name_ar || b.name) : b.name)}</option>`).join('');
    sel.onchange = () => { UT.building = sel.value; localStorage.setItem('ut_building', sel.value); route(); };
  }

  function wireLang() {
    document.querySelectorAll('[data-lang]').forEach((b) => b.onclick = () => {
      I18N.setLang(b.dataset.lang);
      if (API.isAuthed()) { layout(); route(); } else loginView();
    });
  }

  async function route() {
    if (!API.isAuthed()) { loginView(); return; }
    if (!document.querySelector('.layout')) layout();
    const { path, params } = parseHash();
    if (path === 'login') { location.hash = '#/dashboard'; return; }
    const item = findItem(path);
    UT.mod = item ? item.path : null;
    // block direct access (typed hash) to a screen the user can't view
    if (item && UT.role !== 'admin' && UT.perms && !UT.can(item.path, 'view')) {
      document.getElementById('ptitle').textContent = '';
      document.getElementById('view').innerHTML = '<div class="empty">لا تملك صلاحية فتح هذه الشاشة</div>';
      return;
    }
    document.getElementById('ptitle').textContent = item ? t(item.label) : '';
    document.querySelectorAll('.nav-link').forEach((a) => a.classList.toggle('active', a.getAttribute('data-path') === path));
    // expand active group
    document.querySelectorAll('.nav-group').forEach((g) => g.classList.remove('open'));
    if (item && item.group) { const g = document.querySelector(`.nav-group[data-group="${item.group}"]`); if (g) g.classList.add('open'); }
    const view = document.getElementById('view');
    const fn = item && Pages[item.page];
    if (!fn) { view.innerHTML = '<div class="empty">الصفحة غير موجودة</div>'; return; }
    try { await fn(view, params); UI.makeSortable(view); } catch (e) { view.innerHTML = `<div class="empty">خطأ: ${esc(e.message)}</div>`; console.error(e); }
  }

  window.addEventListener('hashchange', route);
  route();
})();
