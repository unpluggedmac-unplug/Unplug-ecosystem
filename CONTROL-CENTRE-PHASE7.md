# Unplug Control Centre — Phase 7: Staff Roles & Permissions

## Purpose
Phase 7 introduces capability-based staff access without replacing the hundreds of existing `requireRole('admin')` guards one-by-one.

## Security model
- `users.role = 'admin'` is the unrestricted **Super Admin** role.
- `users.role = 'staff'` is restricted and must have one row in `staff_assignments`.
- Staff access is decided by the capability required for the current request.
- Unknown admin-only routes default to `system.manage`, so new routes do not accidentally become available to staff.
- Staff/role management endpoints use `requireSuperAdmin` and cannot be delegated through a capability.
- A staff member with member-management access cannot promote anyone to Super Admin.
- Staff accounts cannot be deleted from the ordinary Members screen; remove staff access first.
- Universal Admin Search filters result groups by the signed-in staff member's permissions.
- Dashboard totals omit finance/member/content figures a staff member is not permitted to see.
- User-list financial fields are removed unless the requester has finance access.

## Built-in staff roles
The migration seeds these editable templates:
- Editor
- Marketing
- Finance
- Support
- Events Manager
- Competition Manager
- Sales

Super Admin is intentionally not a staff template.

## Core capabilities
- `dashboard.view`
- `content.view`, `content.manage`
- `approvals.view`, `approvals.manage`
- `pages.manage`
- `media.manage`
- `members.view`, `members.manage`
- `events.manage`
- `competitions.manage`
- `directory.manage`
- `advertising.manage`
- `finance.view`, `finance.manage`
- `marketing.manage`
- `crm.manage`
- `analytics.view`
- `reports.export`
- `system.manage`

`*.manage` implies the corresponding `*.view` for content, approvals, members and finance.

## Database migration
Run migration:

`unplug-backend/db/migrations/185_staff_roles_permissions.sql`

It:
1. adds `staff` to the users role constraint;
2. creates `staff_roles`;
3. creates `staff_role_permissions`;
4. creates `staff_assignments` while preserving the account's original non-staff role;
5. seeds the built-in role templates and permissions;
6. allows `actor_role='staff'` in the existing audit log.

## Backend files
New:
- `unplug-backend/src/utils/staffPermissions.js`
- `unplug-backend/src/routes/adminStaff.js`

Changed:
- `unplug-backend/src/middleware/auth.js`
- `unplug-backend/src/routes/admin.js`
- `unplug-backend/src/routes/adminSearch.js`
- `unplug-backend/src/routes/activityLog.js`
- `unplug-backend/src/app.js`

## Dashboard changes
`unplug-admin-dashboard.html` now:
- accepts `admin` and authorised `staff` accounts;
- reads `/admin/staff/access` after sign-in;
- hides sections the staff member cannot use;
- adds **Staff & Permissions** for Super Admin;
- lets Super Admin assign an existing account to a staff role;
- lets Super Admin change/revoke staff access;
- lets Super Admin edit built-in role permissions;
- lets Super Admin create/delete custom staff roles;
- makes Members & Users read-only when the role has view-only member access;
- hides account-credit controls unless finance-management access is present.

## Session behaviour
After staff access is granted or the staff role changes, that person should sign out and sign in again so their JWT contains `role='staff'`. Removing a staff assignment takes effect at the server capability check even if an old staff token still exists.

## Validation completed
- `node --check` passed for all modified/new backend JavaScript files.
- The dashboard's ~14.6k-line inline JavaScript passed `node --check` after extraction.
- A static permission-route mapping check passed for representative content, approvals, finance, members, media, pages, security, staff and search routes.

## Not yet claimed
A full PostgreSQL-backed integration test was not run because the downloaded repository still lacks the installed backend dependencies (`pg`, `embedded-postgres`, etc.). Do not treat static validation as a production integration test.

## Recommended production order later
1. Take a database backup.
2. Deploy backend code and run migration 185.
3. Confirm the existing Super Admin can sign in and access every section.
4. Create one low-risk test staff account (Editor is a good first test).
5. Sign in as that staff account in a separate/private browser and verify allowed + denied areas.
6. Only then deploy the updated dashboard broadly.
