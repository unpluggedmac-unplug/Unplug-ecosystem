const nodemailer = require('nodemailer');

// Same honesty pattern as the payment gateways: if real SMTP credentials
// aren't configured, don't silently fail or fake success — log the email
// content to the console so development/testing can still see what would
// have been sent, with a loud warning that this isn't happening for real.
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;

// Port 465 is implicit TLS (the connection is encrypted from the first byte);
// 587 and 25 start in the clear and upgrade via STARTTLS. Getting this wrong
// doesn't produce a helpful error — it just hangs or fails to connect — so
// derive it from the port instead of hardcoding one of the two.
const SMTP_SECURE = process.env.SMTP_SECURE
  ? process.env.SMTP_SECURE === 'true'
  : SMTP_PORT === 465;

let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  console.log(`[email] SMTP configured: ${process.env.SMTP_HOST}:${SMTP_PORT} (secure=${SMTP_SECURE})`);
} else {
  // Loud on boot, not just at send time — otherwise the first sign that
  // verification emails aren't going out is a member who can't sign up.
  console.warn('[email] SMTP is NOT configured. Verification codes and password resets will be logged, not sent. Set SMTP_HOST, SMTP_USER and SMTP_PASS.');
}

function isConfigured() {
  return transporter !== null;
}

// Confirms the credentials and connection actually work, without sending
// anything. Used by the admin email test so a misconfiguration surfaces
// immediately rather than as silently undelivered signup codes.
async function verifyConnection() {
  if (!transporter) throw new Error('SMTP is not configured on this server.');
  await transporter.verify();
  return true;
}

async function sendEmail({ to, subject, text }) {
  if (!transporter) {
    console.warn('[email] SMTP is not configured — logging instead of sending. Set SMTP_HOST/SMTP_USER/SMTP_PASS in .env to send real emails.');
    console.log(`[email] To: ${to}\n[email] Subject: ${subject}\n[email] Body:\n${text}`);
    return { simulated: true };
  }
  return transporter.sendMail({
    from: process.env.SMTP_FROM || 'Unplug Magazine <no-reply@unplugnews.com>',
    to,
    subject,
    text,
  });
}

module.exports = { sendEmail, isConfigured, verifyConnection };
