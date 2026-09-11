#!/usr/bin/env node
'use strict';

// Fail closed when repository build settings drift away from the deployment
// contract. This prevents a successful Cloudflare Pages deployment from
// publishing the raw source root instead of the CSP-safe dist/ artifact.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONTRACT_PATH = path.join(ROOT, 'deploy', 'build-config.contract.json');
const PACKAGE_PATH = path.join(ROOT, 'package.json');
const DIST = path.join(ROOT, 'dist');
const artifactMode = process.argv.includes('--artifact');
const failures = [];

function fail(message) { failures.push(message); }
function requireText(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

if (!fs.existsSync(CONTRACT_PATH)) fail('deploy/build-config.contract.json is missing');
if (!fs.existsSync(PACKAGE_PATH)) fail('package.json is missing from the Cloudflare project root');

const contract = fs.existsSync(CONTRACT_PATH) ? JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8')) : {};
const pkg = fs.existsSync(PACKAGE_PATH) ? JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8')) : {};
const frontend = contract.frontend || {};

requireText(frontend.provider, 'cloudflare-pages', 'frontend provider');
requireText(frontend.project, 'unplug-magazine', 'Cloudflare Pages project');
requireText(frontend.rootDirectory, '', 'Cloudflare root directory');
requireText(frontend.buildCommand, 'npm run build', 'Cloudflare build command');
requireText(frontend.outputDirectory, 'dist', 'Cloudflare build output directory');

const buildScript = String(pkg.scripts && pkg.scripts.build || '');
let previous = -1;
for (const step of frontend.pipelineSteps || []) {
  const index = buildScript.indexOf(step);
  if (index < 0) fail(`package.json build script is missing required step: ${step}`);
  if (index >= 0 && index <= previous) fail(`package.json build steps are out of contract order at: ${step}`);
  if (index >= 0) previous = index;
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!(frontend.supportedNodeMajors || []).includes(nodeMajor)) {
  fail(`Node ${nodeMajor} is outside supported build majors: ${(frontend.supportedNodeMajors || []).join(', ')}`);
}

for (const source of ['build.js', 'scripts/build-release-pages.js', 'scripts/build-growth-pages.js', 'scripts/verify-dist-assets.js']) {
  if (!fs.existsSync(path.join(ROOT, source))) fail(`required build source is missing: ${source}`);
}

if (artifactMode) {
  if (!fs.existsSync(DIST)) {
    fail('dist/ is missing after the production build');
  } else {
    for (const file of frontend.requiredArtifactFiles || []) {
      const target = path.join(DIST, file);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile() || fs.statSync(target).size === 0) {
        fail(`required production artifact is missing or empty: dist/${file}`);
      }
    }
    if (fs.existsSync(path.join(DIST, 'functions'))) {
      fail('dist/functions must not exist; Cloudflare Pages Functions compile from the repository root');
    }

    const marker = {
      schemaVersion: contract.schemaVersion,
      contractVersion: contract.contractVersion,
      project: frontend.project,
      outputDirectory: frontend.outputDirectory,
      sourceCommit: process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA || 'local'
    };
    fs.writeFileSync(path.join(DIST, 'build-contract.json'), JSON.stringify(marker, null, 2) + '\n');
  }
}

if (failures.length) {
  for (const message of failures) console.error(`[build-config] FAIL ${message}`);
  process.exit(1);
}

console.log(`[build-config] PASS contract ${contract.contractVersion}${artifactMode ? ' and production artifact' : ''}`);
console.log('[build-config] Cloudflare Pages must use root="", command="npm run build", output="dist".');
