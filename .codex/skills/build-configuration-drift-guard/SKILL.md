---
name: build-configuration-drift-guard
description: Audit and harden Unplug frontend or backend releases when build settings, branch-to-project routing, generated artifacts, or deployed runtime identity could drift. Use before staging or production promotion and when CI is green but the deployed site behaves differently.
---

# Build Configuration Drift Guard

Prevent a provider from successfully publishing the wrong build, branch, project, or output directory.

## Required evidence

Treat a release as blocked until these four layers agree on one commit:

1. Repository contract: read `deploy/build-config.contract.json` and identify the intended target.
2. Reproducible build: install from the lockfile, run `npm run verify:build-config`, then `npm run build`.
3. Provider result: confirm the actual provider project, source branch, full SHA, build command, root, output directory, and deploy status.
4. Runtime artifact: request the immutable deployment URL and verify `build-contract.json`, critical assets, and representative user interactions.

Do not substitute a green CI check, provider “success”, HTTP 200, or a mutable branch alias for any missing layer.

## Target rules

- Keep staging and production as separate named targets. Never assume they use the same Cloudflare Pages project or Render service.
- Derive the expected target from the actual branch and compare it with provider-supplied deployment metadata.
- Route every non-production preview branch to staging; never allow one to match production.
- Require the published marker's `sourceCommit` to equal the candidate's full SHA.
- Validate the immutable preview before any mutable alias or production hostname.
- Keep production untouched until the exact staging SHA passes CI, provider, API, and browser gates.

## Drift handling

If repository and provider settings disagree, stop promotion and report both observed values. Determine whether the contract or provider is intentionally authoritative, update one source through a reviewable change, rebuild, and repeat all four layers. Never weaken CSP, skip packaging, or point the provider at raw source to make a failing artifact appear healthy.

For this repository, the deterministic checks are implemented by:

- `deploy/build-config.contract.json`
- `scripts/verify-build-configuration.js`
- `.github/workflows/build-configuration-gate.yml`

Do not print secret values while inspecting environment configuration. Report only presence, target identity, pass/fail evidence, and safe diagnostics.

## Release result

Record the candidate SHA, target project/service, immutable URL, CI conclusions, runtime marker, route checks, and any blocker in `docs/UNPLUG-RELEASE-STATE.md`. Do not say `VERIFIED LIVE` unless the public production application has also passed the release gatekeeper.
