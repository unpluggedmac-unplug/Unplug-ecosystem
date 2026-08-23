#!/usr/bin/env node
//
// Production build: minify, hash, and lift the inline code out of the HTML.
//
//   node build.js            build into dist/
//   node build.js --check    build, then report what changed in size
//
// WHAT THIS SOLVES, in the order it matters:
//
//   1. CACHING. unplug-magazine.html was 701 KB, of which 287 KB was inline
//      JavaScript and 97 KB inline CSS. Code inside an HTML file cannot be
//      cached separately from the page, and the page must be revalidated on
//      every visit because stories change. So every reader re-downloaded the
//      entire application on every visit. Lifted out and hashed, that code is
//      fetched once and then cached for a year.
//
//   2. CONTENT SECURITY POLICY. A meaningful CSP cannot allow inline scripts.
//      No amount of nonce plumbing changes that for the 213 onclick attributes
//      this site carries — but getting the big script blocks out of the HTML is
//      the necessary first half of the job, and it is this step.
//
//   3. SIZE. Minification is the least of it: roughly 30 KB across the shared
//      modules. Worth having, but it is the caching that moves the needle.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//
//   - It does not introduce a framework, a bundler config format, or a module
//     system. The inline scripts run in global scope and rely on it; wrapping
//     them in modules would break every onclick handler on the site.
//   - It does not touch the source files. They stay exactly as they are and
//     remain what a developer opens, edits and loads directly from disk.
//   - It does not minify the JSON-LD block. That is data describing the
//     publication, not code, and it is small.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const esbuild = require('esbuild');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'dist');
const ASSETS = path.join(OUT, 'assets');

// The pages that carry inline code.
const PAGES = [
  'unplug-magazine.html',
  'unplug-admin-dashboard.html',
  'unplug-member-dashboard.html',
  'unplug-checkout.html',
  'unplug-vote.html',
  'index.html',
  'offline.html',
];

// The shared modules, minified individually rather than bundled together.
//
// They are NOT concatenated: each declares globals the others and the inline
// page code depend on, load order is significant, and a single bundle would
// mean any one-line change re-downloads all of them. Separate hashed files
// keep the cache granular.
const MODULES = [
  'unplug-shared.js', 'unplug-seo-schema.js', 'unplug-responsive-images.js',
  'unplug-participation-sdk.js', 'i18n.js', 'accessibility.js',
  'chatbot.js', 'image-upload.js',
];

// Copied through untouched.
const STATIC = ['sw.js', 'manifest.webmanifest', 'robots.txt', '_headers', '_redirects'];
const STATIC_DIRS = ['icons', 'media', 'functions'];

function hash(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 10);
}

function kb(n) { return (n / 1024).toFixed(0) + ' KB'; }

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

