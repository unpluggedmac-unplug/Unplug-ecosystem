# Member Dashboard Redesign — Final Handover

**Prepared:** 2026-09-20  
**Scope:** UnplugNews Member Dashboard redesign, Phases 1–10  
**Final feature branch:** `feat/member-dashboard-phase8-first-time-20260920`  
**Production status:** NOT deployed. Production must remain unchanged until the exact staging candidate is visually/authenticated-tested.

## 1. Objective

Restructure the Member Dashboard so a first-time member can understand where to go without removing or duplicating existing functionality.

Primary rules:

- One function = one clear home.
- **My Unplug** is the member's personal/community identity.
- **My Directory** is the member's public professional/business listing.
- Preserve existing data sources, backend contracts, pricing, payments, approval flows, gamification calculations, agreements, roles and permissions.
- Do not create a second API/data model merely to support the redesigned navigation.
- Mobile uses the same information hierarchy with a proper drawer/touch experience, not a shrunk desktop menu.
- Secondary workspaces receive consistent title/description/status context.

## 2. Final Member Dashboard sitemap

```text
MEMBER DASHBOARD
├─ Home
│  ├─ Dashboard
│  ├─ Action Required
│  ├─ Recently Used
│  └─ Quick Actions
│
├─ My Unplug
│  ├─ My Profile
│  ├─ Profile Completion
│  ├─ Preview My Unplug Profile
│  └─ My Growth Journey (conditional)
│     ├─ Growth Journey Overview
│     ├─ Growth Application
│     ├─ Quick Profile
│     ├─ Growth Assessment
│     ├─ Deep Discovery
│     ├─ Tasks
│     ├─ Progress
│     └─ Reports
│
├─ My Directory
│  ├─ My Directory Profile
│  └─ Directory Performance
│
├─ My Content
│  ├─ My Submissions
│  │  ├─ My Articles
│  │  ├─ My Events
│  │  ├─ My Listings
│  │  └─ My Gallery
│  ├─ Reading List
│  └─ My Editions
│
├─ Community
│  ├─ Referral Progress
│  ├─ My Referrals (conditional)
│  └─ My Clients (conditional)
│
├─ Recognition & Gamification
│  ├─ My Score & Level
│  ├─ Missions
│  ├─ This Week's Mission
│  ├─ This Month's Challenge
│  ├─ My Achievements
│  ├─ Unplug Passport
│  └─ Leaderboard
│
├─ Opportunities
│  ├─ My Competitions
│  ├─ My Votes
│  └─ Browse Competitions
│
├─ Services & Marketplace
│  ├─ Browse Services
│  ├─ My Services
│  ├─ My Advertising
│  └─ Create / Submit
│
├─ Finance
│  ├─ My Orders
│  ├─ Payments
│  ├─ Unplug Credits
│  └─ My Invoices
│
├─ Notifications
│  └─ All Notifications
│
├─ Agreements (conditional)
│  ├─ My Agreements
│  ├─ Awaiting My Signature
│  ├─ Signed
│  ├─ Completed
│  ├─ Archived
│  └─ Available Agreements
│
├─ Help & Support
│  ├─ Contact Support
│  └─ View Official Site
│
└─ Account & Settings
   ├─ Account Details
   ├─ Login & Security
   ├─ Notification Preferences
   ├─ Privacy & Your Data
   ├─ Download My Data
   └─ Logout
```

## 3. Desktop navigation visual

```text
┌──────────────────────────────┐
│ UNPLUGNEWS                   │
│ MEMBER AREA                  │
├──────────────────────────────┤
│ Search Member Dashboard...   │
├──────────────────────────────┤
│ ★ Favourites                 │
│ ↻ Recently Used              │
├──────────────────────────────┤
│ ⌂ Home                       │
│ ● My Unplug                  │
│ ◉ My Directory               │
│ ▤ My Content                 │
│ ◎ Community                  │
│ ✦ Recognition & Gamification│
│ 🎯 Opportunities             │
│ ＋ Services & Marketplace    │
│ R Finance                    │
│ ● Notifications              │
│ § Agreements*                │
│ ? Help & Support             │
│ ⚙ Account & Settings        │
└──────────────────────────────┘
* only when available to that member
```

## 4. Mobile navigation visual

