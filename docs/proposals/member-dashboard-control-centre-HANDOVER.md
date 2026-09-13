# UNPLUG Member Dashboard Control Centre — Handover

**Date:** 2026-09-13  
**Repository:** `unpluggedmac-unplug/Unplug-ecosystem`  
**Working branch:** `feature/member-dashboard-control-centre-20260913`  
**Shared staging branch:** `staging-control-centre`

## Lane ownership

- Claude lane: Admin Dashboard.
- ChatGPT lane: Member Dashboard.
- Keep the lanes isolated while both are changing.
- Bring them together only at the shared staging gate.
- Do **not** push these Member Dashboard changes directly to production.

## User-approved direction

Selections received:

`1A, 2C, 3A, 4A, 5C, 6A, 7A, 8A, 9A, 10A, 11A, 12B, 13A, 14B, 15A, 16A, 17A, 18A, 19A, 20A, 21A, 22A, 23A, 24A, 25A, 26A, 27A, 28A, 29A, 30A, 31A, 32A, 33A, 34A, 35A, 36A, 37A, 38A, 39A, 40C`

The guiding product statement is:

> **My personal Unplug home — identity, growth, participation, opportunities, services and progress in one place.**

## Implementation principle

The current `unplug-member-dashboard.html` remains the source of truth for the member features, API calls and loaders. The Control Centre layer reorganises and activates those existing functions rather than creating a second member data model.

The original `.ms-navlink[data-ms]` controls are retained and hidden as source controls after the hierarchy initialises. The new hierarchy calls those source controls so existing loaders, permissions, payment behaviour and member flows continue to run.

## Member hierarchy

### Home
- Dashboard
- Action Required
- Recent Activity
- Quick Actions
- Root-level Notifications quick access

### My Identity
- Directory Profile
- My Unplug Community Profile
- Preview as Public
- Profile Completion
- My Analytics

### My Unplug Journey
- Status & Score
- Today's Missions
- This Week's Mission
- This Month's Challenge
- Achievements
- Unplug Passport
- Leaderboard
- Referral Progress

### My Growth
Shown only when the existing Growth placement is available.

- Growth Journey Overview
- Growth Application
- Quick Profile
- Growth Assessment
- Deep Discovery
- Tasks
- Progress
- Reports

Current implementation routes these entries to the existing member Growth Journey rather than inventing backend pages that do not exist.

### My Content
- My Submissions
  - My Articles
  - My Events
  - My Listings
  - My Advertising
  - My Competitions
- Reading List
- My Editions

Submission statuses remain inside the content views, per selection 12B; they are not expanded into another sidebar level.

### Services
- Browse Services
- My Services
- Create / Submit

Individual services are intentionally not dumped into the sidebar. Members use Browse Services, Quick Create, favourites and Recently Used.

### Money & Purchases
- My Orders
- Payments
- My Credits
- My Invoices
- My Votes

Do not create fake Voucher or Receipt workspaces simply to satisfy a label. Existing payment/order/invoice data remains the source of truth until a dedicated member-facing voucher/receipt workspace actually exists.

### Agreements
Role/access aware.

- My Agreements
- Awaiting My Signature
- Signed
- Completed
- Archived
- Available Agreements

Status shortcuts filter the already rendered agreement workspace and do not create a second agreement API.

### Community
- Notifications
- My Referrals, when entitled
- My Clients, when entitled

People I Follow / Followers / Saved Profiles / Reviews should only become dedicated navigation destinations when real member-facing workspaces exist. Do not add dead menu items.

### Account & Privacy
- Account Settings
- Your Data
- Download My Data
- View Official Site
- Logout

Existing Account Settings already contains password/sign-in controls, notification preferences and two-factor controls. Dedicated Login & Security / Communication Preferences subroutes may be added later only if they remain wired to these real controls.

## Member Home

The new Home layer provides:

- personalised next-step recommendation;
- profile-completion card;
- My Unplug Journey card;
- Growth card when Growth is enabled;
- submissions count;
- credit balance;
- agreements count when available;
- notification count;
- action-required count;
- Quick Create;
- quick actions;
- recent activity;
- collapsible panels with remembered state;
- profile checklist mirroring `muCompletionPct` + `muCompletionTodo`;
- an Unplug Path that visually connects Identity → Participate → Grow → Opportunities.

