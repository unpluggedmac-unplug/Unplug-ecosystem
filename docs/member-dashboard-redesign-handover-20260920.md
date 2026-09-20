# UnplugNews Member Dashboard Redesign — Final Handover

Date: 2026-09-20  
Target: `unplug-member-dashboard.html` / logged-in Member Area  
Staging branch: `staging-control-centre`  
Primary objective: organise the existing Member Dashboard into a predictable personal control centre without replacing existing business logic.

## 1. Final Member Dashboard sitemap

### Home
- Dashboard
- Action Required
- Quick Actions
- Recently Used

Purpose: account overview and next actions, not a complete feature catalogue.

### My Unplug
- My Profile
- Profile Completion
- Preview My Unplug Profile
- My Growth Journey — conditional
  - Growth Journey Overview
  - Growth Application
  - Quick Profile
  - Growth Assessment
  - Deep Discovery
  - Tasks
  - Progress
  - Reports

Purpose: the member's personal Unplug identity and growth journey.

### My Directory
- My Directory Profile
- Directory Performance

Purpose: the member's public professional/business Directory presence.

### My Content
- My Submissions
  - My Articles
  - My Events
  - My Listings
  - My Gallery
- Reading List
- My Editions

Purpose: content and submissions the member created, submitted or saved.

### Community
- Referral Progress
- My Referrals — conditional
- My Clients — conditional

Purpose: existing community/referral relationships. No unsupported follower/comment management screens were invented.

### Recognition & Gamification
- My Score & Level
- Missions
- This Week's Mission
- This Month's Challenge
- My Achievements
- Unplug Passport
- Leaderboard

Purpose: recognition, participation, progression and member rewards.

### Opportunities
- My Competitions
- My Votes
- Browse Competitions

Purpose: competition-related participation and existing vote activity.

### Services & Marketplace
- Browse Services
- My Services
- My Advertising
- Create / Submit

Purpose: services, commercial tools and advertising activity.

### Finance
- My Orders
- Payments
- Unplug Credits
- My Invoices

Purpose: existing financial records only. Votes were moved out because they are participation, not finance.

### Notifications
- All Notifications

Purpose: one clear primary home for member notifications.

### Agreements — conditional
- My Agreements
- Awaiting My Signature
- Signed
- Completed
- Archived
- Available Agreements

Purpose: preserve the existing agreement workflow without forcing it into an unrelated category.

### Help & Support
- Contact Support
- View Official Site

Purpose: surface only support destinations that actually exist. No FAQ/help-centre backend was invented.

### Account & Settings
- Account Details
- Login & Security
- Notification Preferences
- Privacy & Your Data
- Download My Data
- Logout

Purpose: account, security, preferences, privacy and data controls.

---

## 2. Menu naming table

| Final menu | Description | Purpose |
|---|---|---|
| Home | Your UnplugNews member dashboard and overview. | Status, priorities and next actions. |
| My Unplug | Manage your personal UnplugNews profile and growth journey. | Personal identity, completion and Growth. |
| My Directory | Manage your public professional or business Directory presence. | Public listing/profile. |
| My Content | Manage content you have created, submitted or saved. | Submissions, Gallery, reading and editions. |
| Community | Manage referrals and member relationships. | Existing referral/client relationships. |
| Recognition & Gamification | Track your score, missions, achievements, passport and leaderboard. | Progress and recognition. |
| Opportunities | View competitions, votes and participation opportunities. | Competition participation. |
| Services & Marketplace | Explore services, advertising and commercial tools. | Member services and advertising. |
| Finance | Manage orders, payments, credits and invoices. | Financial records. |
| Notifications | View important account and activity notifications. | One notification home. |
| Agreements | Review agreements that need your attention. | Conditional agreement workflow. |
| Help & Support | Find support and return to the public UnplugNews site. | Existing support path. |
| Account & Settings | Manage account details, security, preferences, privacy and data. | Account control. |

Retired or replaced vague/overloaded names:
- My Identity → split into My Unplug + My Directory.
- My Unplug Journey → Recognition & Gamification.
- Money & Purchases → Finance.
- Account & Privacy → Account & Settings.
- Communication Preferences → Notification Preferences.
- My Credits → Unplug Credits.
- Recent Activity → Recently Used because the existing data is navigation history, not a chronological activity feed.

---

## 3. Function mapping

