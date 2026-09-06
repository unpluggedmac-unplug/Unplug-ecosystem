# Unplug Control Centre — Phase 9: Advertising & Banner Campaign Manager

## Purpose
Turn the existing rotating `ad_slots` banner feature into an operational advertising campaign manager without replacing the public banner renderer or mixing it with the separate Participation Engine sponsor-campaign product.

## Database migration
Run `unplug-backend/db/migrations/186_ad_banner_campaign_manager.sql` before starting the new backend.

The migration adds campaign/advertiser metadata, recorded value/payment state, safe archive state, and daily aggregate banner analytics (`ad_banner_analytics`). Existing paid banners inherit payment value/status where possible.

## Admin changes
`Advertising > Banner Campaigns` now provides:
- campaign and advertiser details
- desktop + mobile creative
- placement-specific image dimensions
- campaign schedule and active/paused control
- payment value/status (Finance Manage / Super Admin only)
- internal notes
- status filters: Live, Scheduled, Paused, Expired, Pending, Archived
- search by campaign, advertiser, contact, email or placement
- safe Archive / Restore instead of destructive everyday deletion
- impressions, clicks, CTR and recorded campaign value per banner
- aggregate advertising summary cards
- existing member-submitted paid-banner approval/refund workflow

## Public analytics
`GET /page-cms` now includes each rendered banner's numeric id.
The public magazine sends anonymous aggregate events to:
- `POST /ad-banners/:id/event` `{ "eventType": "impression" }`
- `POST /ad-banners/:id/event` `{ "eventType": "click" }`

Impressions are de-duplicated once per banner per page-CMS render in the browser. No visitor id, user id, IP address, fingerprint or other identity is written to the banner analytics table.

## Reporting integration
Phase 8 Business Reports now include banner impressions, clicks and CTR in the selected date window; CSV/XLS exports include the same metrics.

## Permission boundary
Historical banner placement routes live under `/page-cms/admin/ad-slots`, but Phase 9 maps them to `advertising.manage` rather than `pages.manage`.

Advertising staff can edit creative, placement, dates and campaign metadata. `amount_paid` and `payment_status` can only be changed by Super Admin or staff holding `finance.manage`; the backend preserves the existing financial values for other staff.

## Universal search
Banner results now use the real banner row id and search campaign name, advertiser name, contact, email, placement and link.

## Safety
- Archived campaigns are excluded from the public page but retain analytics/history.
- Public event endpoint only accepts currently live/in-schedule approved banners.
- Event tracking is rate-limited and never blocks page navigation.
- Existing `DELETE /page-cms/admin/ad-slots/:id` remains for compatibility, but the new Control Centre uses Archive/Restore instead.
- The Participation Engine `sponsorships`, `sponsor_campaigns` and `sponsor_analytics` tables remain separate and untouched.

## Files changed
- `unplug-admin-dashboard.html`
- `unplug-magazine.html`
- `unplug-backend/src/routes/pageContent.js`
- `unplug-backend/src/routes/adBanners.js`
- `unplug-backend/src/routes/adminSearch.js`
- `unplug-backend/src/routes/adminBusinessReports.js`
- `unplug-backend/src/utils/staffPermissions.js`
- `unplug-backend/db/migrations/186_ad_banner_campaign_manager.sql`

## Validation performed
JavaScript syntax checks passed for all modified backend files, the large admin-dashboard inline script, and the main public magazine inline script. Permission routing was checked to confirm banner admin endpoints map to `advertising.manage`, while normal page CMS endpoints remain `pages.manage`.

A full database-backed integration test/build is still not claimed because the repository snapshot has an incomplete installed dependency tree. Deploy first to a staging environment with migrations and dependencies installed, then verify live banner rotation, analytics increments, staff permissions, payment protection and archive/restore before production.
