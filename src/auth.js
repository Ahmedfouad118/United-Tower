const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { db } = require('./db');
const TOTP = require('./totp');
const mailer = require('./mailer');
const { hit } = require('./ratelimit');

// No fixed fallback: a well-known default secret would let anyone forge an
// admin token. If UT_SECRET isn't set, generate a random one for this process
// instead — tokens just won't survive a restart, which is a safe failure mode
// (as opposed to a guessable one).
const SECRET = process.env.UT_SECRET || crypto.randomBytes(48).toString('hex');
if (!process.env.UT_SECRET) console.warn('[UT] WARNING: UT_SECRET is not set — using a random per-process secret. Set UT_SECRET in the environment for stable sessions across restarts.');

function hash(pw) { return bcrypt.hashSync(pw, 10); }

// simple in-memory brute-force throttle: N failed attempts per username
// locks that username out for a cooldown window. Resets on success.
// A lock is per (ip, username): one attacker cannot lock the real admin out of the app from other addresses.
// A much higher username-wide ceiling still stops a distributed guessing campaign.
const failedAttempts = new Map(); // key -> { count, lockedUntil, last }
const MAX_ATTEMPTS = 5, LOCKOUT_MS = 5 * 60 * 1000, GLOBAL_MAX = 40, GLOBAL_LOCK_MS = 15 * 60 * 1000;
const keyOf = (username, ip) => (ip ? ip + '|' : '*|') + username;
function purgeAttempts() {
  if (failedAttempts.size < 2000) return;
  const now = Date.now();
  for (const [k, v] of failedAttempts) if ((v.lockedUntil || 0) < now && now - (v.last || 0) > 60 * 60 * 1000) failedAttempts.delete(k);
}
function loginLocked(username, ip) {
  const now = Date.now();
  for (const k of [keyOf(username, ip), keyOf(username, null)]) { const rec = failedAttempts.get(k); if (rec && rec.lockedUntil && rec.lockedUntil > now) return true; }
  return false;
}
function registerFailure(username, ip) {
  purgeAttempts();
  const bump = (k, max, ms) => {
    const rec = failedAttempts.get(k) || { count: 0, lockedUntil: 0, last: 0 };
    rec.count++; rec.last = Date.now();
    if (rec.count >= max) { rec.lockedUntil = Date.now() + ms; rec.count = 0; }
    failedAttempts.set(k, rec);
  };
  bump(keyOf(username, ip), MAX_ATTEMPTS, LOCKOUT_MS);
  bump(keyOf(username, null), GLOBAL_MAX, GLOBAL_LOCK_MS);
}
function registerSuccess(username, ip) { failedAttempts.delete(keyOf(username, ip)); }

function issueToken(u) {
  return jwt.sign({ id: u.id, username: u.username, role: u.role, name: u.full_name }, SECRET, { expiresIn: '12h' });
}

// A dummy hash keeps response time similar whether or not the username exists (no user enumeration by timing).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
function login(rawUsername, password, ip) {
  const username = String(rawUsername || '').trim().toLowerCase();
  if (!username || typeof password !== 'string') return null;
  if (loginLocked(username, ip)) return { locked: true };
  const u = db.prepare('SELECT * FROM users WHERE lower(username)=? AND active=1').get(username);
  const ok = bcrypt.compareSync(password, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) { registerFailure(username, ip); return null; }
  registerSuccess(username, ip);
  if (u.totp_enabled) {
    // password is correct but a second factor is still required — issue a
    // short-lived, single-purpose token that can only be redeemed at
    // /login/2fa, never used as a real session token.
    const pending_token = jwt.sign({ id: u.id, pending2fa: true }, SECRET, { expiresIn: '5m' });
    return { needs_2fa: true, pending_token };
  }
  const token = issueToken(u);
  return { token, user: { id: u.id, username: u.username, role: u.role, full_name: u.full_name } };
}

