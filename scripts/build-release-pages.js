'use strict';

// The legacy frontend builder deliberately uses an explicit page allow-list.
// These later release pages must therefore be packaged after build.js has
// created dist/, otherwise a clean Cloudflare Pages deployment silently drops
// them. Keep this additive instead of destabilising the older builder.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist');
const ASSETS = path.join(OUT, 'assets');
const PAGES = [
  'unplug-agreement.html',
  'unplug-agreements-admin.html',
  'unplug-agreement-generator.html',
  'unplug-agreement-generator-admin.html',
  '404.html',
  'not-found.html',
];
const RUNTIME_ISOLATED_GENERATOR = new Set([
  'unplug-agreement-generator.html',
  'unplug-agreement-generator-admin.html',
]);

function hash(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 10);
}

function writeAsset(base, ext, content) {
  fs.mkdirSync(ASSETS, { recursive: true });
  const name = `${base}-${hash(content)}.${ext}`;
  fs.writeFileSync(path.join(ASSETS, name), content);
  return `/assets/${name}`;
}

function injectRuntimeIsolation(file, html) {
  if (!RUNTIME_ISOLATED_GENERATOR.has(file)) return html;

  // Defence in depth. /runtime-config is still the normal source of truth, but
  // the host-scoped guard makes the release-candidate pages fail closed even if
  // runtime-config is delayed/blocked/omitted. It is a no-op on production.
  const guard = '<script src="/media/scripts/staging-runtime-guard.js"></script>';
  if (!html.includes('src="/media/scripts/staging-runtime-guard.js"')) {
    html = html.replace('<head>', `<head>\n  ${guard}`);
  }
  if (!html.includes('src="/runtime-config"')) {
    html = html.replace(guard, `${guard}\n  <script src="/runtime-config"></script>`);
  }
  if (!html.includes('src="/unplug-shared.js"')) {
    html = html.replace('<script>', '<script src="/unplug-shared.js"></script>\n<script>');
  }

  for (const required of [
    'src="/media/scripts/staging-runtime-guard.js"',
    'src="/runtime-config"',
    'src="/unplug-shared.js"',
  ]) {
    if (!html.includes(required)) throw new Error(`Agreement Generator runtime isolation injection failed: ${file} missing ${required}`);
  }
  return html;
}

async function packagePage(file) {
  const src = path.join(ROOT, file);
  if (!fs.existsSync(src)) throw new Error(`Missing required release page: ${file}`);
  let html = fs.readFileSync(src, 'utf8');
  const base = file.replace(/\.html$/, '').replace(/[^a-z0-9_-]+/gi, '-');

  html = injectRuntimeIsolation(file, html);

  let styleIndex = 0;
  for (const match of [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]) {
    const css = match[1];
    if (css.trim().length < 500) continue;
    const transformed = await esbuild.transform(css, {
      loader: 'css', minify: true, sourcefile: `${base}.css`,
    });
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

  if (RUNTIME_ISOLATED_GENERATOR.has(file)) {
    for (const required of [
      'src="/media/scripts/staging-runtime-guard.js"',
      'src="/runtime-config"',
      'src="/unplug-shared.js"',
    ]) {
      if (!html.includes(required)) throw new Error(`Packaged Agreement Generator page lost runtime isolation: ${file} missing ${required}`);
    }
  }

  fs.writeFileSync(path.join(OUT, file), html);
  console.log(`[release-build] packaged ${file}`);
}

async function main() {
  if (!fs.existsSync(OUT)) throw new Error('dist/ does not exist; run build.js first.');
  for (const page of PAGES) await packagePage(page);
}

main().catch((err) => {
  console.error('[release-build] failed:', err.message);
  process.exit(1);
});