| Existing function / old location | Final location | Reason |
|---|---|---|
| Directory Profile / My Identity | My Directory → My Directory Profile | Separates public listing from personal identity. |
| My Unplug Community Profile / My Identity | My Unplug → My Profile | Personal Unplug identity. |
| Preview as Public | My Unplug → Preview My Unplug Profile | Existing personal-profile preview. |
| Profile Completion | My Unplug → Profile Completion | Completion belongs with personal profile. |
| My Analytics | My Directory → Directory Performance | Existing analytics are reused; no second data source created. |
| Growth Application | My Unplug → My Growth Journey | Growth is personal development, kept conditional. |
| Articles | My Content → My Submissions → My Articles | Existing submission filter. |
| Events | My Content → My Submissions → My Events | Existing submission filter. |
| Listings | My Content → My Submissions → My Listings | Existing submission filter. |
| Gallery submission | My Content → My Submissions → My Gallery | Existing Gallery backend/filter exposed for discoverability. |
| Advertising | Services & Marketplace → My Advertising | Commercial service, not generic content. |
| Competitions | Opportunities → My Competitions | Participation opportunity. |
| My Votes | Opportunities → My Votes | Participation record, not finance. |
| Reading List | My Content → Reading List | Saved content. |
| My Editions | My Content → My Editions | Purchased/readable content. |
| Score/level | Recognition & Gamification → My Score & Level | Clear recognition home. |
| Daily/weekly/monthly missions | Recognition & Gamification | Participation/progression. |
| Achievements | Recognition & Gamification → My Achievements | Recognition. |
| Passport | Recognition & Gamification → Unplug Passport | Recognition/progress. |
| Leaderboard | Recognition & Gamification → Leaderboard | Ranking/progress. |
| Referral Progress | Community → Referral Progress | Member relationship/referral context. |
| My Referrals | Community → My Referrals | Conditional representative function. |
| My Clients | Community → My Clients | Conditional representative function. |
| Browse Services | Services & Marketplace → Browse Services | Catalogue. |
| My Services | Services & Marketplace → My Services | Purchased/active services. |
| Orders | Finance → My Orders | Financial record. |
| Payments | Finance → Payments | Financial record. |
| Credits | Finance → Unplug Credits | Financial credit ledger. |
| Invoices | Finance → My Invoices | Financial document. |
| Notifications | Notifications → All Notifications | Removes duplicate placement. |
| Agreements | Agreements | Preserved as conditional standalone workspace. |
| Account Settings | Account & Settings → Account Details | Clear account home. |
| Password / 2FA | Account & Settings → Login & Security | Security-specific shortcut to existing controls. |
| What we send you | Account & Settings → Notification Preferences | Clear member-facing wording. |
| Your Data | Account & Settings → Privacy & Your Data | Privacy/data tools. |
| Data export | Account & Settings → Download My Data | Direct existing export control. |
| Official site | Help & Support → View Official Site | Navigation/help destination. |

Functions intentionally NOT invented:
- Chronological My Activity feed.
- Help Centre backend.
- FAQ backend.
- Report-a-Problem workflow.
- Followers/following management dashboard.
- Comment-management dashboard.
- My Nominations dashboard.
- Voucher wallet.
- Directory package editor where no existing member function exists.
- Jobs/Opportunity Passport member dashboard screens where the current dashboard has no equivalent member workspace.

---

## 4. Dashboard Home design

Final order:
1. Welcome / contextual greeting.
2. Account Status.
3. Action Required.
4. Quick Actions.
5. My Unplug snapshot.
6. My Content summary.
7. Opportunities.
8. Recently Used.

Home derives its state from the already-rendered Member Dashboard DOM. It does not create another API or business-data source.

Account Status includes:
- My Unplug completion/status.
- Directory profile status.
- My Content summary.
- Notifications.
- Outstanding actions.

Quick Actions include a small, deliberate set:
- Edit My Profile.
- Add Gallery Content.
- View My Directory.
- Explore Opportunities.
- View My Achievements.
- Create / Submit.

Profile completion continues to show the existing completion percentage plus the real remaining checklist items.

---

## 5. Design system

### Typography
- Reuses existing Unplug typography tokens.
- Playfair Display for editorial headings/high-value metrics.
- Inter for dashboard navigation, controls and body/UI text.

### Spacing
- Consistent compact control-centre spacing.
- Panels/cards use predictable internal spacing.
- Mobile spacing collapses cleanly rather than shrinking desktop values blindly.