```text
┌──────────────────────────────┐
│ ☰ Member Menu                │
├──────────────────────────────┤
│ Member Dashboard › Area      │
├──────────────────────────────┤
│ Page / Home content          │
│                              │
│ Drawer opens full width      │
│ and scrolls independently:   │
│                              │
│ Home                         │
│ My Unplug                    │
│ My Directory                 │
│ My Content                   │
│ Community                    │
│ Recognition & Gamification  │
│ Opportunities                │
│ Services & Marketplace      │
│ Finance                      │
│ Notifications                │
│ Agreements*                  │
│ Help & Support               │
│ Account & Settings           │
└──────────────────────────────┘
```

Mobile breakpoint is **820px**, matching the original dashboard's existing drawer breakpoint. The prior Control Centre used 760px and was corrected.

## 5. Old → new naming and location mapping

| Previous location/name | Final home/name |
|---|---|
| My Identity | Removed as a top-level concept |
| Directory Profile | My Directory → My Directory Profile |
| My Unplug Community Profile | My Unplug → My Profile |
| Preview as Public | My Unplug → Preview My Unplug Profile |
| My Analytics | My Directory → Directory Performance |
| My Unplug Journey | Recognition & Gamification |
| Status & Score | My Score & Level |
| Today's Missions | Missions |
| Achievements | My Achievements |
| My Growth | My Unplug → My Growth Journey |
| My Advertising under My Submissions | Services & Marketplace → My Advertising |
| My Competitions under My Submissions | Opportunities → My Competitions |
| My Votes under Money & Purchases | Opportunities → My Votes |
| Services | Services & Marketplace |
| Money & Purchases | Finance |
| My Credits | Unplug Credits |
| Notifications inside Community + duplicate quick link | Notifications → All Notifications |
| Account & Privacy | Account & Settings |
| Account Settings | Account Details |
| Your Data | Privacy & Your Data |
| Communication Preferences | Notification Preferences |
| Recent Activity (actually nav history) | Recently Used |
| Gallery submit form existed but had no clear member home | My Content → My Gallery + Home/Quick Create shortcut |

## 6. Home control-centre structure

The redesigned Home follows this order:

1. Welcome/greeting
2. Account Status
3. Action Required
4. Quick Actions
5. My Unplug snapshot
6. My Content summary
7. Opportunities
8. Recently Used

### Account Status

Derived from existing rendered dashboard state only:

- My Unplug profile completion/publish state
- Directory profile state
- content/submission counts
- unread notifications
- outstanding actions

No new Home API was created.

### My Unplug snapshot

Uses existing:

- Unplug Score
- current status/level
- streak
- achievement count
- passport count

### My Content summary

Uses already-rendered submission rows and their existing status pills.

### Opportunities

Uses real existing destinations:

- My Competitions
- Browse Competitions
- Top 10
- My Growth Journey when available

## 7. Page consistency

A single additive page-header layer now provides secondary dashboard workspaces with:

- `MEMBER DASHBOARD` context
- page title
- one-sentence description
- contextual status where safely derivable
- existing breadcrumb/navigation context

It does **not** make new API requests and does not replace native workspace controls.

## 8. Responsive/mobile rules

Implemented:

- Control Centre breakpoint aligned to 820px.
- Drawer auto-closes after navigation at the same breakpoint.
- mobile menu is sticky.
- context/breadcrumb region remains reachable while navigating.
- drawer has viewport-bounded height and independent scrolling.
- important controls use at least 44px touch height.
- dashboard search remains 16px on mobile to prevent iOS zoom.
- dashboard cards/grids collapse progressively to two columns then one.
- long labels/descriptions use safe wrapping.
- Escape closes the mobile drawer.

## 9. Accessibility

Implemented or preserved:

- navigation landmark with accessible name
- `aria-current` on current navigation item
- branch toggles expose `aria-controls`, `aria-expanded`, and dynamic Expand/Collapse labels
- decorative navigation icons hidden from screen readers
- favourite controls have meaningful accessible names
- Home collapsible panels expose expanded state
- search exposes controls/autocomplete/expanded state
- mobile menu exposes controls/expanded state
- Quick Create is a modal dialog with:
  - dialog role
  - modal state
  - labelled title
  - Escape close
  - keyboard focus trap
  - focus return on close
- consistent `:focus-visible` treatment
- reduced-motion override
- status is always expressed in text; colour is supplementary

## 10. First-time-user journey matrix

| First-time task | Clear route |
|---|---|
| Create/edit personal profile | My Unplug → My Profile |
| Complete personal profile | My Unplug → Profile Completion |
| Manage public Directory listing | My Directory → My Directory Profile |
| Submit/view Gallery content | Home → Add Gallery Content; My Content → My Gallery |
| View badges/achievements | Recognition & Gamification → My Achievements |
| Find incomplete/action items | Home → Action Required |
| Check submission approval state | My Content → My Submissions |
| Enter/view competition | Opportunities → My Competitions / Browse Competitions |
| Purchase a service | Services & Marketplace → Browse Services |
| Check orders/payment/invoices/credit | Finance |
| Get help | Help & Support → Contact Support |
| Change password / security | Account & Settings → Login & Security |

