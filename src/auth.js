const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('./db');

const SECRET = process.env.UT_SECRET || 'united-tower-dev-secret-change-me';

function hash(pw) { return bcrypt.hashSync(pw, 10); }

function login(username, password) {
  const u = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) return null;
  const token = jwt.sign({ id: u.id, username: u.username, role: u.role, name: u.full_name }, SECRET, { expiresIn: '12h' });
  return { token, user: { id: u.id, username: u.username, role: u.role, full_name: u.full_name } };
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    req.user = jwt.verify(token, SECRET);
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

module.exports = { hash, login, authMiddleware, requireRole, SECRET };
