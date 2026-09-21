# Next session — kickoff

Prepared 2026-09-21.

Start by reading `docs/FINAL-HANDOVER-2026-09-21.md`, then re-fetch current `main`, open PRs and the current Render production deploy before changing anything. Parallel sessions may have advanced the repository after the handover was written.

Current verified baseline at handover start:
- `main`: `e820d892b792957268b33cf07b7858b554299b99`
- PR #78 Admin Control Centre restructure released and visually validated; follow-up visual fixes #79–#82 also released
- PR #84 mobile POPIA overflow fix released
- PR #85 community email notifications merged
- PR #86 migration-deadlock retry hotfix released
- current full backend regression: 2,515 / 2,515 passing
- current production Render deploy healthy, migrations complete, readiness 200
- open PRs: 0 after superseded PR #83 was closed

Before starting new feature work, close the remaining operational/security items in this order:
1. GitHub repo must be made PRIVATE and `main` protected (manual GitHub repository-admin action; current connector cannot mutate visibility/rules).
2. Secure the published paid edition download.
3. Configure a reliable external recurring encrypted-backup schedule and verify restore.
4. Configure the Resend delivery/bounce/complaint webhook + Render signing secret.
5. Resync `staging-control-centre` to current production main and verify staging frontend/backend exact SHA.
6. Repoint the six remaining retired-Supabase URLs, then rerun storage audit to zero.
7. Review Supabase performance INFO findings only against real query evidence; do not bulk-apply indexes/PKs.

Release discipline stays unchanged:
exact-head CI → staging when applicable → production exact commit → migrations/readiness/logs → authenticated/visual verification for UI changes.
