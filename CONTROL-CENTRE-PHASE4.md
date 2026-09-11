# Unplug Control Centre — Phase 4: Approval Centre

Phase 4 turns the existing unified approval queue into a clearer operational inbox without replacing the source-specific approval/payment endpoints.

## What changed

- Renamed the screen from **Approval Queue** to **Approval Centre** and clarified its role.
- Added summary cards for:
  - waiting for review
  - ready to approve
  - waiting for payment
  - older than seven days
- Added sorting:
  - Needs attention first (default)
  - Newest first
  - Oldest first
  - Highest value first
- Added age indicators to every submission so overdue work is visible.
- Surfaced the backend's existing **Request Changes** workflow inside the review modal.
  - Admin can select exact editable fields.
  - Admin can add a note to the member.
  - The request uses the existing server-side ownership/field whitelist.
  - The member is notified through the existing notification/email pathway.
  - The submission leaves the queue at `changes_requested` and returns as `resubmitted` when the member answers.
- The detail API now tells the UI whether a submission type can be returned for changes and why not when it cannot.
- Existing **Review / Save / Approve / Reject / Decline & Credit** behavior is retained.
- Existing bulk approve/reject behavior is retained.

## Safety / architecture decisions

- Approval/rejection is still executed by each source module's existing endpoint. Phase 4 does not duplicate publishing, payment confirmation, vote allocation, or fulfilment logic.
- Request Changes remains server-authoritative. The browser does not infer ownership or editable fields.
- Payment values/statuses remain read-only in editorial review.
- No new database migration is required by Phase 4 itself; it uses the change-request/status infrastructure already present in the repository.

## Files changed in Phase 4

- `unplug-admin-dashboard.html`
- `unplug-backend/src/routes/adminApprovalQueue.js`
- `CONTROL-CENTRE-PHASE4.md`

## Validation performed

- `node --check unplug-backend/src/routes/adminApprovalQueue.js`
- Extracted the dashboard's largest inline JavaScript block and ran `node --check` against it successfully.

## Integration test limitation

The downloaded repository does not contain `unplug-backend/node_modules`, so the backend test suite cannot currently run without installing dependencies (including the `embedded-postgres` dev dependency). This working copy should therefore still be staged/tested before production deployment.
