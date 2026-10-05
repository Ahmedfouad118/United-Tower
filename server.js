const express = require('express');
const path = require('path');
const { init } = require('./src/db');

init();

const app = express();
app.set('trust proxy', 1);   // behind Railway's proxy: req.ip = the real client (rate limits)
app.disable('x-powered-by');
// small body limit for the unauthenticated endpoints (parsed before the global 5 MB parser)
app.use(['/api/login', '/api/auth', '/api/public'], express.json({ limit: '20kb' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
// Baseline hardening headers — kept minimal (no CSP) since the app relies on
// inline <style>/<script> in several generated reports; a strict default CSP
// would break those without a larger rewrite. These three carry no such risk.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  // The app uses inline <style>/<script> (generated reports), so 'unsafe-inline' stays; everything else is locked to this origin
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  next();
});
// API answers (financial data, backups) must never be cached by the browser or a proxy
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

app.use('/api', require('./src/api'));
app.use('/api', require('./src/exports'));
app.use('/api', require('./src/email'));
app.use('/api', require('./src/ai'));
app.use('/api/import', require('./src/imports'));

// no-cache so the browser always loads the latest UI (dev/local app)
app.use((req, res, next) => { res.set('Cache-Control', 'no-store, no-cache, must-revalidate'); next(); });
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// last resort: never leak stack traces / SQL text to the client
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[UT] unhandled error:', err && err.stack ? err.stack : err);
  res.status(status).json({ error: status === 413 ? 'request too large' : status >= 500 ? 'request failed' : 'bad request' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n  United Tower running →  http://localhost:${PORT}\n`);
});