function completeTwoFactorLogin(pending_token, code) {
  let payload;
  try { payload = jwt.verify(pending_token, SECRET); } catch { return null; }
  if (!payload.pending2fa) return null;
  const u = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(payload.id);
  if (!u || !u.totp_enabled || !u.totp_secret) return null;
  if (!TOTP.verifyTotp(u.totp_secret, code)) return null;
  const token = issueToken(u);
  return { token, user: { id: u.id, username: u.username, role: u.role, full_name: u.full_name } };
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const payload = jwt.verify(token, SECRET);
    // a pending-2FA token proves the password only, not the second factor —
    // it must never be usable as a real session token on any other route.
    if (payload.pending2fa) return res.status(401).json({ error: 'invalid token' });
    const cur = db.prepare('SELECT active, role, pwd_changed_at FROM users WHERE id=?').get(payload.id);
    if (!cur || !cur.active || (payload.iat || 0) * 1000 < (cur.pwd_changed_at || 0)) return res.status(401).json({ error: 'invalid token' });
    payload.role = cur.role;               // role changes take effect immediately, not at next login
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role))
      return res.status(403).json({ error: 'forbidden' });
    next();
  };
}


// ---- Password policy ---------------------------------------------------------
const COMMON = new Set(['password', 'password1', 'admin123', 'admin1234', '12345678', '123456789', '1234567890', 'qwerty123', 'changeme', 'letmein123', 'welcome123', 'unitedtower']);
function checkPassword(pw, username) {
  const p = String(pw || '');
  if (p.length < 10) return 'كلمة المرور لازم تكون 10 حروف/أرقام على الأقل';
  if (p.length > 128) return 'كلمة المرور طويلة جدًا';
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return 'كلمة المرور لازم تحتوي حروف وأرقام';
  if (COMMON.has(p.toLowerCase()) || (username && p.toLowerCase().includes(String(username).toLowerCase()))) return 'كلمة المرور سهلة التخمين — اختار غيرها';
  return null;
}

// ---- Forgot password: emailed one-time code, then a new password ------------------
// Always answers the same way whether or not the account exists (no user enumeration).
const OTP_TTL_MS = 10 * 60 * 1000, OTP_MAX_ATTEMPTS = 5;
const otpHash = (otp) => crypto.createHmac('sha256', SECRET).update(String(otp)).digest('hex');
function findUserForReset(identifier) {
  const id = String(identifier || '').trim().toLowerCase();
  if (!id || id.length > 200) return null;
  return db.prepare("SELECT * FROM users WHERE active=1 AND email IS NOT NULL AND email<>'' AND (lower(username)=? OR lower(email)=?)").get(id, id) || null;
}
async function requestPasswordReset(identifier, ip) {
  const u = findUserForReset(identifier);
  if (!u) return { ok: true };
  // at most 3 codes per account per hour (blocks mailbox flooding of a real user)
  if (!hit('reset-user:' + u.id, 3, 60 * 60 * 1000)) return { ok: true };
  const otp = String(crypto.randomInt(100000, 1000000));
  db.prepare('UPDATE password_resets SET used=1 WHERE user_id=? AND used=0').run(u.id);
  db.prepare('INSERT INTO password_resets (user_id, otp_hash, expires_at, created_at, ip) VALUES (?,?,?,?,?)')
    .run(u.id, otpHash(otp), Date.now() + OTP_TTL_MS, Date.now(), ip || null);
  mailer.sendMail({
      to: u.email, subject: 'United Tower — رمز إعادة تعيين كلمة المرور',
      text: `رمز التحقق: ${otp}\nصالح لمدة 10 دقائق. لو ماطلبتش إعادة التعيين تجاهل الرسالة.\n\nVerification code: ${otp} (valid 10 minutes). If you did not request this, ignore this email.`,
      html: `<div dir="rtl" style="font-family:Tahoma,Arial"><p>رمز التحقق لإعادة تعيين كلمة المرور:</p><p style="font-size:28px;letter-spacing:6px;font-weight:700">${otp}</p><p>صالح لمدة 10 دقائق. لو ماطلبتش ده تجاهل الرسالة.</p><hr><p dir="ltr">Your password-reset code is <b>${otp}</b> (valid 10 minutes). If you did not request it, ignore this email.</p></div>`,
    }).catch((e) => console.error('[UT] reset email failed:', e.message));
  return { ok: true };
}
function confirmPasswordReset(identifier, otp, newPassword) {
  const bad = { error: 'الرمز غير صحيح أو منتهي' };
  const u = findUserForReset(identifier);
  if (!u) return bad;
  const row = db.prepare('SELECT * FROM password_resets WHERE user_id=? AND used=0 ORDER BY id DESC LIMIT 1').get(u.id);
  if (!row || row.expires_at < Date.now() || row.attempts >= OTP_MAX_ATTEMPTS) return bad;
  const given = Buffer.from(otpHash(String(otp || '').trim()), 'hex'), want = Buffer.from(row.otp_hash, 'hex');
  if (!crypto.timingSafeEqual(given, want)) {
    db.prepare('UPDATE password_resets SET attempts=attempts+1 WHERE id=?').run(row.id);
    return bad;
  }
  const weak = checkPassword(newPassword, u.username);
  if (weak) return { error: weak };       // code stays valid so the user can retry with a stronger password
  db.prepare('UPDATE users SET password_hash=?, pwd_changed_at=? WHERE id=?').run(hash(newPassword), Date.now(), u.id);
  db.prepare('UPDATE password_resets SET used=1 WHERE user_id=?').run(u.id);
  failedAttempts.delete(keyOf(String(u.username).toLowerCase(), null));
  return { ok: true };
}

