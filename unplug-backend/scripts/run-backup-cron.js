'use strict';

const https = require('https');

const endpoint = process.env.UNPLUG_BACKUP_CRON_URL
  || 'https://unplug-ecosystem.onrender.com/backups/scheduled-run';
const secret = process.env.UNPLUG_BACKUP_CRON_SECRET;

if (!secret) {
  console.error('UNPLUG_BACKUP_CRON_SECRET is not configured.');
  process.exit(1);
}

function post(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'X-Backup-Cron-Secret': secret,
        'Content-Type': 'application/json',
        'User-Agent': 'unplug-render-backup-cron/1.0',
      },
      timeout: 120000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body });
          return;
        }
        reject(new Error(`Backup endpoint returned HTTP ${res.statusCode}: ${body.slice(0, 500)}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Backup endpoint timed out.')));
    req.on('error', reject);
    req.end();
  });
}

post(endpoint)
  .then(({ statusCode, body }) => {
    const parsed = (() => {
      try { return JSON.parse(body); } catch (_) { return null; }
    })();
    const report = parsed && parsed.report;
    if (report && report.filename) {
      const destinations = Array.isArray(report.destinations)
        ? report.destinations.filter((d) => d && d.ok).map((d) => d.provider).join(', ')
        : '';
      console.log(
        `Backup completed (HTTP ${statusCode}): ${report.filename}, `
        + `${report.rows} rows${destinations ? ` to ${destinations}` : ''}.`
      );
    } else {
      console.log(`Backup completed (HTTP ${statusCode}).`);
    }
  })
  .catch((err) => {
    console.error('Scheduled backup failed:', err.message);
    process.exit(1);
  });
