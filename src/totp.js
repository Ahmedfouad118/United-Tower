// Minimal RFC 4226 (HOTP) / RFC 6238 (TOTP) implementation using only Node's
// built-in crypto — no external dependency needed for two-factor auth.
// Compatible with Google Authenticator, Authy, Microsoft Authenticator, etc.
const crypto = require('crypto');

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = '', out = '';
  for (const byte of buf) bits += byte.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    out += B32_ALPHABET[parseInt(chunk, 2)];
  }
  return out;
}
function base32Decode(str) {
  str = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const c of str) {
    const v = B32_ALPHABET.indexOf(c);
    if (v === -1) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

// Generates a new random secret (20 bytes = 160 bits, the standard TOTP size).
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secret, counter, digits = 6) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

function totp(secret, { step = 30, digits = 6, at = Date.now() } = {}) {
  const counter = Math.floor(at / 1000 / step);
  return hotp(secret, counter, digits);
}

// Accepts a code from the current time step or one step before/after, to
// tolerate small clock drift between the server and the user's phone.
function verifyTotp(secret, token, { step = 30, digits = 6, window = 1, at = Date.now() } = {}) {
  token = String(token || '').trim();
  if (!/^\d{6,8}$/.test(token)) return false;
  const counter = Math.floor(at / 1000 / step);
  for (let w = -window; w <= window; w++) {
    if (hotp(secret, counter + w, digits) === token) return true;
  }
  return false;
}

function otpauthUrl(secret, label, issuer) {
  const enc = encodeURIComponent;
  return `otpauth://totp/${enc(issuer)}:${enc(label)}?secret=${secret}&issuer=${enc(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { generateSecret, totp, verifyTotp, otpauthUrl, base32Encode, base32Decode };
