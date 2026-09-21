const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { db } = require('./db');
const TOTP = require('./totp');

// No fixed fallback: a well-known default secret would let anyone forge an
// admin token. If UT_SECRET isn't set, generate a random one for this process
// instead — tokens just won't survive a restart, which is a safe failure mode
// (as opposed to a guessable one).
const SECRET = process.env.UT_SECRET || crypto.randomBytes(48).toString('hex');
if (!process.env.UT_SECRET) console.warn('[UT] WARNING: UT_SECRET is not set — using a random per-process secret. Set UT_SECRET in the environment for stable sessions across restarts.');

function hash(pw) { return bcrypt.hashSync(pw, 10); }

// simple in-memory brute-force throttle: N failed attempts per username
// locks that username out for a cooldown window. Resets on success.
const failedAttempts = new Map(); // username -> { count, lockedUntil }
const MAX_ATTEMPTS = 5, LOCKOUT_MS = 5 * 60 * 1000;
function loginLocked(username) {
  const rec = failedAttempts.get(username);
  return !!(rec && rec.lockedUntil && rec.lockedUntil > Date.now());
}
function registerFailure(username) {
  const rec = failedAttempts.get(username) || { count: 0, lockedUntil: 0 };
  rec.count++;
  if (rec.count >= MAX_ATTEMPTS) { rec.lockedUntil = Date.now() + LOCKOUT_MS; rec.count = 0; }
  failedAttempts.set(username, rec);
}
function registerSuccess(username) { failedAttempts.delete(username); }

function issueToken(u) {
  return jwt.sign({ id: u.id, username: u.username, role: u.role, name: u.full_name }, SECRET, { expiresIn: '12h' });
}

function login(username, password) {
  if (loginLocked(username)) return { locked: true };
  const u = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) { registerFailure(username); return null; }
  registerSuccess(username);
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

// ---- Two-factor (TOTP) self-service setup ----------------------------------
// Generates a new secret and stashes it un-enabled; the user must prove they
// can produce a valid code (enableTwoFactor) before it actually protects login.
function startTwoFactorSetup(userId, issuer) {
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
function disableTwoFactor(userId) {
  db.prepare('UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=?').run(userId);
  return { ok: true };
}

module.exports = {
  hash, login, completeTwoFactorLogin, authMiddleware, requireRole, SECRET,
  startTwoFactorSetup, enableTwoFactor, disableTwoFactor,
};