## 11. Existing functionality explicitly preserved

No intentional changes were made to:

- authentication/session model
- member registration
- database schema
- payment calculations
- prices
- vouchers
- account-credit calculations
- Directory pricing/package logic
- admin approval workflows
- article/event/listing/gallery/advertising/competition backend submission logic
- gamification point calculations
- badge/achievement calculations
- passport calculations
- leaderboards
- Growth Application backend
- Agreement Generator backend
- representative/client permissions
- privacy/export backend
- notification backend

The redesigned layer continues to activate the original native `data-ms` destinations.

## 12. Defects found and fixed during the redesign

1. **My Unplug and Directory conflated** — separated into distinct homes.
2. **Notifications duplicated** — removed duplicate quick-root injection; one primary home remains.
3. **Advertising misplaced under content** — moved to Services & Marketplace.
4. **Competitions/Votes misplaced** — moved to Opportunities.
5. **Votes under Finance** — removed from Finance.
6. **Recent Activity misleading** — renamed Recently Used because it is navigation history.
7. **760/820 mobile breakpoint mismatch** — corrected to 820px.
8. **Mobile drawer ARIA state missing** — added.
9. **Favourite buttons lacked accessible names** — fixed.
10. **Expand/Collapse labels did not reflect state** — fixed.
11. **Quick Create did not trap/return keyboard focus** — fixed.
12. **Gallery feature existed but was hard to discover** — added existing Gallery path to native navigation, Control Centre, Home and Quick Create.
13. **Incomplete profile percentages could appear visually complete** — status severity now treats <100% as warning.
14. **Old regression assertions blocked correct terminology/breakpoint changes** — updated to the final contract.

## 13. Regression/testing evidence

Automated dashboard CI includes:

- JavaScript syntax checks
- exact frontend candidate build
- packaged asset verification
- native source-of-truth checks
- hierarchy/navigation contract
- conditional role areas
- agreement filters
- search/favourites/recents
- Home derived-state contract
- profile checklist
- Growth bridge
- responsive layout
- service shortcut layer
- accessibility behavior
- first-time-user discoverability

Independent final structural audit on the consolidated feature state: **67/67 checks passed** before the final first-time assertion correction.

Known green stacked CI:
- Phase 2 — green
- Phase 4 Home — PR #57, CI run #98 — green
- Phase 5 Page consistency — PR #58, CI run #99 — green
- Phase 6 Mobile — PR #59, CI run #119 — green
- Phase 7 Accessibility — PR #60, CI run #122 — green
- Phase 8 / consolidated feature head `a2c441ca9690e8fd355f11de6b47b9e41df35e4c` — Member Dashboard CI runs #136/#137 green and build-configuration gate #369 green.
- Staging cache-bust PR #64 — Member Dashboard CI #146 green and build-configuration gate #371 green.

## 14. Staging state

Verified 2026-09-20:

- Staging candidate PR **#63** merged to `staging-control-centre`.
- Cache-bust hotfix PR **#64** merged to staging as `1132ef5842ab10643c6843f1430221e8ee2dfd30`.
- `https://unplug-staging.pages.dev/unplug-member-dashboard` is reachable.
- `https://unplug-ecosystem-staging.onrender.com/health` returns `{"status":"ok"}`.
- Canonical staging directly serves the cache-busted `20260920-2` Member Dashboard loader/core/polish/service-shortcut chain.
- Browser DOM validation confirmed the redesigned Control Centre assets are rendered on canonical staging.
- Home order rendered as greeting → Account Status → Action Required/recommended next step → Quick Actions → My Unplug snapshot → My Content → Opportunities → Growth bridge → Recently Used/profile checklist.
- Add Gallery Content, View My Directory, Explore Opportunities, View My Achievements and Create / Submit are visible in the redesigned Quick Actions.
- My Unplug and Directory status are visibly separate.
- No visible UI/page errors were observed in the read-only staging pass.

### Authenticated staging limitation

A staging-only browser registration attempt exposed a real configuration defect before authentication: JSON registration was blocked by the cross-origin preflight. The Render staging service was still running an older September 13 deploy, so it was first redeployed on the dashboard candidate, then the staging-only `CORS_ORIGINS` value was corrected to the runbook value `https://unplug-staging.pages.dev`. The subsequent Render staging readiness check passed and the corrected deployment went live.

