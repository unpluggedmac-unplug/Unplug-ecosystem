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

The current `unplug-member-dashboard.html` remains the source of truth for member features, API calls and loaders. The Control Centre layer reorganises and activates those existing functions rather than creating a second member data model.

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
The compact service pattern selected by the user is now implemented:

- View All Services
- My Services
- Favourite Services — dynamic, up to 8
- Recent Services — dynamic, last 5
- Create / Submit

Individual services are intentionally **not** dumped into the sidebar. Favourite and Recent Services are derived from the real rendered service catalogue in `#msServicesGrid`; no second service API/data source was created.

Members can:

- open the full existing service catalogue through View All Services;
- open a Favourite Services modal;
- explicitly manage favourite services using the currently rendered catalogue;
- open the five most recently used services;
- clear recent services;
- continue using the existing native service cards/forms after selecting a shortcut.

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
- Login & Security
- Communication Preferences
- Your Data
- Download My Data
- View Official Site
- Logout

`Login & Security` and `Communication Preferences` are convenience destinations, not new account systems. Both reuse the real existing Account Settings workspace:

- Login & Security opens Account Settings and focuses the existing `#twoFactorContent` security area. The same native Account Settings page continues to contain the password/sign-in controls.
- Communication Preferences opens Account Settings and focuses the existing `#notifPrefsContent` controls.
- Search aliases such as password, security, 2FA, communication, preferences, notifications and email can find these destinations.

No duplicate account API or parallel settings record has been introduced.

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
- Navigation favourites are remembered.
- Last five recently used dashboard areas are remembered.
- Service favourites and recent services are stored separately from navigation favourites/recent areas.
- Search covers member navigation plus rendered services and submissions, with account convenience aliases added by the polish layer.
- Breadcrumbs and Back-to-parent are provided.
- Existing mobile sidebar/drawer behaviour is preserved.
- Conditional Agreement / Referral / Client areas stay conditional.

## Accessibility and lifecycle work

`member-dashboard-control-centre-polish.js` adds:

- `aria-expanded` and `aria-controls` to expandable navigation;
- `aria-current` to active destinations;
- accessible collapsed Home panels;
- search labels and Escape-to-clear;
- modal dialog semantics for Quick Create;
- Escape-to-close Quick Create;
- keyboard focus styles in the polish CSS.

The polish layer uses one controlled MutationObserver and avoids observing the ARIA attributes it writes itself, reducing the risk of self-triggering mutation loops.

The Favourite/Recent Services modal layer also uses dialog semantics, supports Escape/backdrop/close-button dismissal, and removes its document-level Escape listener whenever the modal is closed so repeated use does not accumulate global key handlers.

## Files added

- `media/scripts/member-dashboard-control-centre.js`
- `media/scripts/member-dashboard-control-centre-polish.js`
- `media/scripts/member-dashboard-service-shortcuts.js`
- `media/styles/member-dashboard-control-centre.css`
- `media/styles/member-dashboard-control-centre-help.css`
- `media/styles/member-dashboard-control-centre-polish.css`
- `media/styles/member-dashboard-service-shortcuts.css`
- `unplug-backend/test/memberDashboardControlCentre.test.js`
- `unplug-backend/test/memberDashboardControlCentrePolish.test.js`
- `unplug-backend/test/memberDashboardServiceShortcuts.test.js`
- `.github/workflows/member-dashboard-control-centre-ci.yml`
- this handover file

## Shared file currently modified on this feature branch

- `functions/runtime-config.js`

It currently loads the Member Dashboard Control Centre assets only when the path contains `unplug-member-dashboard`.

### Critical merge warning

While this member lane was being built, `staging-control-centre` continued moving and changed both:

- `functions/runtime-config.js`
- `unplug-member-dashboard.html`

At the latest staging inspection during this work, the Member branch and staging were still deliberately diverged. The latest staging head inspected was `31a9f69e656a53e893e6605a8759257a38828f4f`; its newest change was an Agreement Generator regression-test update, so no attempt was made to pull it into the Member lane while Claude is still working.

