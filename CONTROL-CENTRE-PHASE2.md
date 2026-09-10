# Unplug Control Centre — Phase 2

## Added
- Universal admin search endpoint: `GET /admin/search?q=...` (admin-only)
- Search groups: articles, Directory profiles, events, gallery/media, users, payments, inquiries, Impact Makers, page content, banner slots
- Persistent Control Centre search field in admin UI
- Ctrl/Cmd + K keyboard shortcut
- Search-result routing back into the relevant admin module
- Search field inside All Content / Manage Content

## Safety choices
- Universal search is read-only.
- No request-provided table or column name is interpolated into SQL.
- Search is restricted to authenticated admins via the existing `requireRole('admin')` middleware.
- Existing admin section IDs and backend routes are preserved.
- No database migration is required for this phase.

## Validation performed
- `node --check` passed for `src/routes/adminSearch.js` and `src/app.js`.
- Dashboard inline JavaScript extracted from `unplug-admin-dashboard.html` and passed `node --check`.
- Full PostgreSQL-backed tests were not runnable from the extracted ZIP because `unplug-backend/node_modules` is not present (test dependency `embedded-postgres` missing).

## Deployment note
Do not deploy directly to production without first running the existing backend test suite in a normal development/CI environment with dependencies installed, then staging/smoke-testing the admin search against a non-production database where possible.
