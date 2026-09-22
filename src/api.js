const express = require('express');
const { db, DB_PATH } = require('./db');
const { login, completeTwoFactorLogin, authMiddleware, requireRole, hash, startTwoFactorSetup, enableTwoFactor, disableTwoFactor } = require('./auth');
const svc = require('./services');
const R = require('./reports');
const BUD = require('./budget');
const PRES = require('./presentation');
const { postJournal, r2 } = require('./ledger');

const router = express.Router();
const writers = requireRole('admin', 'accountant');

// ---- Activity log (audit trail of write actions) --------------------------
try { db.exec(`CREATE TABLE IF NOT EXISTS activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, user_id INTEGER, username TEXT, role TEXT, method TEXT, path TEXT, status INTEGER, summary TEXT)`); } catch (e) {}
// company documents (licences, CR, contracts, certificates...) with attachments
try { db.exec(`CREATE TABLE IF NOT EXISTS company_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, doc_type TEXT, doc_no TEXT, issue_date TEXT, expiry_date TEXT, attachment TEXT, notes TEXT, created_by INTEGER, created_at TEXT DEFAULT (datetime('now')))`); } catch (e) {}

// Download a full backup of the live database (admin only). Auth header only
// — the frontend always fetches this as a blob and never as a plain link, so
// there's no reason to also accept the token via ?token=, which would risk it
// being captured in server/proxy access logs or browser history.
router.get('/backup', (req, res) => {
  const jwt = require('jsonwebtoken'); const { SECRET } = require('./auth');
  const tok = (req.headers.authorization || '').replace('Bearer ', '');
  let user; try { user = jwt.verify(tok, SECRET); } catch { return res.status(401).json({ error: 'unauthorized' }); }
  if (user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try {
    const fs = require('fs');
    // checkpoint WAL into the main file so the copy is complete
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="united-tower-backup-${stamp}.db"`);
    fs.createReadStream(DB_PATH).pipe(res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const lang = (req) => req.headers['x-lang'] || req.query.lang || (req.user && req.user.lang) || 'en';

// ---- Building-level access control ---------------------------------------
// Admin => null (sees every building). Others => the ids granted in user_buildings.
function allowedBuildingIds(req) {
  if (!req.user || req.user.role === 'admin') return null;
  return db.prepare('SELECT building_id FROM user_buildings WHERE user_id=?').all(req.user.id).map((r) => r.building_id);
}
// SQL fragment that restricts `col` to the buildings this user may see.
function bScope(req, col = 'building_id') {
  const ids = allowedBuildingIds(req);
  if (ids === null) return '';
  if (!ids.length) return ' AND 1=0';           // no building granted -> sees nothing
  return ` AND ${col} IN (${ids.map(Number).join(',')})`;
}
// Effective building filter for reports: honours ?building_id but never lets a
// user read a building they weren't granted.
function effBuilding(req) {
  const asked = req.query.building_id ? Number(req.query.building_id) : null;
  const ids = allowedBuildingIds(req);
  if (ids === null) return asked;                // admin
  if (!ids.length) return -1;                    // nothing granted -> impossible id
  if (asked && !ids.includes(asked)) return -1;  // asked for a forbidden building
  return asked || (ids.length === 1 ? ids[0] : null);
}
function scopeRows(req, rows) {
  const ids = allowedBuildingIds(req);
  if (ids === null) return rows;
  return rows.filter((r) => r.building_id == null || ids.includes(r.building_id));
}

// ---- Auth -----------------------------------------------------------------
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const r = login(username, password);
  if (!r) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  if (r.locked) return res.status(429).json({ error: 'محاولات كتير غلط — الحساب مقفول مؤقتًا، حاول بعد شوية' });
  res.json(r);
});
router.post('/login/2fa', (req, res) => {
  const { pending_token, code } = req.body || {};
  const r = completeTwoFactorLogin(pending_token, code);
  if (!r) return res.status(401).json({ error: 'الكود غير صحيح أو الجلسة انتهت' });
  res.json(r);
});

// ---- Public presentation share link (no auth) — a viewer with the link can
// see this ONE presentation snapshot and leave a rating, nothing else.
router.get('/public/presentation/:token', (req, res) => {
  const share = PRES.getShare(req.params.token);
  if (!share) return res.status(404).json({ error: 'الرابط غير صحيح أو منتهي' });
  try { res.json(PRES.getPresentationData(share.from_date, share.to_date, share.building_id, share.version)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/public/presentation/:token/feedback', (req, res) => {
  try { res.json(PRES.saveFeedback(req.params.token, req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.use(authMiddleware);
// log every write action (POST/PUT/DELETE) with the user + outcome
router.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    res.on('finish', () => {
      try {
        const u = req.user || {};
        const keys = (req.body && typeof req.body === 'object') ? Object.keys(req.body).filter((k) => !/pass|pw|token/i.test(k)).slice(0, 8).join(', ') : '';
        db.prepare('INSERT INTO activity_log (ts,user_id,username,role,method,path,status,summary) VALUES (?,?,?,?,?,?,?,?)')
          .run(new Date().toISOString(), u.id || null, u.full_name || u.username || '', u.role || '', req.method, req.path, res.statusCode, keys);
      } catch (e) {}
    });
  }
  next();
});
router.get('/activity-log', requireRole('admin'), (req, res) => {
  const q = req.query.q ? '%' + req.query.q + '%' : null;
  const rows = q
    ? db.prepare('SELECT * FROM activity_log WHERE username LIKE ? OR path LIKE ? OR summary LIKE ? ORDER BY id DESC LIMIT 500').all(q, q, q)
    : db.prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT 500').all();
  res.json(rows);
});
router.get('/me', (req, res) => {
  const buildings = req.user.role === 'admin'
    ? db.prepare('SELECT id,name,name_ar FROM buildings WHERE active=1 ORDER BY name').all()
    : db.prepare('SELECT b.id,b.name,b.name_ar FROM user_buildings ub JOIN buildings b ON b.id=ub.building_id WHERE ub.user_id=? ORDER BY b.name').all(req.user.id);
  const permissions = db.prepare('SELECT module,can_view,can_add,can_edit,can_delete FROM user_permissions WHERE user_id=?').all(req.user.id);
  const totp_enabled = !!(db.prepare('SELECT totp_enabled FROM users WHERE id=?').get(req.user.id) || {}).totp_enabled;
  res.json({ ...req.user, buildings, all_buildings: req.user.role === 'admin', permissions, totp_enabled });
});

// ---- Two-factor auth self-service (any logged-in user, for their OWN account)
router.post('/2fa/setup', (req, res) => {
  try { res.json(startTwoFactorSetup(req.user.id, ((db.prepare("SELECT value FROM settings WHERE key='company_name'").get() || {}).value) || 'United Tower')); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/2fa/enable', (req, res) => {
  try { res.json(enableTwoFactor(req.user.id, req.body && req.body.code)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/2fa/disable', (req, res) => {
  try { res.json(disableTwoFactor(req.user.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Secret-bearing settings keys — every logged-in user (any role) can read
// /settings for branding (company name/logo), so keys like the AI provider's
// API key must never ride along in that response for non-admins.
const SECRET_SETTINGS_KEYS = ['ai_api_key'];
router.get('/settings', (req, res) => {
  const all = Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((s) => [s.key, s.value]));
  if (req.user.role !== 'admin') {
    for (const k of SECRET_SETTINGS_KEYS) if (all[k]) all[k] = '••••••••';
  }
  res.json(all);
});
router.put('/settings', requireRole('admin'), (req, res) => {
  const set = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
  for (const [k, v] of Object.entries(req.body || {})) set.run(k, v == null ? '' : String(v));
  res.json({ ok: true });
});

// ---- Configuration: GL-account mapping + module-name (label) overrides -----
const CFG = require('./config');
router.get('/config', (req, res) => res.json({ accounts: CFG.allAccts(), labels: CFG.labels() }));
router.put('/config/accounts', requireRole('admin'), (req, res) => { CFG.setAccts(req.body || {}); res.json({ ok: true }); });
router.put('/config/labels', requireRole('admin'), (req, res) => { CFG.setLabels(req.body || {}); res.json({ ok: true }); });
// One-time: repurpose 20000 as the single VAT provision (moves legacy AP to 23000,
// reclasses existing 23200/11600 VAT lines into 20000 in place). Idempotent.
router.post('/admin/vat-provision-migrate', requireRole('admin'), (req, res) => {
  try { res.json(svc.migrateVatTo20000(req.user.id)); } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Users & permissions --------------------------------------------------
router.get('/users', requireRole('admin'), (req, res) =>
  res.json(db.prepare('SELECT id,username,full_name,role,lang,active,totp_enabled,created_at FROM users ORDER BY id').all()));
router.post('/users', requireRole('admin'), (req, res) => {
  const { username, full_name, password, role } = req.body;
  try {
    const r = db.prepare('INSERT INTO users (username,full_name,password_hash,role) VALUES (?,?,?,?)')
      .run(username, full_name, hash(password || 'changeme'), role || 'viewer');
    res.json({ id: Number(r.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/users/:id', requireRole('admin'), (req, res) => {
  const { full_name, role, active, password } = req.body;
  db.prepare('UPDATE users SET full_name=COALESCE(?,full_name),role=COALESCE(?,role),active=COALESCE(?,active) WHERE id=?')
    .run(full_name ?? null, role ?? null, active ?? null, req.params.id);
  if (password) db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash(password), req.params.id);
  res.json({ ok: true });
});
router.get('/users/:id/permissions', requireRole('admin'), (req, res) =>
  res.json(db.prepare('SELECT * FROM user_permissions WHERE user_id=?').all(req.params.id)));
router.get('/users/:id/buildings', requireRole('admin'), (req, res) =>
  res.json(db.prepare('SELECT building_id FROM user_buildings WHERE user_id=?').all(req.params.id).map((r) => r.building_id)));
router.put('/users/:id/buildings', requireRole('admin'), (req, res) => {
  const ids = req.body.building_ids || [];
  db.prepare('DELETE FROM user_buildings WHERE user_id=?').run(req.params.id);
  const ins = db.prepare('INSERT OR IGNORE INTO user_buildings (user_id,building_id) VALUES (?,?)');
  for (const b of ids) ins.run(req.params.id, b);
  res.json({ ok: true });
});
router.put('/users/:id/permissions', requireRole('admin'), (req, res) => {
  const perms = req.body.permissions || [];
  db.prepare('DELETE FROM user_permissions WHERE user_id=?').run(req.params.id);
  const ins = db.prepare('INSERT INTO user_permissions (user_id,module,can_view,can_add,can_edit,can_delete) VALUES (?,?,?,?,?,?)');
  for (const p of perms) ins.run(req.params.id, p.module, p.can_view ? 1 : 0, p.can_add ? 1 : 0, p.can_edit ? 1 : 0, p.can_delete ? 1 : 0);
  res.json({ ok: true });
});
// Recovery path: if a user loses their authenticator device, only an admin
// can reset it (they must re-enroll and confirm a new code afterward).
router.post('/users/:id/2fa/disable', requireRole('admin'), (req, res) => {
  try { res.json(disableTwoFactor(Number(req.params.id))); } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Chart of accounts (full CRUD for admin) ------------------------------
// Balance is shown in each account's own natural sense (a credit-normal
// account like a liability or income reads positive when it has a credit
// balance) — all-time, not scoped to a period, matching "الرصيد" elsewhere.
router.get('/accounts', (req, res) => {
  const rows = db.prepare('SELECT * FROM accounts ORDER BY code').all();
  const bal = db.prepare('SELECT account_code, COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM journal_lines GROUP BY account_code').all();
  const balMap = {}; for (const b of bal) balMap[b.account_code] = b;
  res.json(rows.map((a) => {
    const b = balMap[a.code] || { d: 0, c: 0 };
    const net = r2(b.d - b.c);
    return { ...a, balance: a.normal_balance === 'C' ? r2(-net) : net };
  }));
});
router.post('/accounts', requireRole('admin'), (req, res) => {
  const { code, name, name_ar, name_ur, type, normal_balance, parent_code, is_group } = req.body;
  try {
    db.prepare('INSERT INTO accounts (code,name,name_ar,name_ur,type,normal_balance,parent_code,is_group) VALUES (?,?,?,?,?,?,?,?)')
      .run(code, name, name_ar || null, name_ur || null, type, normal_balance, parent_code || null, is_group ? 1 : 0);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/accounts/:code', requireRole('admin'), (req, res) => {
  const { name, name_ar, name_ur, type, normal_balance, is_active } = req.body;
  db.prepare('UPDATE accounts SET name=COALESCE(?,name),name_ar=COALESCE(?,name_ar),name_ur=COALESCE(?,name_ur),type=COALESCE(?,type),normal_balance=COALESCE(?,normal_balance),is_active=COALESCE(?,is_active) WHERE code=?')
    .run(name ?? null, name_ar ?? null, name_ur ?? null, type ?? null, normal_balance ?? null, is_active ?? null, req.params.code);
  res.json({ ok: true });
});
router.delete('/accounts/:code', requireRole('admin'), (req, res) => {
  const used = db.prepare('SELECT COUNT(*) c FROM journal_lines WHERE account_code=?').get(req.params.code).c;
  if (used) return res.status(400).json({ error: 'الحساب مستخدم في قيود ولا يمكن حذفه' });
  db.prepare('DELETE FROM accounts WHERE code=?').run(req.params.code);
  res.json({ ok: true });
});

// ---- Generic master CRUD helper ------------------------------------------
function crud(path, table, fields, opts = {}) {
  router.get('/' + path, (req, res) => res.json(db.prepare(`SELECT * FROM ${table} ${opts.order || 'ORDER BY id DESC'}`).all()));
  router.post('/' + path, writers, (req, res) => {
    const cols = fields.filter((f) => req.body[f] !== undefined);
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    try { res.json({ id: Number(db.prepare(sql).run(...cols.map((c) => req.body[c])).lastInsertRowid) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.put('/' + path + '/:id', writers, (req, res) => {
    const cols = fields.filter((f) => req.body[f] !== undefined);
    if (!cols.length) return res.json({ ok: true });
    db.prepare(`UPDATE ${table} SET ${cols.map((c) => c + '=?').join(',')} WHERE id=?`).run(...cols.map((c) => req.body[c]), req.params.id);
    res.json({ ok: true });
  });
  router.delete('/' + path + '/:id', writers, (req, res) => {
    try { db.prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
}
// scoped list routes must be registered BEFORE the generic crud() ones
router.get('/buildings', (req, res) => res.json(db.prepare(`SELECT * FROM buildings WHERE 1=1${bScope(req, 'id')} ORDER BY name`).all()));
router.get('/flats', (req, res) => res.json(db.prepare(`SELECT * FROM flats WHERE 1=1${bScope(req, 'building_id')} ORDER BY code`).all()));
crud('buildings', 'buildings', ['code', 'name', 'name_ar', 'name_ur', 'address', 'owner', 'purchase_value', 'notes', 'active'], { order: 'ORDER BY name' });
// Merge legacy duplicate units (same code ignoring case/spaces) into one, moving
// every contract / invoice / receipt / bill / journal line to the kept unit so
// NO transaction is lost — only the empty duplicate unit rows are removed.
router.post('/flats/merge-duplicates', requireRole('admin'), (req, res) => {
  const norm = (s) => String(s == null ? '' : s).toUpperCase().replace(/\s+/g, '');
  const flats = db.prepare('SELECT id,code,building_id FROM flats').all();
  const groups = {};
  for (const f of flats) { (groups[norm(f.code)] = groups[norm(f.code)] || []).push(f); }
  const refs = [['contracts', 'flat_id'], ['invoices', 'flat_id'], ['payments', 'flat_id'], ['vendor_bills', 'flat_id'], ['journal_lines', 'flat_id']];
  let groups_merged = 0, units_removed = 0;
  for (const grp of Object.values(groups)) {
    if (grp.length < 2) continue;
    grp.sort((a, b) => (b.building_id ? 1 : 0) - (a.building_id ? 1 : 0) || a.id - b.id);
    const keeper = grp[0];
    for (const extra of grp.slice(1)) {
      for (const [tbl, col] of refs) { try { db.prepare(`UPDATE ${tbl} SET ${col}=? WHERE ${col}=?`).run(keeper.id, extra.id); } catch {} }
      try { db.prepare('DELETE FROM flats WHERE id=?').run(extra.id); units_removed++; } catch {}
    }
    groups_merged++;
  }
  res.json({ groups_merged, units_removed });
});
// flats create/update with code normalization (trim + single spaces) so new
// units never duplicate an existing one because of stray spacing/case.
const normFlatCode = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
router.post('/flats', writers, (req, res) => {
  const b = req.body || {}; if (b.code) b.code = normFlatCode(b.code);
  const fields = ['code', 'building_id', 'unit_type', 'floor', 'bedrooms', 'base_rent', 'category_id', 'notes'].filter((f) => b[f] !== undefined);
  try { res.json({ id: Number(db.prepare(`INSERT INTO flats (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`).run(...fields.map((f) => b[f])).lastInsertRowid) }); }
  catch (e) { res.status(400).json({ error: /UNIQUE/.test(e.message) ? 'رقم الوحدة موجود بالفعل' : e.message }); }
});
router.put('/flats/:id', writers, (req, res) => {
  const b = req.body || {}; if (b.code) b.code = normFlatCode(b.code);
  const fields = ['code', 'building_id', 'unit_type', 'floor', 'bedrooms', 'base_rent', 'category_id', 'notes'].filter((f) => b[f] !== undefined);
  if (!fields.length) return res.json({ ok: true });
  try { db.prepare(`UPDATE flats SET ${fields.map((c) => c + '=?').join(',')} WHERE id=?`).run(...fields.map((f) => b[f]), req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: /UNIQUE/.test(e.message) ? 'رقم الوحدة موجود بالفعل' : e.message }); }
});
crud('flats', 'flats', ['code', 'building_id', 'unit_type', 'floor', 'bedrooms', 'base_rent', 'category_id', 'notes'], { order: 'ORDER BY code' });
// tenant create/update also posts a tenant-tagged opening-balance journal
router.post('/tenants', writers, (req, res) => {
  const f = ['code', 'name', 'name_ar', 'phone', 'email', 'civil_id', 'category_id', 'opening_balance', 'notes'].filter((k) => req.body[k] !== undefined);
  try {
    const r = db.prepare(`INSERT INTO tenants (${f.join(',')}) VALUES (${f.map(() => '?').join(',')})`).run(...f.map((k) => req.body[k]));
    const id = Number(r.lastInsertRowid);
    if (req.body.opening_balance) svc.setTenantOpening(id, req.body.opening_balance, req.user.id);
    res.json({ id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/tenants/:id', writers, (req, res) => {
  const f = ['code', 'name', 'name_ar', 'phone', 'email', 'civil_id', 'category_id', 'opening_balance', 'notes'].filter((k) => req.body[k] !== undefined);
  try {
    if (f.length) db.prepare(`UPDATE tenants SET ${f.map((c) => c + '=?').join(',')} WHERE id=?`).run(...f.map((k) => req.body[k]), req.params.id);
    if (req.body.opening_balance !== undefined) svc.setTenantOpening(Number(req.params.id), req.body.opening_balance, req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/tenants/:id', writers, (req, res) => { try { db.prepare('DELETE FROM tenants WHERE id=?').run(req.params.id); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });
router.get('/tenants', (req, res) => res.json(db.prepare('SELECT * FROM tenants ORDER BY name').all()));
// vendor create/update also posts a vendor-tagged opening-balance journal
router.post('/vendors', writers, (req, res) => {
  const f = ['code', 'name', 'name_ar', 'phone', 'email', 'tax_no', 'category_id', 'opening_balance', 'notes'].filter((k) => req.body[k] !== undefined);
  try {
    const r = db.prepare(`INSERT INTO vendors (${f.join(',')}) VALUES (${f.map(() => '?').join(',')})`).run(...f.map((k) => req.body[k]));
    const id = Number(r.lastInsertRowid);
    if (req.body.opening_balance) svc.setVendorOpening(id, req.body.opening_balance, req.user.id);
    res.json({ id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/vendors/:id', writers, (req, res) => {
  const f = ['code', 'name', 'name_ar', 'phone', 'email', 'tax_no', 'category_id', 'opening_balance', 'notes'].filter((k) => req.body[k] !== undefined);
  try {
    if (f.length) db.prepare(`UPDATE vendors SET ${f.map((c) => c + '=?').join(',')} WHERE id=?`).run(...f.map((k) => req.body[k]), req.params.id);
    if (req.body.opening_balance !== undefined) svc.setVendorOpening(Number(req.params.id), req.body.opening_balance, req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
crud('vendors', 'vendors', ['code', 'name', 'name_ar', 'phone', 'email', 'tax_no', 'category_id', 'opening_balance', 'notes'], { order: 'ORDER BY name' });
crud('categories', 'categories', ['entity', 'name', 'name_ar', 'name_ur', 'notes'], { order: 'ORDER BY entity,name' });
crud('company-documents', 'company_documents', ['title', 'doc_type', 'doc_no', 'issue_date', 'expiry_date', 'attachment', 'notes'], { order: 'ORDER BY expiry_date IS NULL, expiry_date' });
crud('payment-methods', 'payment_methods', ['name', 'name_ar', 'name_ur', 'kind', 'gl_account', 'active'], { order: 'ORDER BY id' });
crud('banks', 'banks', ['name', 'name_ar', 'name_ur', 'branch', 'account_no', 'iban', 'swift', 'currency', 'gl_account', 'opening_balance', 'notes', 'active'], { order: 'ORDER BY name' });
crud('employees', 'employees', ['name', 'name_ar', 'job_title', 'salary', 'active', 'notes'], { order: 'ORDER BY name' });
crud('assets', 'assets', ['code', 'name', 'name_ar', 'building_id', 'category', 'cost', 'salvage_value', 'life_years', 'purchase_date', 'asset_account', 'expense_account', 'accum_account', 'status', 'notes'], { order: 'ORDER BY name' });
router.post('/assets/depreciation/run', writers, (req, res) => {
  const period = req.body.period || svc.currentMonth();
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'period YYYY-MM' });
  res.json(svc.runDepreciation(period, req.user.id));
});

// ---- Contracts ------------------------------------------------------------
router.get('/contracts', (req, res) => res.json(db.prepare(
  `SELECT c.*, f.code flat, t.name tenant, b.name building FROM contracts c
   JOIN flats f ON f.id=c.flat_id JOIN tenants t ON t.id=c.tenant_id LEFT JOIN buildings b ON b.id=c.building_id
   WHERE 1=1 ${req.query.building_id ? 'AND c.building_id=' + Number(req.query.building_id) : ''}${bScope(req, 'c.building_id')}
   ORDER BY c.id DESC`).all()));
router.post('/contracts', writers, (req, res) => {
  const { contract_no, building_id, flat_id, tenant_id, start_date, end_date, monthly_rent, vat_percent, deposit, remarks, backfill, contract_type, attachment } = req.body;
  try {
    let bid = building_id;
    if (!bid) bid = db.prepare('SELECT building_id FROM flats WHERE id=?').get(flat_id)?.building_id;
    const r = db.prepare(
      `INSERT INTO contracts (contract_no,building_id,flat_id,tenant_id,start_date,end_date,monthly_rent,vat_percent,deposit,remarks,contract_type,attachment)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(contract_no || null, bid || null, flat_id, tenant_id, start_date, end_date, monthly_rent, vat_percent ?? 5, deposit || 0, remarks || null, contract_type || 'residential', attachment || null);
    const id = Number(r.lastInsertRowid);
    const c = db.prepare('SELECT * FROM contracts WHERE id=?').get(id);
    if (deposit > 0) svc.recordDeposit(c, req.user.id);
    if (backfill) svc.backfillInvoices(c, null, svc.currentMonth(), req.user.id);
    res.json({ id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/contracts/:id', writers, (req, res) => {
  const { contract_no, flat_id, tenant_id, start_date, end_date, monthly_rent, vat_percent, deposit, remarks, contract_type, attachment } = req.body;
  try {
    let bid = flat_id ? db.prepare('SELECT building_id FROM flats WHERE id=?').get(flat_id)?.building_id : null;
    db.prepare(`UPDATE contracts SET contract_no=?,flat_id=?,tenant_id=?,building_id=COALESCE(?,building_id),start_date=?,end_date=?,monthly_rent=?,vat_percent=?,deposit=?,remarks=?,contract_type=COALESCE(?,contract_type),attachment=COALESCE(?,attachment) WHERE id=?`)
      .run(contract_no || null, flat_id, tenant_id, bid || null, start_date, end_date, monthly_rent, vat_percent ?? 5, deposit || 0, remarks || null, contract_type || null, attachment || null, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/contracts/:id', writers, (req, res) => {
  const id = Number(req.params.id);
  const c = db.prepare('SELECT * FROM contracts WHERE id=?').get(id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const paid = db.prepare("SELECT COALESCE(SUM(paid_amount),0) s FROM invoices WHERE contract_id=?").get(id).s;
  if (paid > 0.005) return res.status(400).json({ error: 'العقد عليه فواتير مدفوعة — احذف سندات القبض أولاً' });
  const { deleteJournal } = require('./ledger');
  for (const inv of db.prepare('SELECT * FROM invoices WHERE contract_id=?').all(id)) {
    for (const j of db.prepare("SELECT id FROM journals WHERE source_table='invoices' AND source_id=?").all(inv.id)) deleteJournal(j.id);
    db.prepare('DELETE FROM invoices WHERE id=?').run(inv.id);
  }
  if (c.deposit_journal) deleteJournal(c.deposit_journal);
  db.prepare('DELETE FROM contracts WHERE id=?').run(id);
  res.json({ ok: true });
});
router.put('/contracts/:id/status', writers, (req, res) => {
  db.prepare('UPDATE contracts SET status=? WHERE id=?').run(req.body.status || 'active', req.params.id);
  res.json({ ok: true });
});
router.post('/contracts/:id/terminate', writers, (req, res) => {
  try { res.json(svc.terminateContract(Number(req.params.id), req.body.date, req.body.settled_amount, req.user.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/contracts/:id/backfill', writers, (req, res) => {
  const c = db.prepare('SELECT * FROM contracts WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json({ generated: svc.backfillInvoices(c, req.body.from || null, req.body.upto || svc.currentMonth(), req.user.id) });
});

// ---- Invoices (monthly rent) — also exposed at /accruals for back-compat --
function listInvoices(req, res) {
  const { period, status, tenant_id, flat_id } = req.query;
  let where = '1=1', p = [];
  if (period) { where += ' AND i.period=?'; p.push(period); }
  if (status) { where += ' AND i.status=?'; p.push(status); }
  if (tenant_id) { where += ' AND i.tenant_id=?'; p.push(tenant_id); }
  if (flat_id) { where += ' AND i.flat_id=?'; p.push(flat_id); }
  if (req.query.building_id) { where += ' AND i.building_id=?'; p.push(req.query.building_id); }
  where += bScope(req, 'i.building_id');
  const rows = db.prepare(
    `SELECT i.*, i.total AS total_due, f.code flat, t.name tenant, b.name building FROM invoices i
     JOIN flats f ON f.id=i.flat_id JOIN tenants t ON t.id=i.tenant_id LEFT JOIN buildings b ON b.id=i.building_id
     WHERE ${where} ORDER BY i.due_date DESC, f.code`).all(...p);
  res.json(rows);
}
router.get('/invoices', listInvoices);
router.get('/accruals', listInvoices);
router.post('/invoices/generate', writers, (req, res) => {
  const { period } = req.body;
  if (!/^\d{4}-\d{2}$/.test(period || '')) return res.status(400).json({ error: 'period must be YYYY-MM' });
  res.json(svc.issueInvoicesForPeriod(period, req.user.id));
});
router.post('/accruals/generate', writers, (req, res) => {
  const { period } = req.body;
  if (!/^\d{4}-\d{2}$/.test(period || '')) return res.status(400).json({ error: 'period must be YYYY-MM' });
  res.json(svc.issueInvoicesForPeriod(period, req.user.id));
});
router.post('/recognition/run', writers, (req, res) => {
  const period = req.body.period || svc.currentMonth();
  res.json(svc.recognizeRevenueForPeriod(period, req.user.id));
});
// Edit an invoice's amount in place (same invoice id, so its payment
// allocations stay valid even if it was already collected), and rebuild its
// accrual journal to match — otherwise the invoice and the books would drift
// apart the moment someone corrected a mis-generated (e.g. mid-renewal
// proration) amount by hand.
router.put('/invoices/:id', writers, (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  const { deleteJournal, postJournal, ACC, r2 } = require('./ledger');
  const rent = req.body.rent_amount != null ? r2(Number(req.body.rent_amount)) : r2(inv.rent_amount);
  const vat = req.body.vat_percent != null ? r2(rent * (Number(req.body.vat_percent) || 0) / 100)
    : (req.body.vat_amount != null ? r2(Number(req.body.vat_amount)) : r2(inv.vat_amount));
  const total = r2(rent + vat);
  if (total < r2(inv.paid_amount) - 0.005)
    return res.status(400).json({ error: `الفاتورة اتحصّل منها ${inv.paid_amount} — القيمة الجديدة لازم تكون ${inv.paid_amount} أو أكتر. لو عايز تقلّل عن كده، احذف سند القبض أولاً` });
  try {
    if (inv.issue_journal) deleteJournal(inv.issue_journal);
    const tName = (db.prepare('SELECT name FROM tenants WHERE id=?').get(inv.tenant_id) || {}).name || '';
    const fCode = inv.flat_id ? ((db.prepare('SELECT code FROM flats WHERE id=?').get(inv.flat_id) || {}).code || '') : '';
    const narr = `إيجار ${inv.period}${fCode ? ' - وحدة ' + fCode : ''}${tName ? ' - ' + tName : ''} (معدّلة)`;
    const jid = postJournal(
      { jdate: inv.due_date, jtype: 'invoice', reference: inv.invoice_no, memo: `Rent accrual ${inv.period} (edited)`,
        memo_ar: narr, source_table: 'invoices', source_id: inv.id, created_by: req.user.id },
      [
        { account_code: ACC.TENANT_RECV, debit: total, building_id: inv.building_id, flat_id: inv.flat_id, tenant_id: inv.tenant_id, memo: narr },
        { account_code: ACC.RENT_INCOME, credit: rent, building_id: inv.building_id, flat_id: inv.flat_id, tenant_id: inv.tenant_id },
        ...(vat > 0.005 ? [{ account_code: CFG.acct('output_vat'), credit: vat, tenant_id: inv.tenant_id, memo: 'VAT' }] : []),
      ]);
    const status = inv.paid_amount >= total - 0.005 ? 'paid' : (inv.paid_amount > 0.005 ? 'partial' : 'issued');
    db.prepare('UPDATE invoices SET rent_amount=?, vat_amount=?, total=?, recognized_amount=?, status=?, issue_journal=? WHERE id=?')
      .run(rent, vat, total, rent, status, jid, inv.id);
    res.json(db.prepare('SELECT * FROM invoices WHERE id=?').get(inv.id));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/invoices/:id', writers, (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  // An accountant must clear the receipt first; an admin may remove it anyway.
  // When forced, the receipt allocations are unlinked so no orphan rows remain —
  // the money already received stays as a credit on the customer's ledger.
  if (inv.paid_amount > 0.005 && req.user.role !== 'admin')
    return res.status(400).json({ error: 'الفاتورة مدفوعة جزئياً/كلياً — احذف سند القبض أولاً (أو استخدم مدير النظام)' });
  const { deleteJournal } = require('./ledger');
  db.prepare('DELETE FROM payment_allocations WHERE invoice_id=?').run(inv.id);
  for (const j of db.prepare("SELECT id FROM journals WHERE source_table='invoices' AND source_id=?").all(inv.id)) deleteJournal(j.id);
  db.prepare('DELETE FROM invoices WHERE id=?').run(inv.id);
  res.json({ ok: true });
});

// ---- Receipts (سند قبض) ---------------------------------------------------
router.get('/payments', (req, res) => res.json(db.prepare(
  `SELECT p.*, t.name tenant, f.code flat FROM payments p
   JOIN tenants t ON t.id=p.tenant_id LEFT JOIN flats f ON f.id=p.flat_id
   WHERE 1=1${bScope(req, 'p.building_id')}
   ORDER BY p.pdate DESC, p.id DESC LIMIT 500`).all()));
router.post('/payments', writers, (req, res) => {
  try { res.json(svc.recordPayment(req.body, req.user.id)); } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/payments/:id', writers, (req, res) => {
  const p = db.prepare('SELECT voucher_no FROM payments WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  try { svc.deletePayment(Number(req.params.id)); res.json(svc.recordPayment({ ...req.body, voucher_no: req.body.voucher_no || p.voucher_no }, req.user.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/payments/:id', writers, (req, res) => { svc.deletePayment(Number(req.params.id)); res.json({ ok: true }); });

// ---- Vendor bills + payments (سند صرف) -----------------------------------
router.get('/vendor-bills', (req, res) => res.json(db.prepare(
  `SELECT b.*, v.name vendor, a.name account_name FROM vendor_bills b
   LEFT JOIN vendors v ON v.id=b.vendor_id JOIN accounts a ON a.code=b.expense_code
   WHERE 1=1${bScope(req, 'b.building_id')}
   ORDER BY b.bdate DESC, b.id DESC LIMIT 500`).all()));
router.post('/vendor-bills', writers, (req, res) => {
  try { res.json(svc.recordVendorBill(req.body, req.user.id)); } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/vendor-bills/:id', writers, (req, res) => {
  try { res.json(svc.updateVendorBill(Number(req.params.id), req.body, req.user.id)); } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/vendor-bills/:id', writers, (req, res) => {
  try { svc.deleteVendorBill(Number(req.params.id)); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/vendor-payments', (req, res) => res.json(db.prepare(
  `SELECT p.*, v.name vendor FROM vendor_payments p LEFT JOIN vendors v ON v.id=p.vendor_id ORDER BY p.pdate DESC LIMIT 500`).all()));
router.post('/vendor-payments', writers, (req, res) => {
  try { res.json(svc.recordVendorPayment(req.body, req.user.id)); } catch (e) { res.status(400).json({ error: e.message }); }
});
// back-compat: old /expenses -> vendor bill
router.get('/expenses', (req, res) => res.json(db.prepare(
  `SELECT b.id, b.bdate AS edate, b.description, b.amount, b.vat_amount, b.status, v.name vendor, a.name account_name
   FROM vendor_bills b LEFT JOIN vendors v ON v.id=b.vendor_id JOIN accounts a ON a.code=b.expense_code
   ORDER BY b.bdate DESC LIMIT 500`).all()));
router.post('/expenses', writers, (req, res) => {
  try { res.json(svc.recordVendorBill({ ...req.body, bdate: req.body.edate || req.body.bdate }, req.user.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Payroll --------------------------------------------------------------
router.post('/payroll/run', writers, (req, res) => {
  const { period } = req.body;
  if (!/^\d{4}-\d{2}$/.test(period || '')) return res.status(400).json({ error: 'period must be YYYY-MM' });
  res.json(svc.runPayroll(period, req.user.id));
});

// ---- Cheques --------------------------------------------------------------
router.get('/cheques', (req, res) => res.json(R.chequesReport(req.query.status, req.query.direction)));
router.get('/reports/cheques-dashboard', (req, res) => res.json(R.chequesDashboard(req.query.asOf)));
router.post('/cheques', writers, (req, res) => {
  const { direction, cheque_no, bank_id, party, amount, issue_date, due_date } = req.body;
  const r = db.prepare(`INSERT INTO cheques (direction,cheque_no,bank_id,party,amount,issue_date,due_date,status) VALUES (?,?,?,?,?,?,?,'pending')`)
    .run(direction || 'incoming', cheque_no || null, bank_id || null, party || null, amount, issue_date || null, due_date || null);
  res.json({ id: Number(r.lastInsertRowid) });
});
router.post('/cheques/:id/release', writers, (req, res) => {
  const ch = db.prepare('SELECT * FROM cheques WHERE id=?').get(req.params.id);
  if (!ch) return res.status(404).json({ error: 'not found' });
  if (ch.status !== 'pending') return res.status(400).json({ error: 'الشيك مُرحّل بالفعل' });
  const bank = ch.bank_id ? db.prepare('SELECT gl_account FROM banks WHERE id=?').get(ch.bank_id) : null;
  const bankAcc = (bank && bank.gl_account) || '10400';
  const jdate = req.body.date || ch.due_date || new Date().toISOString().slice(0, 10);
  let lines;
  if (ch.direction === 'incoming')
    lines = [{ account_code: bankAcc, debit: ch.amount, memo: `Cheque ${ch.cheque_no}` }, { account_code: '11100', credit: ch.amount, memo: `Cheque from ${ch.party || ''}` }];
  else
    lines = [{ account_code: '20000', debit: ch.amount, memo: `Cheque to ${ch.party || ''}` }, { account_code: bankAcc, credit: ch.amount, memo: `Cheque ${ch.cheque_no}` }];
  try {
    const jid = postJournal({ jdate, jtype: 'manual', reference: `CHQ-${ch.cheque_no || ch.id}`, memo: `Cheque release ${ch.cheque_no || ''}`, created_by: req.user.id }, lines);
    db.prepare('UPDATE cheques SET status=?, journal_id=? WHERE id=?').run('cleared', jid, ch.id);
    res.json({ ok: true, journal_id: jid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/cheques/:id/status', writers, (req, res) => {
  db.prepare('UPDATE cheques SET status=? WHERE id=?').run(req.body.status, req.params.id);
  res.json({ ok: true });
});

// ---- Bank reconciliation --------------------------------------------------
// Bank reconciliation: compare the bank's statement against our ledger.
router.get('/reconciliation/:bank_id', (req, res) => {
  const bankId = Number(req.params.bank_id);
  const bank = db.prepare('SELECT * FROM banks WHERE id=?').get(bankId);
  if (!bank) return res.status(404).json({ error: 'bank not found' });
  const statement = db.prepare('SELECT * FROM bank_statement_lines WHERE bank_id=? ORDER BY txn_date').all(bankId);
  const ledger = db.prepare(
    `SELECT l.id, j.jdate, j.reference, j.memo, l.debit, l.credit,
            EXISTS(SELECT 1 FROM bank_statement_lines s WHERE s.journal_line_id=l.id) reconciled
     FROM journal_lines l JOIN journals j ON j.id=l.journal_id
     WHERE l.account_code=? ORDER BY j.jdate`).all(bank.gl_account || '10400');
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const bookBalance = r3(ledger.reduce((s, l) => s + l.debit - l.credit, 0));
  const stmtBalance = r3(statement.reduce((s, l) => s + (l.credit || 0) - (l.debit || 0), 0));
  const unmatchedLedger = ledger.filter((l) => !l.reconciled);
  const unmatchedStmt = statement.filter((s) => !s.reconciled);
  res.json({
    bank: bank.name, account: bank.gl_account, statement, ledger,
    book_balance: bookBalance, statement_balance: stmtBalance,
    difference: r3(bookBalance - stmtBalance),
    unmatched_ledger: unmatchedLedger.length, unmatched_statement: unmatchedStmt.length,
  });
});
router.post('/reconciliation/:bank_id/import', writers, (req, res) => {
  const rows = req.body.lines || [];
  const ins = db.prepare('INSERT INTO bank_statement_lines (bank_id,txn_date,description,debit,credit) VALUES (?,?,?,?,?)');
  for (const r of rows) ins.run(req.params.bank_id, r.txn_date, r.description || null, r.debit || 0, r.credit || 0);
  res.json({ imported: rows.length });
});
// auto-match statement lines to ledger lines by amount (+/- 3 days)
router.post('/reconciliation/:bank_id/auto-match', writers, (req, res) => {
  const bankId = Number(req.params.bank_id);
  const bank = db.prepare('SELECT * FROM banks WHERE id=?').get(bankId);
  const stmts = db.prepare('SELECT * FROM bank_statement_lines WHERE bank_id=? AND reconciled=0').all(bankId);
  const ledger = db.prepare(
    `SELECT l.id, j.jdate, l.debit, l.credit FROM journal_lines l JOIN journals j ON j.id=l.journal_id
     WHERE l.account_code=? AND NOT EXISTS(SELECT 1 FROM bank_statement_lines s WHERE s.journal_line_id=l.id)`)
    .all((bank && bank.gl_account) || '10400');
  const used = new Set(); let matched = 0;
  for (const s of stmts) {
    const sIn = s.credit || 0, sOut = s.debit || 0;
    const hit = ledger.find((l) => !used.has(l.id)
      && Math.abs((l.debit || 0) - sIn) < 0.005 && Math.abs((l.credit || 0) - sOut) < 0.005
      && Math.abs(Date.parse(l.jdate) - Date.parse(s.txn_date)) <= 3 * 86400000);
    if (hit) {
      used.add(hit.id); matched++;
      db.prepare('UPDATE bank_statement_lines SET reconciled=1, journal_line_id=? WHERE id=?').run(hit.id, s.id);
    }
  }
  res.json({ matched, remaining: stmts.length - matched });
});
router.put('/reconciliation/line/:id', writers, (req, res) => {
  const { reconciled, journal_line_id } = req.body;
  db.prepare('UPDATE bank_statement_lines SET reconciled=?, journal_line_id=? WHERE id=?')
    .run(reconciled ? 1 : 0, reconciled ? (journal_line_id || null) : null, req.params.id);
  res.json({ ok: true });
});
router.delete('/reconciliation/line/:id', writers, (req, res) => {
  db.prepare('DELETE FROM bank_statement_lines WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Journals -------------------------------------------------------------
router.get('/journals', (req, res) => {
  const { from, to, type, q, amount } = req.query; let where = '1=1', p = [];
  if (from) { where += ' AND jdate>=?'; p.push(from); }
  if (to) { where += ' AND jdate<=?'; p.push(to); }
  if (type) { where += ' AND jtype=?'; p.push(type); }
  // free-text search: journal number (id), reference or memo
  if (q) { const s = '%' + q + '%'; where += ' AND (CAST(j.id AS TEXT)=? OR j.reference LIKE ? OR j.memo LIKE ? OR j.memo_ar LIKE ?)'; p.push(String(q), s, s, s); }
  // search by amount: any journal whose debit total (or any line) matches
  if (amount) { where += ' AND j.id IN (SELECT journal_id FROM journal_lines WHERE ABS(debit-?)<0.005 OR ABS(credit-?)<0.005)'; p.push(Number(amount), Number(amount)); }
  // seq = a clean running serial over ALL journals (oldest = 1), stable regardless
  // of the current filter, shown as the sequential journal number.
  res.json(db.prepare(
    `WITH numbered AS (SELECT id, ROW_NUMBER() OVER (ORDER BY jdate, id) seq FROM journals)
     SELECT j.*, n.seq, (SELECT COALESCE(SUM(debit),0) FROM journal_lines WHERE journal_id=j.id) total
     FROM journals j JOIN numbered n ON n.id=j.id WHERE ${where} ORDER BY jdate DESC, j.id DESC LIMIT 500`).all(...p));
});
router.get('/journals/:id', (req, res) => {
  const j = db.prepare('SELECT * FROM journals WHERE id=?').get(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  j.lines = db.prepare(
    `SELECT l.*, a.name account_name, t.name tenant, v.name vendor, f.code flat, b.name building FROM journal_lines l
     JOIN accounts a ON a.code=l.account_code LEFT JOIN tenants t ON t.id=l.tenant_id LEFT JOIN vendors v ON v.id=l.vendor_id
     LEFT JOIN flats f ON f.id=l.flat_id LEFT JOIN buildings b ON b.id=l.building_id WHERE l.journal_id=?`).all(req.params.id);
  res.json(j);
});
router.post('/journals', writers, (req, res) => {
  const { jdate, memo, reference, lines } = req.body;
  try { res.json({ id: postJournal({ jdate, jtype: 'manual', memo, reference, created_by: req.user.id }, lines) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
const { deleteJournal } = require('./ledger');
// Admin can edit/delete ANY journal — including system-generated ones. When a
// journal is linked to a source document we detach the link so the source keeps
// its own record but no longer points at a journal that changed underneath it.
function detachJournalFromSource(j) {
  // clear every foreign-key reference to this journal so it can be removed
  // (some sources set source_id only after creation, so match by journal id)
  const refs = [
    ['invoices', 'issue_journal'], ['invoices', 'recog_journal'],
    ['payments', 'journal_id'], ['vendor_bills', 'journal_id'], ['vendor_payments', 'journal_id'],
    ['contracts', 'deposit_journal'], ['cheques', 'journal_id'], ['payroll_runs', 'journal_id'], ['depreciation_runs', 'journal_id'],
  ];
  for (const [tbl, col] of refs) { try { db.prepare(`UPDATE ${tbl} SET ${col}=NULL WHERE ${col}=?`).run(j.id); } catch {} }
  // unlink any reconciled bank-statement lines that pointed at this journal's lines
  try { db.prepare('UPDATE bank_statement_lines SET reconciled=0, journal_line_id=NULL WHERE journal_line_id IN (SELECT id FROM journal_lines WHERE journal_id=?)').run(j.id); } catch {}
}
router.delete('/journals/:id', writers, (req, res) => {
  const j = db.prepare('SELECT * FROM journals WHERE id=?').get(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  detachJournalFromSource(j);
  deleteJournal(j.id); res.json({ ok: true });
});
router.put('/journals/:id', writers, (req, res) => {
  const j = db.prepare('SELECT * FROM journals WHERE id=?').get(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  const { jdate, memo, reference, lines } = req.body;
  try {
    detachJournalFromSource(j);
    deleteJournal(j.id);
    // reuse the same id so editing keeps the journal number stable
    res.json({ id: postJournal({ id: j.id, jdate, jtype: j.jtype || 'manual', memo, reference: reference || j.reference, created_by: req.user.id }, lines) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Reconcile opening balances -------------------------------------------
// The manual opening journal (OB-2025) carries AGGREGATE balances for
// receivables/payables/advances, but those are now entered per customer/vendor
// (OB-CUST / OB-VEND). This removes the duplicated aggregate lines from OB-2025
// and rebalances via Opening Balance Equity (39999) so nothing is double-counted.
router.post('/opening/reconcile', requireRole('admin'), (req, res) => {
  const REMOVE = ['11100', '11000', '20000', '21500', '23100'];
  let j = db.prepare("SELECT * FROM journals WHERE reference='OB-2025'").get();
  if (!j) j = db.prepare("SELECT j.* FROM journals j WHERE j.jtype='opening' AND (j.reference IS NULL OR (j.reference NOT LIKE 'OB-CUST%' AND j.reference NOT LIKE 'OB-VEND%')) ORDER BY (SELECT COALESCE(SUM(debit),0) FROM journal_lines WHERE journal_id=j.id) DESC LIMIT 1").get();
  if (!j) return res.status(404).json({ error: 'لا يوجد قيد افتتاحي يدوي (OB-2025)' });
  const lines = db.prepare('SELECT * FROM journal_lines WHERE journal_id=?').all(j.id);
  const removed = lines.filter((l) => REMOVE.includes(l.account_code));
  if (!removed.length) return res.json({ ok: true, message: 'لا توجد أرصدة مكررة في القيد الافتتاحي', removed: 0, journal_id: j.id });
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const remDr = r3(removed.reduce((s, l) => s + l.debit, 0));
  const remCr = r3(removed.reduce((s, l) => s + l.credit, 0));
  const del = db.prepare('DELETE FROM journal_lines WHERE id=?');
  for (const l of removed) del.run(l.id);
  const rem = db.prepare('SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM journal_lines WHERE journal_id=?').get(j.id);
  const diff = r3(rem.d - rem.c); // >0 => remaining is debit-heavy, add a credit to balance
  if (Math.abs(diff) > 0.005) {
    try { db.prepare("INSERT OR IGNORE INTO accounts (code,name,name_ar,type,normal_balance) VALUES ('39999','Opening Balance Equity','حقوق ملكية افتتاحية','equity','C')").run(); } catch {}
    const ex = db.prepare("SELECT id,debit,credit FROM journal_lines WHERE journal_id=? AND account_code='39999'").get(j.id);
    if (ex) {
      const net = r3((ex.credit - ex.debit) + diff); // fold into existing 39999 line
      db.prepare('UPDATE journal_lines SET debit=?, credit=? WHERE id=?').run(net < 0 ? -net : 0, net > 0 ? net : 0, ex.id);
    } else {
      db.prepare('INSERT INTO journal_lines (journal_id,account_code,debit,credit,memo) VALUES (?,?,?,?,?)')
        .run(j.id, '39999', diff < 0 ? -diff : 0, diff > 0 ? diff : 0, 'تسوية توحيد الأرصدة الافتتاحية');
    }
  }
  res.json({ ok: true, journal_id: j.id, removed: removed.length, removed_accounts: REMOVE, removed_debit: remDr, removed_credit: remCr, rebalanced_to_39999: diff });
});

// ---- Reports --------------------------------------------------------------
router.get('/reports/trial-balance', (req, res) => res.json(R.trialBalance(req.query.upto, lang(req))));
router.get('/reports/income-statement', (req, res) => res.json(R.incomeStatement(req.query.from, req.query.to, lang(req), req.query.building_id ? Number(req.query.building_id) : null)));
router.get('/reports/income-statement-consolidated', (req, res) => res.json(R.incomeStatementConsolidated(req.query.year, lang(req), effBuilding(req) && effBuilding(req) > 0 ? effBuilding(req) : (req.query.building_id ? Number(req.query.building_id) : null))));
// Account movements (General Ledger report + click-through drill from any total)
router.get('/reports/account-ledger', (req, res) => {
  const accounts = req.query.accounts ? String(req.query.accounts).split(',').map((s) => s.trim()).filter(Boolean) : null;
  res.json(R.accountLedger({
    account: req.query.account || null, accounts,
    from: req.query.from || null, to: req.query.to || null,
    tenant_id: req.query.tenant_id ? Number(req.query.tenant_id) : null,
    vendor_id: req.query.vendor_id ? Number(req.query.vendor_id) : null,
    building_id: req.query.building_id ? Number(req.query.building_id) : null,
    flat_id: req.query.flat_id ? Number(req.query.flat_id) : null,
  }, lang(req)));
});
router.get('/reports/balance-sheet', (req, res) => res.json(R.balanceSheet(req.query.upto, lang(req))));
router.get('/reports/financial-statements', (req, res) => res.json(R.financialStatements(req.query.year, lang(req))));
router.get('/reports/general-ledger-full', (req, res) => res.json(R.generalLedgerFull({ from: req.query.from || null, to: req.query.to || null, building_id: req.query.building_id ? Number(req.query.building_id) : null }, lang(req))));
router.get('/reports/grouped-journals', (req, res) => res.json(R.groupedJournals(req.query.from, req.query.to, lang(req), req.query.group || 'day')));
router.get('/reports/legacy-journals', (req, res) => res.json(R.legacyJournals(req.query.from, req.query.to, lang(req), req.query.side || 'all')));
router.get('/reports/legacy-drill', (req, res) => res.json(R.legacyDrill(req.query.account, req.query.period, req.query.side || 'debit', lang(req))));
router.get('/reports/liquidity', (req, res) => res.json(R.liquidityReport(req.query.upto, lang(req))));
router.get('/reports/money-position', (req, res) => res.json(R.moneyPosition(req.query.upto, lang(req))));
router.get('/budget', (req, res) => res.json(BUD.getBudget(Number(req.query.year), Number(req.query.building_id) || 0, lang(req), Number(req.query.version) || 1)));
router.post('/budget', writers, (req, res) => {
  try { res.json(BUD.saveBudget(Number(req.body.year), Number(req.body.building_id) || 0, req.body.entries, req.user.id, Number(req.body.version) || 1)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/budget/versions', (req, res) => res.json(BUD.listBudgetVersions(Number(req.query.year), Number(req.query.building_id) || 0)));
router.put('/budget/versions/label', writers, (req, res) => {
  try { res.json(BUD.saveBudgetVersionLabel(Number(req.body.year), Number(req.body.building_id) || 0, Number(req.body.version) || 1, req.body.label)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/budget/suggest-revenue', (req, res) => res.json(BUD.suggestRevenue(req.query.occupancy, Number(req.query.building_id) || null)));
router.get('/budget/suggest-expenses', (req, res) => res.json(BUD.suggestExpenses(Number(req.query.year), Number(req.query.building_id) || null, Number(req.query.months) || 12)));
router.get('/reports/budget-vs-actual', (req, res) => res.json(BUD.budgetVsActual(Number(req.query.year), Number(req.query.building_id) || 0, lang(req), Number(req.query.version) || 1)));
router.get('/reports/budget-vs-actual-flat', (req, res) => res.json(BUD.budgetVsActualFlat(Number(req.query.year), Number(req.query.building_id) || 0, Number(req.query.version) || 1, req.query.month ? Number(req.query.month) : null, lang(req))));
router.get('/presentation', (req, res) => res.json(PRES.getPresentationData(req.query.from, req.query.to, req.query.building_id, Number(req.query.version) || 1)));
router.put('/presentation/notes', writers, (req, res) => {
  try { res.json(PRES.saveNotes(Number(req.body.year), Number(req.body.building_id) || 0, req.body, req.user.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/presentation/share', writers, (req, res) => {
  try {
    const s = PRES.getOrCreateShare(req.body.from, req.body.to, req.body.building_id, req.body.version, req.user.id);
    res.json({ token: s.token, path: `/#/public-presentation?token=${s.token}` });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/presentation/feedback', (req, res) => {
  try { res.json(PRES.listFeedback(req.query.from, req.query.to, req.query.building_id, Number(req.query.version) || 1)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/reports/financial-ratios', (req, res) => res.json(R.financialRatios(req.query.from, req.query.to, effBuilding(req) && effBuilding(req) > 0 ? effBuilding(req) : null)));
router.get('/reports/aging', (req, res) => res.json(R.receivablesAging(req.query.asOf, effBuilding(req))));
router.get('/reports/aging-drill', (req, res) => res.json(R.receivablesAgingDrill(req.query.tenant_id ? Number(req.query.tenant_id) : null, req.query.asOf, effBuilding(req))));
router.get('/reports/contract-expiry', (req, res) => res.json(R.contractExpiry(Number(req.query.days) || 60, effBuilding(req))));
router.get('/reports/building-comparison', (req, res) => res.json(scopeRows(req, R.buildingComparison(req.query.from, req.query.to).map((r) => r))));
router.get('/reports/payables-aging', (req, res) => res.json(R.payablesAging(req.query.asOf)));
router.get('/reports/flat-statement', (req, res) => res.json(R.flatStatement({
  flat_id: req.query.flat_id ? Number(req.query.flat_id) : null,
  tenant_id: req.query.tenant_id ? Number(req.query.tenant_id) : null,
  building_id: req.query.building_id ? Number(req.query.building_id) : null,
  from: req.query.from, to: req.query.to }, lang(req))));
router.get('/reports/vendor-statement', (req, res) => res.json(R.vendorStatement({ vendor_id: req.query.vendor_id ? Number(req.query.vendor_id) : null, from: req.query.from, to: req.query.to }, lang(req))));
router.get('/reports/advances', (req, res) => res.json(R.advancesReport(req.query.asOf)));
router.get('/reports/occupancy', (req, res) => res.json(R.occupancy(req.query.onDate, effBuilding(req))));
router.get('/reports/property-pl', (req, res) => res.json(scopeRows(req, R.propertyPL(req.query.from, req.query.to))));
router.get('/reports/roi', (req, res) => res.json(R.roi(req.query.from, req.query.to)));
router.get('/reports/cash-flow', (req, res) => res.json(R.cashFlowForecast(Number(req.query.months) || 6)));
router.get('/reports/vat', (req, res) => res.json(R.vatReport(req.query.from, req.query.to)));
router.get('/reports/vat-uncollected', (req, res) => res.json(R.vatUncollectedByCustomer(req.query.from, req.query.to)));
router.get('/reports/vat-input-unpaid', (req, res) => res.json(R.vatInputUnpaidByVendor(req.query.from, req.query.to)));
router.get('/reports/vat-return', (req, res) => res.json(R.vatReturn(req.query.from, req.query.to)));
router.get('/reports/vat-statement', (req, res) => res.json(R.vatStatement(req.query.year)));
router.post('/vat/settle', writers, (req, res) => {
  try { res.json(svc.settleVAT(req.body, req.user.id)); } catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/reports/depreciation', (req, res) => res.json(R.depreciationReport(req.query.building_id ? Number(req.query.building_id) : null)));
router.get('/reports/customers-summary', (req, res) => res.json(R.customersSummary()));
router.get('/reports/bank', (req, res) => res.json(R.bankReport(Number(req.query.bank_id) || 1, req.query.from, req.query.to)));
router.get('/reports/dashboard', (req, res) => res.json(R.dashboard(effBuilding(req), req.query.from, req.query.to)));

module.exports = router;
