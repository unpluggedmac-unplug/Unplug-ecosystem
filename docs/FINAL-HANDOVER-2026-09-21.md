# Unplug Ecosystem — Final Handover & Remaining-Site Audit

**Prepared:** 2026-09-21  
**Canonical production branch:** `main`  
**Current main SHA at handover start:** `e820d892b792957268b33cf07b7858b554299b99`  
**Current production Render deploy:** `dep-dao2u6btqb8s73b0fdt0` — LIVE  
**Production backend:** `https://unplug-ecosystem.onrender.com`

This document supersedes the stale operational wording in older handovers. Historical notes remain useful for context, but the state below is the current baseline verified on 2026-09-21.

---

## 1. Release state — PR #78 and follow-up visual fixes

### PR #78 — Admin Control Centre information architecture

PR #78 reorganised the Admin Control Centre into exactly 13 purpose-based primary groups while preserving existing routes, permissions, deep links, Growth/Agreement entry points, favourites, recents, breadcrumbs and mobile navigation.

Exact PR head: `eec0db52836de4384a9f9ed19899159700db7ae1`

Exact-head CI was fully green:
- Build configuration contract gate — PASS
- Backend regression CI — PASS
- Member Dashboard Control Centre CI — PASS
- Full backend suite on the exact PR head — **2,497 / 2,497 passing**, 0 failing, 0 skipped
- Member Dashboard regression suite — **43 / 43 passing**, 0 failing
- Packaged frontend/build-contract artifact check — PASS

PR #78 merged as:
`921dd9b60f4bc779b3064e3f9616e5a0ef97fa90`

Post-merge CI on the merge SHA also passed, including the full backend suite at **2,497 / 2,497**.

### Authenticated / visual production verification

The Admin Dashboard was visually checked in production after PR #78. That check confirmed the new 13-group structure was live and structurally correct, but it also exposed several small presentation issues. Those were fixed through the following production PRs:

- **PR #79** — Dashboard-root polish, breadcrumb wording, Recently Used cleanup, wide status-row balancing, first accessibility-placement correction.
- **PR #80** — accessibility control moved clear of dashboard content.
- **PR #81** — accessibility control structurally docked outside the navigation scroll area.
- **PR #82** — Admin sidebar made sticky / viewport-height so the accessibility footer, View Site link and account footer remain visible.

The visual gate therefore did not stop at “looks okay”; screenshot findings were converted into regression-protected fixes and released.

---

## 2. Subsequent production releases after the Admin visual gate

The current main branch is newer than PR #82.

### PR #84 — Mobile POPIA consent overflow
Fixed the remaining narrow-screen consent-card horizontal overflow without changing consent behaviour.

### PR #85 — Profile/community email notifications
Added preference-aware email delivery for profile Like/Dislike/Save/approved Comment/Review and Follow/Unfollow events while preserving existing in-app notification behaviour.

### PR #86 — Migration deadlock retry hardening
PR #85's first production instance hit PostgreSQL `40P01 deadlock detected` while replaying migration 204. The old production instance remained healthy. PR #86 added bounded retries for only PostgreSQL deadlock/serialization retry conditions and merged as:

`e820d892b792957268b33cf07b7858b554299b99`

Current production Render deploy:
`dep-dao2u6btqb8s73b0fdt0`

Current production evidence:
- deploy status: **LIVE**
- `All migrations applied.`
- repeated `GET /health/ready 200`
- no error-level Render log entries after the successful PR #86 deployment
- current-main backend regression: **2,515 / 2,515 passing**, 0 failing, 0 skipped
- current-main Member Dashboard regression: **43 / 43 passing**
- build-configuration artifact gate: PASS

The earlier failed PR #85 deploy remains visible in Render history with the expected deadlock error; it is historical evidence of the incident, not a current production failure.

---

## 3. GitHub repository security — HIGH PRIORITY MANUAL GATE

Fresh GitHub metadata on 2026-09-21 reports:

- repository visibility: **PUBLIC**
- current account permission: admin
- default branch: `main`
- `main` protected: **false**
- branch protection enforcement: **off**
- open PRs after cleanup: **0**
- stale draft PR #83 was closed because PR #84 already superseded and released it

A targeted tracked-file scan found the expected environment-variable names and examples, but the committed `.env.example` and `.env.staging.example` values are blank/placeholders rather than live credentials. This reduces immediate credential exposure but does **not** make a public application repository appropriate.

### Required manual GitHub action

The connected GitHub tool can read repository metadata and modify files/PRs, but it does not expose the repository-administration mutation needed to change visibility or branch protection. Therefore this cannot be completed safely from this chat connector.

Required owner action in GitHub Settings:
1. Change `unpluggedmac-unplug/Unplug-ecosystem` from **Public** to **Private**.
2. Add a rule/ruleset for `main` that blocks direct destructive updates and requires the release checks before merge.
3. At minimum require the Build configuration contract gate, Backend regression CI, and Member Dashboard Control Centre CI where applicable.
4. Keep force-push/deletion disabled for `main`.

Do not mark repository security closed until GitHub reports `private: true` and protection/rules are active.

---

## 4. Staging drift

Fresh branch audit:

- production `main`: `e820d892b792957268b33cf07b7858b554299b99`
- `staging-control-centre`: `8dc065638a4885c4be1f1884e42d36f7dc77556a`

Staging is therefore materially behind production.

This is not currently breaking the public site, but it makes staging unreliable as a pre-release replica. Before the next feature release, resync staging from current production main, then verify:
- Cloudflare staging source commit
- Render staging exact commit
- staging `/health/ready`
- no staging migration errors

Keep the existing backup branch for the old staging state until the resync is proven.

---