### Buttons
- Button labels describe actions.
- Primary actions retain existing Unplug red treatment.
- Secondary/utility actions use the existing neutral/line treatment.
- Mobile interactive targets are at least 44px where the dashboard layer controls them.

### Statuses
Status presentation uses text plus visual state. Colour is not the sole meaning.

Recognised states are derived from existing system wording and mapped to:
- neutral
- warning / in progress
- good / complete
- action required / error

Specific bug fixed: incomplete percentages such as `72% complete` no longer receive the same visual state as 100% completion.

### Cards
- Existing content/service cards remain the source of truth.
- New Home cards/panels use one compact dashboard style.
- No unnecessary new backend card model.

### Navigation
- Desktop uses the left control-centre navigation.
- Related functions are grouped; unrelated functions are separated.
- Search, favourites and Recently Used are navigation conveniences only.
- Breadcrumb context begins with Member Dashboard.

### Icons
- Icons are supplementary; every item has written text.
- Decorative icons are hidden from assistive technology where appropriate.
- No function relies on an icon alone.

---

## 6. Responsive structure

### Desktop
- Persistent left navigation.
- Sticky breadcrumb/context row.
- Multi-column Home status, progress and opportunity summaries.

### Tablet / mobile
- One mobile breakpoint aligned with the original dashboard: `820px`.
- Previous 760/820 mismatch was fixed.
- Drawer auto-close uses the same 820px breakpoint.
- Menu button is sticky.
- Context row remains reachable.
- Open drawer gets bounded viewport height and vertical scrolling.
- Touch targets are hardened to 44px.
- Search input uses mobile-safe sizing.
- Multi-column Home sections collapse progressively to two columns, then one.
- Long content uses overflow wrapping rather than forcing horizontal layout.

---

## 7. Accessibility review

Implemented/verified in the dashboard enhancement layer:
- Navigation has an accessible navigation role/name.
- Expand/collapse controls expose `aria-expanded` and `aria-controls`.
- Expand/collapse controls receive descriptive labels.
- Active navigation exposes `aria-current`.
- Decorative icons are hidden from screen readers.
- Favourite-star controls have explicit Add/Remove accessible names.
- Search has a descriptive label, controls relationship, autocomplete and expanded state.
- Escape clears dashboard search.
- Home collapsible panels expose state and controlled panel IDs.
- Mobile menu exposes `aria-expanded` / `aria-controls`.
- Escape closes the open mobile menu and restores focus.
- Quick Create is a labelled modal dialog.
- Quick Create traps Tab/Shift+Tab inside the dialog.
- Escape closes Quick Create.
- Focus returns to the launch control after Quick Create closes.
- Consistent visible focus treatment is added.
- Reduced-motion users have dashboard animations/transitions disabled.
- Status meaning is not communicated through colour alone.

---

## 8. First-time-user test matrix

| Test | Expected location | Source/automated result |
|---|---|---|
| Edit personal Unplug profile | My Unplug → My Profile | PASS — navigation contract. |
| Edit public Directory profile | My Directory → My Directory Profile | PASS — separate from My Unplug. |
| Upload Gallery content | Home Quick Action / Quick Create / My Content → My Gallery | PASS — discoverability gap fixed using existing Gallery system. |
| See badges/achievements | Recognition & Gamification → My Achievements | PASS. |
| Know what remains incomplete | Home → Action Required + Profile Completion checklist | PASS. |
| Check submission approval/status | My Content → My Submissions | PASS. |
| Find competition participation | Opportunities → My Competitions / Browse Competitions | PASS. |
| See something purchased | Finance → My Orders / Invoices | PASS. |
| Find help | Help & Support → Contact Support | PASS. |
| Change password | Account & Settings → Login & Security | PASS — existing Account controls reused. |

Automated structural audit on the complete feature state:
- 67/67 destination/architecture checks passed.
- Literal control-centre destinations resolve to existing native source destinations.
- Navigation IDs are unique.
- Retired top-level labels are absent.
- Notifications has one primary navigation home.
- Growth remains conditional.
- Agreements remain conditional.
- Advertising, competitions and votes are mapped to their intended homes.

---

## 9. Bugs/issues found and fixed during redesign

