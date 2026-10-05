// Outgoing mail (password-reset codes). SMTP is configured ONLY through environment variables so no
// mail credentials are ever stored in the database or the repo:
//   SMTP_HOST, SMTP_PORT (default 587), SMTP_SECURE ("true" for port 465), SMTP_USER, SMTP_PASS, MAIL_FROM
const nodemailer = require('nodemailer');

let transporter = null;
const configured = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

function getTransport() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
  });
  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  if (!configured()) throw new Error('SMTP is not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_FROM)');
  return getTransport().sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text, html });
}

module.exports = { sendMail, configured };
