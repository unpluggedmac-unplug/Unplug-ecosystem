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
- Phase 8 — final CI must be green on the final head before staging merge.

## 14. Staging state

Verified 2026-09-20:

- `https://unplug-staging.pages.dev/unplug-member-dashboard` is reachable.
- `https://unplug-ecosystem-staging.onrender.com/health` returns `{"status":"ok"}`.
- Canonical staging currently serves the existing `staging-control-centre` branch, not this final dashboard feature stack.
- guessed feature-branch Pages aliases returned 404.
- therefore the exact final feature UI has **not yet** completed authenticated visual validation.

### Required staging gate

Before production:

1. consolidate final feature branch into one PR targeting `staging-control-centre`
2. CI green
3. merge to staging branch
4. confirm Cloudflare staging publishes exact commit
5. authenticated member walkthrough:
   - desktop
   - mobile
   - first-time journey matrix
   - conditional Growth/Agreements/representative states where available
6. capture final desktop/mobile screenshots or equivalent real staging visuals
7. fix/retest any defects
8. only then consider production merge/deploy

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
- Stacked CI: green through Phase 7; final Phase 8 head pending final green check
- Canonical staging infrastructure: healthy
- Exact feature stack on canonical staging: not yet deployed
- Authenticated visual staging validation: blocked until exact feature candidate is on staging and usable credentials/session are available
- Production: unchanged