### ITEM 1 — Important
**Problem:** original dashboard changed to its mobile drawer at 820px, while the Control Centre only auto-closed at 760px.  
**Where:** Member Dashboard responsive navigation.  
**Expected:** one consistent breakpoint.  
**Actual:** 761–820px could retain inconsistent drawer behaviour.  
**Fix:** Control Centre and polish aligned to 820px; regression tests updated.  
**Status:** fixed and CI green.

### ITEM 2 — Important
**Problem:** Gallery submission already existed but was not discoverable in the redesigned navigation/Quick Actions.  
**Where:** My Content / Quick Create / Home.  
**Expected:** first-time member can find Gallery submission.  
**Actual:** Gallery form/backend existed but no dedicated dashboard path.  
**Fix:** added native Gallery submission filter, My Gallery navigation, Home Gallery quick action and Quick Create Gallery option.  
**Status:** fixed using existing Gallery workflow.

### ITEM 3 — Important
**Problem:** incomplete profile percentage could be visually classified as complete because the classifier matched the word “complete”.  
**Where:** Home Account Status.  
**Expected:** 0–99% is incomplete/in progress; 100% is complete.  
**Actual:** e.g. “72% complete” could receive the success treatment.  
**Fix:** explicit percentage parsing; action/unread severity uses value + explanatory note.  
**Status:** fixed and regression locked.

### ITEM 4 — Minor
**Problem:** old dashboard labelled navigation-history data as Recent Activity.  
**Expected:** terminology must match the data.  
**Actual:** members could interpret it as chronological platform activity.  
**Fix:** renamed to Recently Used.  
**Status:** fixed.

### ITEM 5 — Important
**Problem:** Notifications existed in more than one navigation presentation.  
**Expected:** one function = one clear home.  
**Fix:** removed duplicate quick-notification navigation injection; Notifications now has one primary home.  
**Status:** fixed.

### ITEM 6 — Important
**Problem:** Quick Create lacked complete keyboard focus containment/return and several controls lacked accessible names.  
**Fix:** focus trap, focus return, Escape close, labelled favourites, dynamic branch labels, search/menu ARIA.  
**Status:** fixed.

---

## 10. Files changed by the redesign stack

Product/UI:
- `unplug-member-dashboard.html`
- `media/scripts/member-dashboard-control-centre.js`
- `media/scripts/member-dashboard-control-centre-polish.js`
- `media/scripts/member-dashboard-control-centre-loader.js`
- `media/scripts/member-dashboard-service-shortcuts.js`
- `media/styles/member-dashboard-control-centre.css`
- `media/styles/member-dashboard-control-centre-polish.css`
- `functions/runtime-config.js`

Regression coverage:
- `unplug-backend/test/memberDashboardControlCentre.test.js`
- `unplug-backend/test/memberDashboardControlCentrePolish.test.js`
- `unplug-backend/test/memberDashboardServiceShortcuts.test.js`

Release-hardening on staging:
- Member dashboard asset versions bumped consistently to `20260920-2` through the runtime/loader chain to avoid stale cached UI assets.

No redesign changes were required to:
- database schema
- authentication model
- payment business logic
- directory prices
- gamification scoring calculations
- badge-awarding rules
- competition rules
- approval logic
- account verification

---

## 11. Testing completed

Automated:
- JavaScript parse checks.
- Member Dashboard Control Centre tests.
- Control Centre polish tests.
- Service shortcut tests.
- Packaged asset verification.
- Build configuration contract checks where triggered.
- Destination/source mapping audit.
- First-time-user discoverability contract.
- Mobile breakpoint contract.
- Accessibility contract.
- Cache-version consistency contract on staging.

CI state recorded during implementation:
- Phase 2 replacement run: green.
- Phase 4 corrected run: green.
- Phase 5 run: green.
- Phase 6 corrected run: green.
- Phase 7 corrected run: green.
- Final feature head: Member Dashboard CI green and build-configuration gate green before staging advanced with release-hardening commits.

Environment checks:
- `https://unplug-staging.pages.dev/` reachable.
- `https://unplug-staging.pages.dev/unplug-member-dashboard.html` reachable.
- `https://unplug-ecosystem-staging.onrender.com/health` returns `{"status":"ok"}`.
- Automatic feature-branch Pages aliases tested and returned 404; validation therefore uses the configured staging branch/site.

---

## 12. Current known issues / blocked validation

### Authenticated staging visual walkthrough
The final source/CI state is complete, but an authenticated visual pass must be recorded against the exact current deployed staging build before production release is called complete.