function copyDir(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

// Writes content to assets/ under a name carrying its content hash, and
// returns the public path. The hash is what makes a one-year cache safe: a
// changed file is a changed URL, so a cached copy can never be stale.
function writeAsset(baseName, ext, content) {
  const name = `${baseName}-${hash(content)}.${ext}`;
  fs.writeFileSync(path.join(ASSETS, name), content);
  return `/assets/${name}`;
}

async function minifyJs(code, name) {
  const out = await esbuild.transform(code, {
    loader: 'js', minify: true,
    // The inline page code runs in global scope and every onclick attribute in
    // the HTML calls into it by name. Renaming a top-level function would
    // break every one of those, silently, at the moment a reader clicks.
    keepNames: true,
    target: ['es2018'],
    sourcefile: name,
  });
  for (const w of out.warnings || []) console.warn(`  ! ${name}: ${w.text}`);
  return out.code;
}

async function minifyCss(code, name) {
  const out = await esbuild.transform(code, { loader: 'css', minify: true, sourcefile: name });
  return out.code;
}

// Pulls the inline <style> and <script> blocks out of one page, replacing each
// with a link to a hashed file.
async function buildPage(file, report) {
  const srcPath = path.join(ROOT, file);
  if (!fs.existsSync(srcPath)) return;
  let html = fs.readFileSync(srcPath, 'utf8');
  const before = Buffer.byteLength(html);
  const base = file.replace(/\.html$/, '');

  // --- CSS ------------------------------------------------------------------
  // Replaced in place rather than moved to <head>, so the order in which rules
  // arrive relative to anything else is unchanged.
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)];
  for (let i = 0; i < styles.length; i++) {
    const [full, css] = styles[i];
    if (css.trim().length < 500) continue; // a handful of rules is not worth a request
    const min = await minifyCss(css, `${base}.css`);
    const url = writeAsset(`${base}${styles.length > 1 ? '-' + i : ''}`, 'css', min);
    html = html.replace(full, `<link rel="stylesheet" href="${url}">`);
    report.css += Buffer.byteLength(css) - Buffer.byteLength(min);
  }

  // --- JS -------------------------------------------------------------------
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  let n = 0;
  for (const [full, attrs, code] of scripts) {
    if (/\ssrc=/.test(attrs)) continue;          // already external
    if (/type\s*=\s*["']application\/ld\+json/.test(attrs)) continue; // data, not code
    if (code.trim().length < 500) continue;      // a few lines is not worth a request
    const min = await minifyJs(code, `${base}.js`);
    const url = writeAsset(`${base}${n ? '-' + n : ''}`, 'js', min);
    // defer, not async: this code defines the functions the page's own markup
    // calls, and async would let it run before the DOM it touches exists.
    html = html.replace(full, `<script src="${url}" defer></script>`);
    report.js += Buffer.byteLength(code) - Buffer.byteLength(min);
    n++;
  }

  // --- Rewrite the shared module <script src> to the hashed copies -----------
  for (const [from, to] of Object.entries(report.moduleMap)) {
    html = html.split(`src="${from}"`).join(`src="${to}"`);
  }

  fs.writeFileSync(path.join(OUT, file), html);
  report.pages.push({ file, before, after: Buffer.byteLength(html) });
}

async function main() {
  console.log('Building production assets.\n');
  rmrf(OUT);
  fs.mkdirSync(ASSETS, { recursive: true });

  const report = { css: 0, js: 0, pages: [], moduleMap: {}, modules: [] };

  // Shared modules first — the pages need their hashed names.
  for (const m of MODULES) {
    const p = path.join(ROOT, m);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    const min = await minifyJs(src, m);
    const url = writeAsset(m.replace(/\.js$/, ''), 'js', min);
    report.moduleMap[m] = url;
    report.modules.push({ m, before: Buffer.byteLength(src), after: Buffer.byteLength(min) });
  }

  for (const page of PAGES) await buildPage(page, report);

  for (const f of STATIC) {
    if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
  }
  for (const d of STATIC_DIRS) copyDir(path.join(ROOT, d), path.join(OUT, d));

  // The source modules are copied through as well. Anything still asking for
  // /unplug-shared.js — a cached page, a bookmarklet, the service worker of a
  // reader who has not updated — keeps working instead of 404ing.
  for (const m of MODULES) {
    const p = path.join(ROOT, m);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(OUT, m));
  }

  console.log('Pages:');
  let totalBefore = 0; let totalAfter = 0;
  for (const p of report.pages) {
    totalBefore += p.before; totalAfter += p.after;
    console.log(`  ${p.file.padEnd(30)} ${kb(p.before).padStart(8)} -> ${kb(p.after).padStart(8)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(30)} ${kb(totalBefore).padStart(8)} -> ${kb(totalAfter).padStart(8)}`);
  console.log(`\n  ${kb(totalBefore - totalAfter)} moved out of the HTML into cacheable, hashed files.`);
  console.log(`  Minification saved ${kb(report.js)} of JavaScript and ${kb(report.css)} of CSS on top.`);
  console.log(`\nOutput: dist/`);
  console.log('The source files are untouched and still load directly from disk in development.');
}

main().catch((err) => {
  console.error('\nBuild failed:', err.message);
  process.exit(1);
});
