'use strict';

// The legacy production builder has an explicit page allow-list. Keep Growth
// packaging isolated here so Growth pages cannot silently disappear from
// Cloudflare Pages output while the broader builder remains stable.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist');
const ASSETS = path.join(OUT, 'assets');

// Keep legacy pages in the artifact as a rollback path during staged rollout.
// V2 links point only to the V2 pages; legacy pages are not deleted here.
const PAGES = [
  'unplug-growth-application.html',
  'unplug-growth-applications-admin.html',
  'unplug-growth-application-v2.html',
  'unplug-growth-applications-admin-v2.html',
];
const COPY = [
  'growth-integration.js',
  'growth-private-upload-helper.js',
  'growth-admin-builder-helper.js',
];

function hash(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 10);
}

function writeAsset(base, ext, content) {
  fs.mkdirSync(ASSETS, { recursive: true });
  const name = `${base}-${hash(content)}.${ext}`;
  fs.writeFileSync(path.join(ASSETS, name), content);
  return `/assets/${name}`;
}

async function buildPage(file) {
  const src = path.join(ROOT, file);
  if (!fs.existsSync(src)) throw new Error(`Missing Growth page: ${file}`);
  let html = fs.readFileSync(src, 'utf8');
  const base = file.replace(/\.html$/, '');

  let styleIndex = 0;
  for (const match of [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]) {
    const css = match[1];
    if (css.trim().length < 500) continue;
    const transformed = await esbuild.transform(css, { loader: 'css', minify: true, sourcefile: `${base}.css` });
    const url = writeAsset(`${base}-style${styleIndex++}`, 'css', transformed.code);
    html = html.replace(match[0], `<link rel="stylesheet" href="${url}">`);
  }

  let scriptIndex = 0;
  for (const match of [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]) {
    const attrs = match[1];
    const code = match[2];
    if (/\ssrc=/.test(attrs)) continue;
    if (/type\s*=\s*["']application\/ld\+json/.test(attrs)) continue;
    if (code.trim().length < 500) continue;
    const transformed = await esbuild.transform(code, {
      loader: 'js', minify: true, keepNames: true, target: ['es2018'], sourcefile: `${base}.js`,
    });
    const url = writeAsset(`${base}-script${scriptIndex++}`, 'js', transformed.code);
    html = html.replace(match[0], `<script src="${url}" defer></script>`);
  }

  if (file === 'unplug-growth-applications-admin-v2.html') {
    const helpers = [
      '<script src="/growth-private-upload-helper.js" defer></script>',
      '<script src="/growth-admin-builder-helper.js" defer></script>',
    ].join('\n');
    html = html.includes('</body>') ? html.replace('</body>', `${helpers}\n</body>`) : `${html}\n${helpers}`;
  }

  fs.writeFileSync(path.join(OUT, file), html);
  console.log(`[growth-build] packaged ${file}`);
}

async function main() {
  if (!fs.existsSync(OUT)) throw new Error('dist/ does not exist; run the main frontend build first.');
  for (const page of PAGES) await buildPage(page);
  for (const file of COPY) {
    const src = path.join(ROOT, file);
    if (!fs.existsSync(src)) throw new Error(`Missing Growth integration asset: ${file}`);
    fs.copyFileSync(src, path.join(OUT, file));
    console.log(`[growth-build] copied ${file}`);
  }
}

main().catch((err) => {
  console.error('[growth-build] failed:', err.message);
  process.exit(1);
});