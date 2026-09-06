# Phase 12 Release Manifest

Release type: **Staging-ready release candidate — not production approved**

Generated: 6 September 2026

## Critical staging files
- `functions/runtime-config.js` — `678c95dea114af9e6136c8cf718777901f589d6e1623da0db33f41a220eb01ec`
- `unplug-shared.js` — `ba341f0badeafc2cd63045b2b90d8d8adc71394621530b9be515d1599d99de8e`
- `unplug-admin-dashboard.html` — `8102acd5ba049f38e3c03f51c779d5aab1297b0ae87cb20890850b6d81121f3c`
- `unplug-member-dashboard.html` — `44b941123e567474184c2fd3a83c42d21ae9efe6f3a8faae86cc2b747ce5b0c5`
- `unplug-magazine.html` — `3507d07e39c832e907a9774ad161454e6c7ef4bdafae8e51c783b82e6399081b`
- `build.js` — `62ce49fe80b04e8069fde3d59e7081ce1acb2dded446538a682dce2762b209ce`
- `_headers` — `2e6281695a61fbaa6560ba10d3d95d352e5b4e086db49140589ccd5c74196a62`
- `functions/[[path]].js` — `bfda60438f0be412b767b4e7ff5dc33a6febf0079049d7a2e1899c06a925347b`
- `unplug-backend/scripts/staging-readiness.js` — `9006add2573e473fb252a570b05eae18637135e73b8b9af24d7b5573c72c96fc`
- `unplug-backend/.env.staging.example` — `ee1ee972ff71ed25c942e870f66689ba8ecce52aa6d0c6770bf89b416b125e0f`
- `STAGING-DEPLOYMENT-RUNBOOK.md` — `660989cae179fcdaaaaaf2d707319771e222b0031a0d42a4e19eab156798f58b`
- `STAGING-SMOKE-TEST-MATRIX.md` — `520f6ad339b67cbf0ad9f7d0aa96b06040d6ccfadc037332647b07be39a58d67`
- `PRODUCTION-ROLLBACK-PLAN.md` — `17b6d291692732c41659b2ebbf2b3929c80ad680fa444a4398ee55c494701028`

## Local verification
- Frontend staging safety check: PASS
- Runtime-config ES module syntax: PASS
- Modified shared/public JavaScript syntax: PASS
- Admin Dashboard inline JavaScript syntax: PASS
- Member Dashboard inline JavaScript syntax: PASS
- Public Magazine inline JavaScript syntax: PASS
- Checkout inline JavaScript syntax: PASS
- Phase 10 commercial static tests: 5/5 PASS
- Phase 11 production-readiness static tests: 3/3 PASS
- Safe staging preflight test: PASS
- Unsafe staging preflight negative test: correctly FAILS CLOSED

## Still required on real staging
- npm dependency installation and production frontend build
- Full PostgreSQL-backed test suite
- Migrations against isolated staging PostgreSQL
- Render database readiness
- Resend/storage staging credentials
- Full smoke-test matrix