The remaining browser limitation is now the automation safety layer: it will not type, generate or handle account passwords. No password bypass or test backdoor was added. A real signed-in walkthrough therefore still requires a manual staging member login/session for:
- complete left navigation and conditional submenus;
- secondary workspace headers/breadcrumbs after real navigation;
- tablet/mobile drawer interaction while authenticated;
- conditional Growth/Agreements/representative states;
- keyboard interaction across signed-in destinations.

Source contracts, CI and the deployed unauthenticated DOM are verified, but do not describe the authenticated visual gate as completed until that manual staging session is available.

### Production integration

The old production integration PR #66 was closed because its stale merge-base made already-released referral-attribution files from PR #62 appear in the dashboard diff.

PR #68 was later superseded after production `main` advanced again. Current production includes PR #74's gallery cancellation fixes, so the dashboard candidate was rebuilt from the new current `main` rather than merging a branch that was 15 commits behind.

PR #76 was built from current `main` after PR #74 and passed its complete exact-head gates, including both full backend regression jobs at **2,487/2,487 tests, 0 failures, 0 skipped**. Before staging promotion, production `main` advanced again when PR #75 merged profile-image fallback and Growth mobile fixes. Those PR #75 changes do not touch any of the 13 dashboard candidate files.

Current production integration is **PR #77**:
- branch: `integrate/member-dashboard-redesign-main-latest-20260920`
- base: latest `main` after PR #75
- scope: 13 dashboard/runtime/docs/test files only
- PR #74 and PR #75 production changes are inherited unchanged
- no auth/referral/acquisition/payment/pricing/cancellation/business-rule changes
- PR #68 is closed unmerged; PR #76 is superseded
- keep #77 draft until its exact-head CI is green, staging is resynced to that exact head, and authenticated staging visual validation is completed.

## 15. Production stop conditions

Do not release to production if any of these remain unresolved:

- staging serves a different commit than the candidate
- dashboard scripts fail to load
- signed-in member cannot access dashboard
- native destinations are missing/broken
- My Unplug / Directory distinction is unclear
- mobile drawer traps or hides navigation
- payment/order/credit screens regress
- Growth or Agreements disappear for eligible members
- first-time Gallery path breaks
- CI not green
- authenticated staging visual test not completed

## 16. Files affected by the redesign stack

Primary files:

- `media/scripts/member-dashboard-control-centre.js`
- `media/scripts/member-dashboard-control-centre-polish.js`
- `media/styles/member-dashboard-control-centre.css`
- `media/styles/member-dashboard-control-centre-polish.css`
- `unplug-member-dashboard.html` (Gallery discoverability only)
- `unplug-backend/test/memberDashboardControlCentre.test.js`
- `unplug-backend/test/memberDashboardControlCentrePolish.test.js`

The existing service-shortcut layer remains in use and was intentionally not replaced.

## 17. Future recommendations (not release blockers)

- Replace navigation-history “Recently Used” with a true chronological activity feed only when a supported activity data source exists.
- Consider a dedicated Directory-only analytics split if backend analytics later separates Directory engagement from other published-work analytics.
- Add FAQ / Report a Problem to Help & Support only when those actual supported functions exist.
- Consider richer member opportunity aggregation only when a single supported opportunity feed exists.
- Continue testing with individual, business, representative and member-with-agreements accounts.

## 18. Final release state at handover creation

- Architecture: implemented
- Navigation/terminology: implemented
- Home: implemented
- Page consistency: implemented
- Responsive/mobile: implemented
- Accessibility: implemented
- First-time discoverability: implemented
- Source/static audit: passed
- Consolidated feature CI: green
- Staging cache-bust CI: green
- Canonical staging infrastructure: healthy
- Exact feature stack on canonical staging: deployed and cache-bust verified
- Read-only deployed DOM/Home validation: passed
- Authenticated desktop/mobile visual staging validation: BLOCKED only by missing staging member credentials in the browser vault
- Prior clean integration PR #68: closed unmerged after `main` advanced
- PR #76 exact-head validation: green, including both full backend suites at 2,487/2,487 with zero failures/skips; superseded before staging promotion when PR #75 advanced production `main`
- Final latest-main integration: PR #77 draft, built from current `main` after PR #75
- Staging backend: redeployed on the dashboard candidate; staging CORS corrected to the canonical staging Pages origin
- Authenticated desktop/mobile visual staging validation: still pending manual staging sign-in because browser automation will not handle passwords
- Production: unchanged