// ---- Two-factor (TOTP) self-service setup ----------------------------------
// Generates a new secret and stashes it un-enabled; the user must prove they
// can produce a valid code (enableTwoFactor) before it actually protects login.
function assertPassword(userId, password) {
  const u = db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId);
  if (!u || typeof password !== 'string' || !bcrypt.compareSync(password, u.password_hash)) throw new Error('كلمة المرور غير صحيحة');
}
function startTwoFactorSetup(userId, issuer, password) {
  assertPassword(userId, password);
  const u = db.prepare('SELECT username FROM users WHERE id=?').get(userId);
  if (!u) throw new Error('user not found');
  const secret = TOTP.generateSecret();
  db.prepare('UPDATE users SET totp_secret=?, totp_enabled=0 WHERE id=?').run(secret, userId);
  return { secret, otpauth_url: TOTP.otpauthUrl(secret, u.username, issuer || 'United Tower') };
}
function enableTwoFactor(userId, code) {
  const u = db.prepare('SELECT totp_secret FROM users WHERE id=?').get(userId);
  if (!u || !u.totp_secret) throw new Error('لازم تبدأ الإعداد الأول');
  if (!TOTP.verifyTotp(u.totp_secret, code)) throw new Error('الكود غير صحيح');
  db.prepare('UPDATE users SET totp_enabled=1 WHERE id=?').run(userId);
  return { ok: true };
}
function disableTwoFactor(userId, password, code) {
  assertPassword(userId, password);
  const cur = db.prepare('SELECT totp_enabled, totp_secret FROM users WHERE id=?').get(userId);
  if (cur && cur.totp_enabled && !TOTP.verifyTotp(cur.totp_secret, code)) throw new Error('الكود غير صحيح');
  db.prepare('UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=?').run(userId);
  return { ok: true };
}

module.exports = {
  hash, login, completeTwoFactorLogin, authMiddleware, requireRole, SECRET, checkPassword,
  requestPasswordReset, confirmPasswordReset,
  startTwoFactorSetup, enableTwoFactor, disableTwoFactor,
};