Reason:
- source and CI can verify structure/contracts;
- only the deployed browser can verify actual signed-in rendering, responsive interaction, cache delivery and user-specific conditional sections.

Do not mark the production release complete until:
1. exact staging build is confirmed deployed;
2. a signed-in desktop walkthrough passes;
3. a signed-in mobile/tablet walkthrough passes;
4. representative safe destinations are clicked;
5. no release-blocking browser/UI defects remain.

### Proposed target-menu items intentionally absent
The master brief contains proposed items whose member-dashboard functionality does not currently exist. They were not fabricated. Examples include full chronological My Activity, FAQ/Help Centre backend, comment management, nominations, voucher wallet, follower/following dashboards and certain opportunity/job/passport member screens.

---

## 13. Desktop navigation visual

```text
UNPLUGNEWS
MEMBER AREA

Search Member Dashboard…

HOME
  Dashboard
  Action Required
  Quick Actions
  Recently Used

MY UNPLUG
  My Profile
  Profile Completion
  Preview My Unplug Profile
  My Growth Journey [conditional]

MY DIRECTORY
  My Directory Profile
  Directory Performance

MY CONTENT
  My Submissions
    My Articles
    My Events
    My Listings
    My Gallery
  Reading List
  My Editions

COMMUNITY
  Referral Progress
  My Referrals [conditional]
  My Clients [conditional]

RECOGNITION & GAMIFICATION
  My Score & Level
  Missions
  This Week's Mission
  This Month's Challenge
  My Achievements
  Unplug Passport
  Leaderboard

OPPORTUNITIES
  My Competitions
  My Votes
  Browse Competitions

SERVICES & MARKETPLACE
  Browse Services
  My Services
  My Advertising
  Create / Submit

FINANCE
  My Orders
  Payments
  Unplug Credits
  My Invoices

NOTIFICATIONS
  All Notifications

AGREEMENTS [conditional]

HELP & SUPPORT
  Contact Support
  View Official Site

ACCOUNT & SETTINGS
  Account Details
  Login & Security
  Notification Preferences
  Privacy & Your Data
  Download My Data
  Logout
```

---

## 14. Mobile navigation visual

```text
[ ☰ Member Menu ]

[ sticky context / breadcrumb ]

Tap Member Menu
┌─────────────────────────────────┐
│ UNPLUGNEWS — MEMBER AREA        │
│ Search Member Dashboard…        │
│                                 │
│ Home                         >  │
│ My Unplug                    >  │
│ My Directory                 >  │
│ My Content                   >  │
│ Community                    >  │
│ Recognition & Gamification   >  │
│ Opportunities                >  │
│ Services & Marketplace       >  │
│ Finance                      >  │
│ Notifications                >  │
│ Agreements*                  >  │
│ Help & Support               >  │
│ Account & Settings           >  │
└─────────────────────────────────┘

* shown only when available to the member
Escape closes the menu and returns keyboard focus.
```

---

## 15. Release sequence

1. Treat `staging-control-centre` as the authoritative candidate.
2. Confirm Member Dashboard CI on the current staging head or on the final handover PR head.
3. Confirm staging Pages has deployed the current cache version.
4. Run authenticated desktop + mobile visual validation.
5. Fix and retest any staging defects.
6. Produce/retain staging desktop and mobile screenshots/snapshots.
7. Only then advance the release through the normal production merge/deploy process.
8. After production deploy, repeat representative member-route smoke checks.

---

## 16. Future recommendations

Only after this redesign is stable:
- Add a real chronological My Activity feed if the backend later exposes one.
- Add dedicated Help Centre/FAQ/Report Problem functions if those workflows are built.
- Consider dedicated member-facing Jobs / Opportunity Passport navigation only when there is an authenticated member workflow to map.
- Continue replacing ambiguous raw backend status wording with the standard member-facing status vocabulary at the source layer, without changing approval semantics.
- Keep the single-source navigation contract and cache-version regression tests whenever future dashboard assets change.

---

## 17. Completion statement

The redesign is considered source/implementation complete when the current staging head remains green and the exact staged UI passes authenticated desktop/mobile verification.

The standard remains:

- Everything has a place.
- Every place has a clear name.
- Every existing function keeps its source of truth.
- Unsupported features are not fabricated.
- The member can identify where they are, what the page means, what their status is and what to do next.
