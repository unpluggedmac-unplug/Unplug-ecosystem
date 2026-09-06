# Unplug Phase 12 — Staging Smoke Test Matrix

Use only fake/test data. Record PASS / FAIL / BLOCKED plus notes.

| # | Area | Test | Expected result | Status |
|---:|---|---|---|---|
| 1 | Environment | Open staging homepage | `UNPLUG STAGING` ribbon visible | |
| 2 | Environment | Inspect browser network/API calls | Calls go only to staging Render API | |
| 3 | Environment | `/health/ready` | HTTP 200; DB ready | |
| 4 | Auth | Register fake member | Account created | |
| 5 | Auth | Verification flow | Verification succeeds/test email path works | |
| 6 | Auth | Login/logout | Session works and clears correctly | |
| 7 | Auth | Password reset | Reset works in staging | |
| 8 | Admin | Super Admin login | Full Control Centre visible | |
| 9 | Search | Search fake member/content | Correct grouped results | |
| 10 | Content | Create/edit content | Changes persist | |
| 11 | Content | Trash item | Item taken offline, not destroyed | |
| 12 | Content | Restore item | Original status restored | |
| 13 | Approval | Submit article | Appears in Approval Centre | |
| 14 | Approval | Request Changes | Member gets change state/notification | |
| 15 | Approval | Resubmit | Returns to queue | |
| 16 | Approval | Approve | Becomes live/active | |
| 17 | Media | Upload test image | Indexed in Media Library | |
| 18 | Media | Reuse image | Existing URL selectable/reusable | |
| 19 | Media | Trash in-use image | Action blocked with usage explanation | |
| 20 | Pages | Create page draft | Live page unchanged | |
| 21 | Pages | Reorder/hide block | Draft preview reflects changes | |
| 22 | Pages | Publish draft | Live staging page updates atomically | |
| 23 | Roles | Assign Editor | Editor sees only allowed modules | |
| 24 | Roles | Editor opens Finance URL directly | Backend denies access | |
| 25 | Roles | Finance opens editorial write URL | Backend denies if capability absent | |
| 26 | Reports | This Month report | KPIs load | |
| 27 | Reports | CSV export | File opens with same figures | |
| 28 | Reports | Excel export | File opens with same figures | |
| 29 | Ads | Create scheduled banner | Status and placement correct | |
| 30 | Ads | View banner | Impression increments | |
| 31 | Ads | Click banner | Click increments; CTR recalculates | |
| 32 | Pricing | Page banner packages | 7/14/21/28-day options match server quote | |
| 33 | Checkout | Article EFT quote | Server amount matches displayed amount | |
| 34 | Checkout | Cross-account resource attempt | Server blocks purchase | |
| 35 | Checkout | Multi-service cart | Correct totals; no duplicate resource | |
| 36 | Voucher | Service-specific voucher | Discounts matching service only | |
| 37 | Payment | Confirm fake EFT in Admin | Payment becomes confirmed | |
| 38 | Fulfilment | Confirmed EFT applies service | Service advances from awaiting payment | |
| 39 | Fulfilment | Create controlled failure | Checkout Health shows failure | |
| 40 | Fulfilment | Retry controlled failure | Retry applies after cause is corrected | |
| 41 | Analytics | Confirm EFT | Revenue appears in report | |
| 42 | Audit | Perform admin changes | Staff/admin actions appear in activity log | |
| 43 | Resend | Trigger safe test email | Staging/test recipient receives it | |
| 44 | Security | Staging API without allowed Origin | CORS refuses browser request | |
| 45 | Security | Staff searches finance without permission | Finance result not returned | |

## Release gate
No production merge while any of #1–3, #8, #13–16, #20–24, #32–42 or #44–45 is FAIL.