## 5. Database security and performance audit

Production Supabase project:
`jaywxegcxjgyqhcwzbte`

### Security advisor
Only one current security advisory remains:
- `rls_enabled_no_policy` on `public.share_card_requests` — INFO level

Fresh row count:
- `share_card_requests`: **0 rows**

RLS enabled with no policies means normal client roles have no permissive policy path. Do not add a permissive policy merely to silence the advisor. Review only if this table is intended for direct client access.

The previously addressed mutable-function-search-path and public `pg_trgm` findings are no longer present in the current security advisor output.

### Performance advisor
Current INFO-level technical debt:
- **178** unindexed foreign-key findings
- **370** no-primary-key findings
- **134** unused-index findings

Do **not** bulk-fix these. The advisor is heuristic and many findings may involve append-only/history/association tables where a blanket migration would add write cost or create unnecessary risk. Optimise based on real query/load evidence.

---

## 6. Supabase → R2 historical storage audit

A fresh production database scan was performed across all text/varchar columns whose names contain `url`, plus the generic `settings.value` column.

Remaining references to the retired Supabase project host:
`fkuzbwysvyskhsskjmmi`

**6 rows remain:**
- `project_sponsors.logo_url` — row IDs **1, 5, 6, 7, 8**
- `settings.value` — key **youtube_image_url**

These six URLs point to old Supabase Storage objects and should be re-uploaded/repointed to R2 or the current intended storage destination.

The earlier much larger historical migration backlog is therefore substantially reduced, but storage migration is **not yet fully clean**.

Do not delete the old Supabase project until these six references are remediated and a repeat audit returns zero.

---

## 7. Paid edition download security

Fresh production database state shows one published paid edition:

- edition id: **4**
- issue number: **1**
- title: **Upcomming Issue**
- download price: **R50.00**
- legacy/view PDF present: **yes**
- private download PDF present: **no**
- `download_secured_at`: **null**

This remains an actual operational security task.

Required Admin action:
**Admin → Editions → Secure this download file**

Do not remove the legacy/public URL until the private copy is known-good, because doing so could break an existing buyer flow.

---

## 8. Backup state

Render logs show one real successful backup execution:

`POST /backups/run 200` on **2026-09-16**

No additional `POST /backups/run` entries were found in the checked production log window.

This proves the encrypted application-level backup path worked at least once, but does **not** prove recurring backup coverage.

Current concern:
- the in-process scheduler waits for continuous runtime
- the free Render service can sleep/restart
- therefore a 24-hour in-process timer is not a reliable nightly backup guarantee

Required follow-up:
- use an external scheduler/cron that calls the protected backup endpoint on a defined cadence
- confirm `UNPLUG_BACKUP_PASSPHRASE` and persistent external storage are configured
- verify a new backup object is actually produced on schedule
- perform a controlled restore test before calling disaster recovery complete

---

## 9. Email / Resend operational audit

Resend domain state:
- `unplugnews.com`: **verified**
- sending: **enabled**
- region: EU West
- open tracking: off
- click tracking: off

Resend currently has **0 webhooks configured**.

The backend already exposes:
`POST https://unplug-ecosystem.onrender.com/email/webhooks/resend`

Expected events:
- `email.delivered`
- `email.bounced`
- `email.complained`

Required operational setup:
1. Create the Resend webhook for the production endpoint.
2. Subscribe to the three events above.
3. Put the generated `whsec_...` value into Render as `RESEND_WEBHOOK_SECRET`.
4. Verify one signed webhook is accepted.

Until this is configured, outbound mail still sends, but bounce/complaint feedback cannot reliably suppress dead/problem addresses through the implemented webhook path.

---

## 10. Remaining intentional/manual business checks

Still worth doing before treating every commercial workflow as fully proven in the field:

- secure the paid edition download
- check the first few consultant commission/payout attributions by hand
- run a representative Admin Approval Queue end-to-end check on real/controlled records
- keep PayFast/Ozow disabled until real merchant credentials/accounts exist
- revisit the leaderboard dependency on Directory listing membership only if product policy changes

These are not current CI failures.

---

## 11. Current release quality baseline

At this handover:
- current main full backend regression: **2,515 / 2,515 PASS**
- Member Dashboard regression: **43 / 43 PASS**
- production Render: **LIVE**
- production readiness endpoint: repeated **HTTP 200**
- migrations: **completed**
- no new production error-level logs after PR #86
- open PRs: **0**
- stale PR #83: **closed**
- production DB security advisor: no error/warning-level findings; one INFO RLS/no-policy item
- current critical operational risks are configuration/ops items, not a known failing production test suite

---

## 12. Priority order from here

**P0 — owner/security**
1. Make the GitHub repository private.
2. Protect `main`.

**P1 — production operational safety**
3. Secure the paid edition download.
4. Configure recurring external encrypted backups and verify restore.
5. Configure the Resend delivery/bounce/complaint webhook.

**P1 — environment consistency**
6. Resync `staging-control-centre` to the current production baseline and verify both staging deployments.

**P2 — storage cleanup**
7. Repoint the remaining six retired-Supabase URLs, then rerun the storage audit to zero.

**P3 — measured performance work**
8. Review Supabase performance advisor findings against actual slow queries before adding/removing indexes or primary keys.

---

## 13. Next-session rule

Before any new product feature is built:
1. Read this handover.
2. Re-fetch `main` because parallel sessions may have advanced it.
3. Re-check open PRs and current production deploy.
4. Do not assume staging matches production.
5. Do not declare repository security complete until GitHub itself reports private/protected.
6. Preserve the release discipline: exact-head CI → staging where needed → production deploy → readiness/log verification → visual/authenticated check for UI releases.

