#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
function read(p){ return fs.readFileSync(path.join(root,p),'utf8'); }
function ok(condition, message){ if(!condition){ console.error('FAIL:', message); process.exitCode=1; } else console.log('PASS:', message); }

const headers = read('_headers');
ok(!/^\s*Content-Security-Policy:/m.test(headers), '_headers does not duplicate enforced CSP');
ok(!/^\s*Content-Security-Policy-Report-Only:/m.test(headers), '_headers does not duplicate report-only CSP');

for (const file of ['index.html','unplug-admin-dashboard.html','unplug-member-dashboard.html','unplug-checkout.html','unplug-magazine.html','unplug-vote.html']) {
  ok(!/http-equiv=["']Content-Security-Policy["']/i.test(read(file)), `${file} has no duplicate meta CSP`);
}

const source = read('functions/_middleware.js');
ok(!source.includes('https://*.onrender.com'), 'CSP does not allow every Render tenant');
ok(source.includes('script-src-attr ${reportOnly ? "\'none\'" : "\'unsafe-inline\'"}'), 'only legacy script attributes retain unsafe-inline');
ok(source.includes('https://www.instagram.com'), 'Instagram embed script/frame source is allowed');
ok(source.includes('https://www.youtube.com'), 'YouTube iframe API/frame source is allowed');
ok(source.includes('https://w.soundcloud.com'), 'SoundCloud iframe source is allowed');
ok(source.includes("object-src 'none'"), 'plugin/object content is blocked');
ok(source.includes("frame-ancestors 'none'"), 'framing is blocked');
ok(source.includes("worker-src 'self' blob:"), 'service worker source is explicit');

// Staging must fail closed: exact staging origin yes, production origin no.
ok(source.includes("configured && configured !== PRODUCTION_API ? configured : ''"), 'staging CSP refuses production API fallback');

if (process.exitCode) process.exit(1);
