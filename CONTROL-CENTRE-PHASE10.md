# Unplug Control Centre — Phase 10
## Member Signup → Services → Checkout → Payment → Fulfilment Audit

Date: 6 September 2026

### Scope audited
- Registration, email verification and login
- Directory package checkout and profile upgrades
- Article Submission
- Event Listing
- Gallery Bundle
- Top 10 Entry
- Competition Entry
- Marketplace Poster
- Highlights (article + directory)
- Page Banner advertising
- Edition Download
- Bulk Vote bundles
- Multi-service cart orders
- Vouchers, Unplug Credit, EFT confirmation, gateway readiness, payment fulfilment, reporting

### Current commercial flow
1. Account registration requires a contact number and verified email before login.
2. A member creates the service/submission first.
3. Server derives the real price; browser-supplied prices are not trusted.
4. Voucher and account credit are applied server-side.
5. Terms acceptance is stored on the payment/order.
6. EFT is currently the only live payment-initiation method. PayFast/Ozow remain disabled until a real hosted-checkout session builder exists.
7. Payment confirmation moves paid submissions into their real next state (usually admin review; immediate fulfilment for products such as downloads/votes where appropriate).
8. Admin sees payment/submission status in the Control Centre.

## High-risk defects found and fixed

### 1. Cross-account resource payment
Before Phase 10, most checkout paths priced a linked resource by ID without consistently proving the resource belonged to the signed-in buyer. A member could therefore attempt to quote/pay against another member's article, event, Directory profile, etc.

Fix: `src/utils/purchaseOwnership.js` provides one central ownership check used by both single-service checkout and cart checkout.

Protected resources include Directory packages/upgrades, competition entries, highlights, Marketplace, articles, events, gallery bundles, Top 10 entries and Page Banners.

### 2. Service-restricted voucher discounted the whole cart
A voucher restricted to one linked service type only had to match one item in a cart, but its percentage/fixed discount was calculated against the entire basket.

Example of the old risk: a 50% Article voucher in an Article + Event order could discount part of the Event too.

Fix: restricted vouchers now calculate their discount only from matching cart items.

### 3. Duplicate service in one cart
The server previously accepted the same `{linkedType, linkedId}` more than once in one order.

Fix: duplicate linked resources are rejected server-side.

### 4. Cart gateway bypass
Single-service checkout refused PayFast/Ozow while not live, but the multi-service cart could still accept those methods and return a fake `sandbox.*.example.com` URL.

Fix: cart and single checkout now share the same gateway-live gate.

### 5. Merchant secret was incorrectly treated as a live checkout integration
The code previously considered a gateway live as soon as a webhook-verification secret existed, even though no real hosted checkout-session builder exists.

Fix: PayFast/Ozow remain server-side disabled until real payment initiation is implemented. Webhook secrets alone cannot enable a fake redirect.

### 6. 21-day banner package mismatch
Migration 168 added a 21-day Page Banner at R785. Public copy mentioned it, but the fallback pricing table and several member-dashboard descriptions still omitted it.

Fix: fallback and member-facing descriptions now reconcile with 7 / 14 / 21 / 28 days at R300 / R550 / R785 / R1000 (unless admin-managed pricing changes the live database packages).

### 7. Paid-but-unfulfilled services could fail silently
Some flows mark money confirmed and then apply the purchased service. If that second step threw an error, a confirmed payment could remain while the service was not activated.

Fix: migration `187_payment_fulfilment_tracking.sql` adds:
- `fulfillment_status`
- `fulfillment_error`
- `fulfilled_at`

New confirmed payments are explicitly marked `applied` or `failed`. Historical confirmed payments are marked `assumed_applied`, because the migration cannot honestly claim it re-ran them.

### 8. Manual EFT revenue could be under-counted in analytics
The EFT confirmation path updated the database to confirmed, but passed the pre-update `pending` payment object to the payment analytics recorder. The recorder intentionally ignores non-confirmed objects.

Fix: manual EFT fulfilment/analytics now receives `status: 'confirmed'` explicitly.

### 9. Profile-upgrade fallback could throw
`payments.js` referenced `UPGRADE_FEE` as a fallback without defining it locally.

Fix: a last-known fallback of R250 is defined; the fee stored on the upgrade row remains authoritative.

## Checkout Health — new Control Centre screen
Location: Commerce & Payments → Checkout Health

Read permission: `finance.view`
Retry permission: `finance.manage`

The screen reports:
- Pending standalone payments + Rand total
- Pending cart orders + Rand total
- Pending items older than 7 days
- Services awaiting payment with no active payment row
- Confirmed payments whose service is still awaiting payment
- Explicit fulfilment failures and their error message
- Retry Fulfilment button for Finance Manage / Super Admin
- EFT / PayFast / Ozow initiation readiness
- Current duration-based Page Banner and Highlight package prices

The screen is read-only except the explicit fulfilment retry action. It does not alter payment statuses or approve submissions.

## Service journey matrix

| Service | Price source | After confirmed payment | Admin approval? |
|---|---|---|---|
| Directory package | Server package table/constants by person/business tier | profile → pending | Yes |
| Profile upgrade | fee stored on upgrade request (fallback R250) | tier changes, paid_at set | No separate content approval |
| Article | server fixed fee (R95 current) | article → pending | Yes |
| Event | server fixed fee (R300 current) | event → pending | Yes |
| Gallery bundle | server fixed fee (R100 current) | bundle/images → pending | Yes |
| Top 10 entry | entry_fee stored on entry (R100 current default) | entry → pending | Yes |
| Competition entry | competition's entry_fee stored on entry | entry → pending | Yes |
| Marketplace poster | server fixed fee (R500 current) | listing → pending, 30-day dates prepared | Yes |
| Article/Directory highlight | admin-managed service package | highlight → pending, run dates prepared | Yes |
| Page Banner | admin-managed service package | banner → pending_approval | Yes |
| Edition download | edition.download_price | approved edition purchase/download access | Immediate product fulfilment |
| Bulk Vote bundle | vote tier stored in database | paid votes inserted/confirmed | Immediate/portal-specific confirmation |
| Multi-service cart | sum of each real server-priced item | each real payments row applies its own effect | Depends on each service |

## Testing added
`test/commercialCheckoutGuards.static.test.js` can run without PostgreSQL/npm dev dependencies and verifies the critical guardrails in source.

Additional database-backed tests were added to `ordersCartCheckout.test.js` for:
- cross-account ownership rejection
- duplicate cart item rejection
- restricted voucher scope
- cart gateway refusal

The full database-backed suite still requires the repository's missing installed development dependencies (`embedded-postgres`, etc.) in a proper staging/development install.

## Deployment requirement
Phase 10 introduces migration:
- `187_payment_fulfilment_tracking.sql`

Do not deploy only the HTML file. Deploy the complete repository/migrations together in staging, run migrations, then test at least one EFT checkout for each important service before production.