## Navigation behaviour

- Branch title can open its overview.
- Separate arrow expands/collapses children.
- Accordion state is remembered in localStorage.
- Favourites are remembered.
- Last five recently used areas are remembered.
- Search covers member navigation plus rendered services and submissions.
- Breadcrumbs and Back-to-parent are provided.
- Existing mobile sidebar/drawer behaviour is preserved.
- Conditional Agreement / Referral / Client areas stay conditional.

## Accessibility work

`member-dashboard-control-centre-polish.js` adds:

- `aria-expanded` and `aria-controls` to expandable navigation;
- `aria-current` to active destinations;
- accessible collapsed Home panels;
- search labels and Escape-to-clear;
- modal dialog semantics for Quick Create;
- Escape-to-close Quick Create;
- keyboard focus styles in the polish CSS.

## Files added

- `media/scripts/member-dashboard-control-centre.js`
- `media/scripts/member-dashboard-control-centre-polish.js`
- `media/styles/member-dashboard-control-centre.css`
- `media/styles/member-dashboard-control-centre-help.css`
- `media/styles/member-dashboard-control-centre-polish.css`
- `unplug-backend/test/memberDashboardControlCentre.test.js`
- this handover file

## Shared file currently modified on this feature branch

- `functions/runtime-config.js`

It currently loads the Member Dashboard Control Centre assets only when the path contains `unplug-member-dashboard`.

### Critical merge warning

While this member lane was being built, `staging-control-centre` continued moving and changed both:

- `functions/runtime-config.js`
- `unplug-member-dashboard.html`

At the latest comparison during this work, the member feature branch was behind staging and the branches had diverged.

**Do not overwrite the latest staging versions with the older feature-branch copies.**

When Claude finishes the Admin lane:

1. take the newest `staging-control-centre` state;
2. preserve its newest Admin Dashboard/runtime/member-page changes;
3. re-apply only the Member Dashboard asset loader needed for these files;
4. do not restore Admin runtime lines that staging intentionally removed;
5. resolve any member-page changes by preserving both current functionality and the Control Centre layer;
6. then run tests and deploy to staging.

## Regression test

`unplug-backend/test/memberDashboardControlCentre.test.js` statically checks:

- JavaScript syntax parsing;
- member-only path guards;
- reuse of native member source controls;
- approved hierarchy groups;
- root + Community Notifications access;
- compact Services behaviour;
- search / favourites / recent / breadcrumbs / persistence;
- personalised Home;
- profile checklist reuse of existing completion state;
- Identity → Participation → Growth → Opportunities bridge;
- role-aware areas;
- agreement status shortcuts;
- accessibility hooks;
- mobile CSS;
- reuse of Unplug brand tokens.

The test is included by the backend's existing `node --test --test-concurrency=1 "test/**/*.test.js"` command.

## Status at handover

- ✅ Separate Member Dashboard branch created.
- ✅ Main hierarchical Member Dashboard layer added.
- ✅ Member Home added.
- ✅ Search / favourites / recent / breadcrumbs / Back added.
- ✅ Quick Create added.
- ✅ Conditional Agreement / Growth / Referral / Client behaviour preserved.
- ✅ Root-level Notifications quick access added while keeping Notifications inside Community.
- ✅ Profile checklist added from existing completion state.
- ✅ Growth + gamification/participation bridge added.
- ✅ Accessibility polish added.
- ✅ Regression test file added.
- 🟡 Full repository CI has not yet been confirmed on this branch.
- 🟡 Browser/UI validation has not yet been completed.
- 🟡 Latest staging changes have not yet been reconciled because the Admin lane is still moving.
- ❌ Production merge/deploy has not started.

## Final shared release sequence

`Member lane ready + Admin lane ready → reconcile latest staging → CI green → deploy staging → desktop/mobile UI validation → fix failures → approval → production merge/deploy → post-release live verification`
