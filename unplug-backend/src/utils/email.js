const nodemailer = require('nodemailer');

// Same honesty pattern as the payment gateways: if real SMTP credentials
// aren't configured, don't silently fail or fake success — log the email
// content to the console so development/testing can still see what would
// have been sent, with a loud warning that this isn't happening for real.
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
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

module.exports = { sendEmail };
