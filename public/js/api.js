// Tiny API client with JWT storage
const API = (() => {
  let token = localStorage.getItem('ut_token') || null;
  let user = JSON.parse(localStorage.getItem('ut_user') || 'null');

  async function req(method, path, body, isForm) {
    const opts = { method, headers: {} };
    opts.headers['X-Lang'] = localStorage.getItem('ut_lang') || 'ar';
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    if (body && !isForm) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    if (isForm) opts.body = body;
    const res = await fetch('/api' + path, opts);
    if (res.status === 401) { logout(); location.hash = '#/login'; throw new Error('انتهت الجلسة، الرجاء تسجيل الدخول'); }
    const txt = await res.text();
    let data; try { data = txt ? JSON.parse(txt) : {}; } catch { data = { raw: txt }; }
    if (!res.ok) throw new Error(data.error || ('خطأ ' + res.status));
    return data;
  }
  function setSession(t, u) { token = t; user = u; localStorage.setItem('ut_token', t); localStorage.setItem('ut_user', JSON.stringify(u)); }
  function logout() { token = null; user = null; localStorage.removeItem('ut_token'); localStorage.removeItem('ut_user'); }

  return {
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b),
    put: (p, b) => req('PUT', p, b),
    del: (p) => req('DELETE', p),
    upload: (p, formData) => req('POST', p, formData, true),
    download: async (p, filename) => {
      const res = await fetch('/api' + p, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
      if (!res.ok) throw new Error('تعذّر التنزيل');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename || 'export.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    login: async (u, pw) => { const r = await req('POST', '/login', { username: u, password: pw }); setSession(r.token, r.user); return r.user; },
    logout,
    user: () => user,
    isAuthed: () => !!token,
  };
})();
