# Unplug Control Centre — Phase 3

## Scope
Safe content lifecycle for the generic **All Content** manager.

## Added
- WordPress-style **Trash** for reviewable content types.
- **Restore** to the exact status an item had before it was trashed.
- **Permanent Delete** only after an item has first been moved to Trash.
- Generic **Publish / Unpublish** controls using the site's existing approved/offline status behaviour.
- Read-only **Preview** panel before editing or taking action.
- Expanded status filters including Draft, Changes Requested, Resubmitted, Credit Issued, Expired, and Trash.
- Audit-log events for trash, restore, publication changes and permanent deletion.

## Database migration
`unplug-backend/db/migrations/176_admin_content_trash.sql`

The migration creates a compatibility ledger instead of adding `deleted_at` to every public table. This avoids the risk that older public queries would accidentally keep showing soft-deleted rows.

## Compatibility behaviour
When a reviewable item is moved to Trash:
1. Its current status is recorded in `admin_content_trash`.
2. Its existing status is changed to `rejected`, which the current public site already treats as offline.
3. Normal All Content queries hide active Trash rows.
4. The Trash filter shows those rows separately.
5. Restore returns the original status exactly.

## Deliberate limitation
The legacy Editions Calendar (`edcal`) has no status column and therefore is not included in generic Trash/Restore yet. It remains managed through its dedicated tooling. This is safer than retrofitting soft-delete behaviour without updating every public calendar query.

## Not included yet
- Generic Duplicate (required fields and unique slugs vary significantly by content type).
- Generic Feature (featuring is implemented differently across modules).
- Full content revision history/version rollback.

Those should be added deliberately per resource rather than via unsafe generic SQL copying.

## Validation performed
- `node --check unplug-backend/src/routes/adminContent.js`
- Extracted the dashboard inline JavaScript and passed it through `node --check`.

Full PostgreSQL-backed integration tests still require the backend development dependencies/environment that are not installed in this extracted repository.