**Do not overwrite the latest staging versions with the older feature-branch copies.**

When Claude finishes the Admin lane:

1. take the newest `staging-control-centre` state;
2. preserve its newest Admin Dashboard/runtime/member-page changes;
3. re-apply only the Member Dashboard asset loader needed for these files;
4. do not restore Admin runtime lines that staging intentionally removed;
5. resolve any member-page changes by preserving both current functionality and the Control Centre layer;
6. run the dedicated Member CI and the repository-wide required checks;
7. only then deploy the combined state to staging for browser validation.

## Regression tests

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
- anchoring to the existing Unplug design-token system.

`unplug-backend/test/memberDashboardControlCentrePolish.test.js` adds focused checks for:

- Login & Security reusing `#twoFactorContent`;
- Communication Preferences reusing `#notifPrefsContent`;
- no duplicate fetch/API layer in the convenience shortcuts;
- account search aliases;
- idempotent polish insertion;
- one controlled MutationObserver;
- mutation-safety around accessibility attributes;
- existing profile completion as the checklist source;
- the four-step Unplug Path;
- responsive and keyboard-visible polish.

`unplug-backend/test/memberDashboardServiceShortcuts.test.js` checks:

- member-only service-shortcut loading;
- reuse of the real `#msServicesGrid .ms-service` catalogue;
- no duplicate service fetch/API layer;
- View All / Favourite / Recent compact navigation;
- local persistence limits for favourites and recents;
- explicit favourite-management UI;
- accessible service dialogs;
- cleanup of document-level modal keyboard handlers;
- responsive shared-token styling.

## Dedicated Member CI gate

Workflow:

`.github/workflows/member-dashboard-control-centre-ci.yml`

It runs the three Member Dashboard regression suites whenever Member Control Centre/runtime/test paths change.

The first run exposed two test-definition issues rather than product-code syntax failures:

1. the test incorrectly banned all six-digit colours even though the existing dashboard already uses established neutral/hover shades;
2. the service test expected direct `querySelector('.t')` even though the implementation deliberately uses the shared `q('.t', card)` helper.

Both assertions were corrected. The next dedicated run (`34747075777`, head `db7b416eaa0ab2494d7abf55eb3f267097a22896`) completed successfully. A follow-up run was triggered after the service-modal listener cleanup; always use the latest completed Member CI run when assessing readiness.

This dedicated workflow being green means the **Member-specific regression gate** passed. It does **not** by itself mean the entire repository, staging deployment or manual browser validation has passed.

## Status at handover

- ✅ Separate Member Dashboard branch created.
- ✅ Main hierarchical Member Dashboard layer added.
- ✅ Member Home added.
- ✅ Search / navigation favourites / recent / breadcrumbs / Back added.
- ✅ Quick Create added.
- ✅ Conditional Agreement / Growth / Referral / Client behaviour preserved.
- ✅ Root-level Notifications quick access added while keeping Notifications inside Community.
- ✅ Profile checklist added from existing completion state.
- ✅ Growth + gamification/participation bridge added.
- ✅ Login & Security convenience destination added using existing controls.
- ✅ Communication Preferences convenience destination added using existing controls.
- ✅ Favourite Services / Recent Services / View All Services compact pattern added.
- ✅ Service shortcut modal lifecycle cleanup added.
- ✅ Accessibility and mutation-safety polish added.
- ✅ Member-specific regression test files added.
- ✅ Dedicated Member Dashboard CI workflow added.
- ✅ At least one completed dedicated Member CI run is green after the test-definition fixes.
- 🟡 Latest follow-up Member CI should be confirmed after any subsequent code commit.
- 🟡 Full repository CI has not yet been confirmed on the final combined branch.
- 🟡 Browser/UI validation has not yet been completed.
- 🟡 Latest staging changes have not yet been reconciled because the Admin lane is still moving.
- ❌ Production merge/deploy has not started.

## Final shared release sequence

`Member lane ready + Admin lane ready → reconcile latest staging → dedicated Member CI green → full required CI green → deploy staging → desktop/mobile UI validation → fix failures → approval → production merge/deploy → post-release live verification`
