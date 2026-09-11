'use strict';

// Production build closure check.
//
// A Cloudflare Pages deployment can return HTTP 200 while still being broken
// if an HTML file references a local script/stylesheet that was never copied
// into dist. That is exactly how the floating Site Buttons disappeared once
// Production was correctly switched from raw source to dist.
//
// This verifier runs AFTER every release/growth page packager, then fails the
// production build if:
//   1. a local JS/CSS/manifest asset referenced by packaged HTML is missing;
//   2. executable inline <script> remains, because the enforced CSP blocks it.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const DYNAMIC_LOCAL_PATHS = new Set([
  '/runtime-config', // Cloudflare Pages Function, not a static dist file.
]);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function localAssetPath(raw) {
  if (!raw) return null;
  const value = raw.trim();
  if (!value || value.startsWith('#') || value.startsWith('data:') || value.startsWith('blob:') || value.startsWith('//')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;

  const pathname = value.split('#')[0].split('?')[0];
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
  if (DYNAMIC_LOCAL_PATHS.has(normalized)) return null;

  const ext = path.extname(normalized).toLowerCase();
  if (!['.js', '.css', '.webmanifest'].includes(ext)) return null;
  return normalized.replace(/^\/+/, '');
}

if (!fs.existsSync(DIST)) {
  console.error('[dist-verify] dist/ does not exist. Run the production build first.');
  process.exit(1);
}

const htmlFiles = walk(DIST).filter((p) => p.endsWith('.html'));
const missing = [];
const inline = [];

for (const file of htmlFiles) {
  const rel = path.relative(DIST, file).split(path.sep).join('/');
  const html = fs.readFileSync(file, 'utf8');

  // Executable inline scripts are incompatible with the enforced production
  // CSP. JSON-LD is data and intentionally exempt.
  for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = match[1] || '';
    const code = match[2] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (/type\s*=\s*["']application\/ld\+json/i.test(attrs)) continue;
    if (!code.trim()) continue;
    inline.push({ file: rel, bytes: Buffer.byteLength(code) });
  }

  // Script src attributes.
  for (const match of html.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const asset = localAssetPath(match[1]);
    if (asset && !fs.existsSync(path.join(DIST, asset))) missing.push({ file: rel, asset });
  }

  // Stylesheets/manifests. Other links (canonical, icons served by a folder,
  // navigation URLs) are intentionally outside this static dependency check.
  for (const match of html.matchAll(/<link([^>]+)>/gi)) {
    const attrs = match[1] || '';
    const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    if (!/\brel\s*=\s*["'][^"']*(stylesheet|manifest)[^"']*["']/i.test(attrs)) continue;
    const asset = localAssetPath(hrefMatch[1]);
    if (asset && !fs.existsSync(path.join(DIST, asset))) missing.push({ file: rel, asset });
  }
}

console.log(`[dist-verify] HTML pages checked: ${htmlFiles.length}`);
console.log(`[dist-verify] missing local assets: ${missing.length}`);
console.log(`[dist-verify] executable inline scripts: ${inline.length}`);

if (missing.length) {
  for (const item of missing) console.error(`[dist-verify] MISSING ${item.file} -> /${item.asset}`);
}
if (inline.length) {
  for (const item of inline) console.error(`[dist-verify] INLINE SCRIPT ${item.file} (${item.bytes} bytes)`);
}

if (missing.length || inline.length) process.exit(1);
console.log('[dist-verify] PASS — packaged HTML is closed over its local executable/style assets and CSP-safe.');
