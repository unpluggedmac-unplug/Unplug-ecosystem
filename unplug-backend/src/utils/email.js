const nodemailer = require('nodemailer');

// Outgoing email, with two transports.
//
// HTTPS API (Resend or Brevo) is preferred and tried first, because hosts
// like Render commonly block outbound SMTP ports to stop spam — the symptom
// is a bare TCP "Connection timeout" that looks identical to a wrong host,
// which is very hard to diagnose. HTTPS on 443 is never blocked.
//
// SMTP stays supported for anywhere that allows it (and for local dev).
//
// If neither is configured we log the message instead of pretending to send
// it, same honesty pattern as the payment gateways.

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';

const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;

// Port 465 is implicit TLS (encrypted from the first byte); 587 and 25 start
// in the clear and upgrade via STARTTLS. Getting this wrong doesn't produce a
// helpful error — it just hangs — so derive it from the port.
const SMTP_SECURE = process.env.SMTP_SECURE
  ? process.env.SMTP_SECURE === 'true'
  : SMTP_PORT === 465;

const DEFAULT_FROM = process.env.SMTP_FROM || 'Unplug Magazine <no-reply@unplugnews.com>';

// "Name <address@x>" → { name, address }, which the HTTP APIs want split.
function parseFrom(value) {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
  if (match) return { name: match[1] || 'Unplug Magazine', address: match[2] };
  return { name: 'Unplug Magazine', address: value.trim() };
}

let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // Nodemailer's defaults let a blocked port hang for minutes.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}

function activeProvider() {
  if (RESEND_API_KEY) return 'resend';
  if (BREVO_API_KEY) return 'brevo';
  if (transporter) return 'smtp';
  return null;
}

const provider = activeProvider();
if (provider === 'smtp') {
  console.log(`[email] Using SMTP: ${process.env.SMTP_HOST}:${SMTP_PORT} (secure=${SMTP_SECURE})`);
} else if (provider) {
  console.log(`[email] Using ${provider} HTTPS API.`);
} else {
  console.warn('[email] No email provider configured. Verification codes and password resets will be logged, not sent.');
}

function isConfigured() {
  return provider !== null;
}

// Safe to show an admin — never includes a key or password.
function config() {
  return {
    provider,
    host: provider === 'smtp' ? process.env.SMTP_HOST || null : null,
    port: provider === 'smtp' ? SMTP_PORT : 443,
    secure: provider === 'smtp' ? SMTP_SECURE : true,
    user: provider === 'smtp' ? process.env.SMTP_USER || null : null,
    from: DEFAULT_FROM,
  };
}

async function sendViaResend({ to, subject, text }) {
  const from = parseFrom(DEFAULT_FROM);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: `${from.name} <${from.address}>`, to: [to], subject, text }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend rejected the message (${res.status}): ${detail.slice(0, 300)}`);
  }
  return { provider: 'resend' };
}

async function sendViaBrevo({ to, subject, text }) {
  const from = parseFrom(DEFAULT_FROM);
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { name: from.name, email: from.address },
      to: [{ email: to }],
      subject,
      textContent: text,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Brevo rejected the message (${res.status}): ${detail.slice(0, 300)}`);
  }
  return { provider: 'brevo' };
}

// Confirms the transport works without sending anything. For the HTTP APIs
// there's no "connect" step, so we check the key is accepted instead — a
// wrong key is the realistic failure there, not an unreachable host.
async function verifyConnection() {
  if (!provider) throw new Error('No email provider is configured on this server.');
  if (provider === 'smtp') {
    await transporter.verify();
    return true;
  }
  if (provider === 'resend') {
    const res = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
    });
    if (res.status === 401 || res.status === 403) throw new Error('Resend rejected the API key.');
    if (!res.ok) throw new Error(`Resend returned ${res.status}.`);
    return true;
  }
  const res = await fetch('https://api.brevo.com/v3/account', { headers: { 'api-key': BREVO_API_KEY } });
  if (res.status === 401 || res.status === 403) throw new Error('Brevo rejected the API key.');
  if (!res.ok) throw new Error(`Brevo returned ${res.status}.`);
  return true;
}

async function sendEmail({ to, subject, text }) {
  if (!provider) {
    console.warn('[email] No provider configured — logging instead of sending.');
    console.log(`[email] To: ${to}\n[email] Subject: ${subject}\n[email] Body:\n${text}`);
    return { simulated: true };
  }
  if (provider === 'resend') return sendViaResend({ to, subject, text });
  if (provider === 'brevo') return sendViaBrevo({ to, subject, text });
  return transporter.sendMail({ from: DEFAULT_FROM, to, subject, text });
}

module.exports = { sendEmail, isConfigured, verifyConnection, config };
