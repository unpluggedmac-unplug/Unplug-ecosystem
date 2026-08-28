# Unplug Magazine — Master Functional Specification v2.0

*Extracted from `vers UNPLUG MAGAZINE.wps` on 28 August 2026. Do not edit — this is a faithful extraction, not a working document. Later tasks reference sections by the `§` numbers below.*

**A note on the numbering.** The source document's own numbering is uneven: the top level runs §1–§5, then jumps to §11–§27, with `MODULE 1`–`MODULE 10` headings sitting in the gap, and §11 restarts an inner 1–16 list of its own. That is preserved exactly as written — renumbering would break every reference back to the original.

**On the tables.** Word stores table cells as separate paragraphs. Runs of short cells are joined with `·` on one line; no table structure is invented.

---
UNPLUG MAGAZINE
FUNCTIONAL SPECIFICATION — MASTER DOCUMENT
Website:  HYPERLINK "http://www.unplugnews.com/" www.unplugnews.comDocument: Unplug Platform Functional SpecificationVersion: 2.0 — Developer Build SpecificationStatus: Approved Business LogicPlatform Model: Digital Magazine + Visibility/Promotion Platform + Community Platform

## §1. PLATFORM PURPOSE

Unplug is a hybrid digital platform combining:
A digital magazine/news platform
A digital visibility and promotion platform
A community platform where users can publish, participate, compete, vote and discover opportunities
The platform must allow both individuals and businesses to participate.
The most important user journeys are:
- Join Unplug · Create a profile · Publish a story · Submit an event · Purchase visibility · Enter competitions · Vote · Purchase bulk votes
Discover businesses, individuals and events
Manage all activity through My Unplug

## §2. CORE PLATFORM PRINCIPLES

### §2.1 Public users

A visitor who has not created an account can:
- Browse the website · Read articles · View profiles · View directory listings · View events
View marketplace listings
- View gallery content · View competitions · Vote online · View public rankings
An account is NOT required for:
- Reading articles · Online voting · Purchasing bulk votes
An account IS required for:
- Publishing an article · Submitting an event · Buying advertising
Creating/managing profiles
Purchasing other paid services requiring submission
Entering competitions

## §3. MAIN USER ACCOUNT MODEL

### §3.1 Join Unplug

Anyone may join.
The primary CTA should be:
- JOIN UNPLUG · The user selects: · Individual · Business
The account creation process should be quick.
Step 1 — Account Creation
- Fields: · Field · Required · First name · Yes · Surname · Yes · Email address · Yes · Mobile/contact number · Yes · Password · Yes · Confirm password · Yes · Individual/Business · Yes
Accept Terms & Conditions
- Yes · Accept Privacy Policy · Yes
Business users additionally provide:
- Field · Required · Business name · Yes
Business registration information
- Admin-configurable · Business contact person · Yes
The system must verify the email address.

## §4. MY UNPLUG

After login, normal public navigation remains visible.
A new navigation item appears:
MY UNPLUG
My Unplug should contain:
- Dashboard · My Profile · My Services · My Submissions · My Articles · My Events · My Listings · My Advertising · My Competitions
My Votes / Competition Activity
- My Orders · My Payments · My Credits · My Invoices · Notifications · Reading List · Account Settings · Help / Support

## §5. USER DASHBOARD

The dashboard should provide an immediate overview.
- Display: · Profile · Profile type
Profile completion percentage
- Visibility status · Edit profile · Services · Active services · Pending services · Expiring services · Expired services
Services requiring changes
Services awaiting payment
- Financial · Outstanding payments · Unplug Credit balance · Recent invoices · Payment history · Activity · Recent submissions · Competition entries · Competition votes · Notifications

## MODULE 1 — MEMBERSHIP & ACCOUNT

### §1.1 Purpose

Membership creates the user's account and provides access to user-specific functionality.
Membership itself is free.

### §1.2 Membership pathway

- JOIN UNPLUG · ↓
Choose Individual / Business
- ↓ · Create Account · ↓ · Verify Email · ↓ · Account Created · ↓ · Quick Profile · ↓ · My Unplug

### §1.3 Quick profile

Users should NOT be forced to complete every profile field during registration.
The system creates a basic account immediately after registration.
The user can complete their full profile later.

### §1.4 Profile visibility

- A profile remains: · PRIVATE / UNPUBLISHED
until the user publishes it or an applicable paid service is approved.

### §1.5 One profile per user

- A user may have: · ONE primary profile. · The profile may be: · IndividualOR · Business
depending on the account type.

## MODULE 2 — PROFILES

### §2.1 Individual Profile

Individual profile fields should include:
- Identity · First name · Surname · Display name · Profile image · Biography · Profession · Category · Subcategory · Location · Suburb · Town · Province · Country · Contact · Email · Contact number · Website · Facebook · Instagram · TikTok · YouTube · Other social links · Additional information · Package-dependent: · Services · Skills · Portfolio · Gallery · Additional description · CTA

### §2.2 Business Profile

- Fields: · Business identity · Business name · Logo · Business description · Category · Subcategory · Tagline · Address · Street address · Suburb · Town · Province · Country · Contact · Contact person · Telephone · Mobile · Email · Website · Social · Facebook · Instagram · TikTok · YouTube · LinkedIn · Other · Business information · Package-dependent: · Services · Products · Business hours · Gallery · Map location · CTA · Additional information

### §2.3 Free vs Paid Profile

A free profile should be simpler.
A paid profile is a significantly more detailed directory/visibility listing.
The exact fields available must be controlled by the selected package.
- Package structure · Basic · Standard · Premium
The administrator must be able to modify:
- Price · Available fields · Images · Features · Duration · Placement · Visibility
WITHOUT requiring code changes.

### §2.4 Profile workflow

- My Unplug · ↓
Create / Complete Profile
- ↓ · Save Draft · ↓ · Preview · ↓ · Publish Profile
For paid profile services:
- Choose Package · ↓ · Complete Profile · ↓ · Preview · ↓ · Submit · ↓ · Reference Number · ↓ · Payment · ↓ · Admin Review · ↓ · Approved · ↓ · Published
Individual and Business Profiles do NOT require human approval according to the approved rules unless a separate paid listing/featured service requires approval.

## MODULE 3 — PUBLISH AN ARTICLE

### §3.1 Access

- Articles are: · MEMBERS ONLY
The user must have an Unplug account.

### §3.2 Article price

Current configured price:
R95
The administrator must be able to change the price.

### §3.3 Article pathway

- My Unplug · ↓ · Publish an Article · ↓ · Article Details · ↓ · Article Content · ↓ · Images · ↓ · Video / Social Media · ↓ · Author · ↓ · Preview · ↓ · Terms · ↓ · Submit · ↓ · Reference Number · ↓ · Payment · ↓ · Admin Review · ↓ · Approved · ↓ · Published

### §3.4 Article Details

- Fields: · Article title · Subtitle · Category · Subcategory
Short description/excerpt
- SEO title · Meta description · Keywords/tags · Cover image · Validation · Title:Required
Word count:Minimum 300 words
Maximum:2,500 words

### §3.5 Article Content

- Required: · Article body
The editor should provide:
- Bold · Italic · Headings · Paragraphs · Bullet lists · Numbered lists · Hyperlinks · Quotes · Undo/redo

### §3.6 Article images

Maximum:
1 cover image + 5 additional images
- Therefore: · Maximum 6 images total. · Accepted: · JPG/JPEG · PNG · WEBP · Maximum:
10 MB per image
Each additional image should support:
- Caption · Image credit · Photographer credit

### §3.7 Article video/social media

- Users may submit: · YouTube URL · TikTok URL · Instagram URL
The system validates the URL.
The developer should not require users to upload video files.

### §3.8 Article author

- User selects: · Individual profile name · Business name · Custom author name

### §3.9 Article submission statuses

- DRAFT · ↓ · SUBMITTED · ↓ · AWAITING_PAYMENT · ↓ · PAYMENT_RECEIVED · ↓ · UNDER_REVIEW · ↓ · CHANGES_REQUESTED · ↓ · RESUBMITTED · ↓ · APPROVED · ↓ · PUBLISHED · Alternative: · REJECTED · ↓ · CREDIT_ISSUED

### §3.10 Human approval

Articles require human/admin approval.
- Admin may: · Approve · Request changes · Reject · Edit where permitted · Schedule publication · Publish · Unpublish
If changes are requested, only the requested fields should need editing.
- Once changed: · User submits changes · ↓
Automatically returns to Admin Review

### §3.11 Article editing after publication

Post-publication editing is:
ADMIN CONTROLLED
Minor changes may be made where appropriate.
Major changes may require review.
The user cannot directly alter an approved/published article without admin involvement.

## MODULE 4 — DIRECTORY & FEATURED LISTINGS

### §4.1 Directory Listing

Directory listings are paid services.
The system should display packages dynamically.
- Workflow · Services · ↓ · Directory Listing · ↓ · Individual / Business · ↓ · Choose Package · ↓ · Complete Listing · ↓ · Upload Media · ↓ · Preview · ↓ · Submit · ↓ · Reference Number · ↓ · Payment · ↓ · Admin Review · ↓ · Approved · ↓ · Published

### §4.2 Directory fields

Fields are package-dependent.
- The package determines: · Number of fields · Number of images · Description length · Services · Contact information · Social links · Map · CTA · Gallery · Placement

### §4.3 Directory approval

- Human approval: · YES · Admin can: · Approve · Request changes · Reject · Edit · Publish · Unpublish · Suspend

### §4.4 Featured / Highlighted Listing

- Current pricing: · Duration · Price
7 days
R250
14 days
R300
21 days
R350
28 days
R400
The administrator can change these values.
Featured listing means enhanced visual treatment and priority placement within the applicable directory/category.
- Homepage appearance is: · ADMIN DECISION
It should not automatically appear on the homepage unless configured/admin selected.

## MODULE 5 — EVENTS & EVENT PROMOTION

### §5.1 Event Listing

Event listings require an account.
- Human approval: · YES · Event pathway · Submit Event · ↓ · Event Details · ↓ · Date & Time · ↓ · Location · ↓ · Ticket Information · ↓ · Images · ↓ · Promotion Options · ↓ · Preview · ↓ · Submit · ↓ · Reference Number · ↓ · Payment · ↓ · Admin Review · ↓ · Approved · ↓ · Published

### §5.2 Event fields

- Basic · Event name · Event description · Category · Subcategory · Event date · Start time · End time · Location
Both options are supported:
- Physical location · Online/virtual event · For physical events: · Venue name · Street address · Suburb · Town · Province · Country · Map coordinates/location · For online events: · Online event URL

### §5.3 Ticketing

Unplug does NOT process event tickets under this specification.
- The listing may contain: · Ticket price · Ticket information · Ticket URL
Booking/contact information
The external ticketing/booking destination must be clearly displayed.

### §5.4 Event images

Maximum:
5 images
- Accepted: · JPG/JPEG · PNG · WEBP · Maximum:
10 MB each

### §5.5 Event expiry

Event listing automatically expires:
At the event date/time.
The system must hide/disable the listing automatically.

### §5.6 Event Promotion

- Approved packages: · Event Boost · R350 · Event Feature · R650 · Event Dominator · R1,000
The administrator must be able to modify:
- Price · Duration · Features · Placement · Promotional channels

## MODULE 6 — ADVERTISING

Advertising services require:
- Account · Completed submission · Payment · Admin approval

### §6.1 Homepage Banner

Current configured price:
R1,000
Recommended technical creative:
1920 × 1080
- JPG · PNG · WEBP · Maximum 10 MB · Destination URL · Fields: · Campaign name · Advertiser · Banner · Destination URL · Start date · End date · Package · Contact person · Contact details

### §6.2 Page Banner

Current configured service:
Page Banner Advertising
The system must support package-based pricing.
Existing pricing configured in the platform may be maintained by Admin.
The system should NOT hard-code pricing.

### §6.3 Advertising workflow

- Advertising · ↓ · Choose Advertising Type · ↓ · Choose Package · ↓ · Upload Creative · ↓ · Enter Destination · ↓ · Choose Campaign Dates · ↓ · Preview · ↓ · Submit · ↓ · Reference Number · ↓ · Payment · ↓ · Admin Review · ↓ · Approved · ↓ · Campaign Active · ↓ · Automatic Expiry

### §6.4 Advertising approval

- Human approval: · YES
Admin must approve advertising before publication.

## MODULE 7 — MARKETPLACE & GALLERY

### §7.1 Marketplace

- Marketplace is: · BUSINESSES ONLY · Marketplace supports: · Products · Services

### §7.2 Marketplace pathway

- Marketplace · ↓ · Create Listing · ↓ · Product / Service · ↓ · Details · ↓ · Pricing · ↓ · Image · ↓ · Contact Information · ↓ · Preview · ↓ · Submit · ↓ · Reference · ↓ · Payment · ↓ · Admin Review · ↓ · Approved · ↓ · Published

### §7.3 Marketplace fields

- Required · Product/service name · Description · Category · Business name · Contact information · One image · Pricing · The user may select: · Fixed price · Price range · Contact for price

### §7.4 Marketplace image

Maximum:
1 image
- Accepted: · JPG/JPEG · PNG · WEBP · Maximum:
10 MB

### §7.5 Gallery Image Submission

Current configured price:
- R100 for 3 images · Fields: · Gallery title · Image 1 · Image 2 · Image 3 · Caption · Image credit · Photographer · Description · Category
Gallery submission requires admin approval.

## MODULE 8 — COMPETITIONS & CONTESTANT PROFILES

### §8.1 Competition entries

- Competition entries are: · ALWAYS PAID
Competition entry requires:
- Account · Submission · Payment · Admin approval

### §8.2 Competition pathway

- Competition · ↓ · Choose Competition · ↓ · Competition Information · ↓ · Entry Form · ↓ · Contestant Information · ↓ · Contestant Profile · ↓ · Images / Media · ↓ · Terms & Conditions · ↓ · Preview · ↓ · Submit · ↓ · Reference Number · ↓ · Payment · ↓ · Admin Review · ↓ · Approved · ↓
10-Digit Contestant Code Generated
↓
Public Contestant Profile Published

### §8.3 Contestant code

A unique 10-digit contestant code is generated:
AFTER PAYMENT AND ADMIN APPROVAL
- The code is: · Unique · Public
Associated with the contestant
Used for bulk voting
Used as the EFT payment reference for bulk votes

### §8.4 Contestant public profile

The contestant profile must display relevant public information.
It must include the contestant's:
10-digit voting code
The public can use the code when purchasing bulk votes.

### §8.5 Contestant dashboard

- The contestant can see: · Competition entered · Contestant code
Exact verified vote count
- Online vote count · Bulk vote count · Current ranking · Voting activity · Competition closing date · Competition status
The contestant must see the:
EXACT NUMBER OF VERIFIED VOTES

## MODULE 9 — VOTING, BULK VOTES & RANKINGS

### §9.1 Online voting

- Online voting: · Requires NO account · Requires NO payment
Is available to the public

### §9.2 Daily online voting rule

A voter may cast:
MAXIMUM 5 online votes per calendar day across the entire competition.
The votes must be:
spread across contestants.
- Example: · Contestant A — 2 votes · Contestant B — 1 vote · Contestant C — 1 vote · Contestant D — 1 vote · Total:
5 votes
The following is NOT allowed:
Contestant A — 5 votes
The system must enforce distribution across at least two contestants.

### §9.3 Multiple contestants

A voter may vote for multiple contestants.
No account is required.

### §9.4 Anti-abuse

The system must implement anti-abuse controls.
The developer must NOT rely solely on IP address.
Controls should consider appropriate technical signals such as:
- IP · Browser/device signals · Rate limiting · Cookies/session controls
Automated voting detection
Suspicious activity monitoring
The objective is to prevent:
- Bots · Automated voting · Vote manipulation · Excessive voting · Scripted submissions
while minimizing legitimate voters being incorrectly blocked.

### §9.5 Bulk votes

- Bulk voting packages: · Package · Votes · Price · Starter
10
- R10 · Supporter
50
- R45 · Champion
100
- R80 · Power
250
- R175 · Dominator
500
- R300 · Ultimate
1,000
R500
These should be ADMIN-CONFIGURABLE.

### §9.6 Bulk vote payment

- Bulk votes can be paid: · Online · EFT
The contestant's unique 10-digit code must be used as the EFT reference.
- Example: · Contestant Code:
1234567890
EFT Reference:
1234567890

### §9.7 Bulk vote approval

Bulk vote transactions require:
ADMIN APPROVAL
Votes are NOT added to the contestant's verified total until payment has been verified/approved.

### §9.8 Bulk vote workflow — EFT

Public selects contestant
↓
Enters 10-digit contestant code
↓
Chooses bulk vote package
- ↓ · Chooses EFT · ↓
System creates payment/reference
- ↓ · User makes EFT payment · ↓ · Admin verifies payment · ↓ · Admin approves · ↓ · Votes added · ↓
Ranking immediately recalculated
- ↓ · Contestant notification

### §9.9 Bulk vote workflow — Online

- Select contestant · ↓ · Select bulk vote package · ↓ · Online payment · ↓ · Payment verified · ↓ · Admin approval · ↓ · Votes added · ↓
Ranking immediately recalculated

### §9.10 Rankings

Rankings update:
Immediately after verified votes are added.
- Public sees: · Contestant · Position/rank
Relevant public information
Contestant sees:
Exact verified vote count
- Online votes · Bulk votes · Ranking

### §9.11 Tie-breaking

If contestants have the same total verified vote count:
The contestant with the most online votes ranks higher.

### §9.12 Voting closure

Voting may close through:
Scheduled closing date/time
Admin manually closing
Automatic competition closure
Once closed:
New online votes rejected
New bulk vote submissions rejected or placed into pending review according to admin configuration
Rankings become final after all valid pending votes have been processed
Competition status changes to CLOSED

## MODULE 10 — CHECKOUT, PAYMENTS, CREDITS, ADMIN & NOTIFICATIONS

### §10.1 Universal payment principle

For normal paid services:
User completes submission
- ↓ · User reviews submission · ↓
System generates reference number
↓
User selects payment method
- ↓ · Payment · ↓ · Admin verifies payment · ↓ · Admin reviews submission · ↓
Approve / Changes / Reject
- ↓ · Service activated · Important:
The reference number must be generated before payment.
The reference number becomes the link between:
- User · Submission · Service · Payment · Admin approval · Invoice · Credit · Publication

### §10.2 EFT payment

- For EFT: · Submission · ↓ · Reference generated · ↓
EFT instructions displayed
- ↓ · User makes payment · ↓
User submits proof if required
- ↓ · Admin verifies payment · ↓
Payment status = VERIFIED
↓
Submission moves to ADMIN REVIEW
The user must use the generated reference number when making payment.

### §10.3 Online payment

Where online payment is available:
- Submission · ↓ · Reference generated · ↓ · Online Checkout · ↓ · Payment · ↓ · Payment confirmation · ↓ · Admin Review
The payment provider's transaction ID must be stored against the Unplug reference number.

### §10.4 Multiple services in one checkout

Users MUST be able to purchase multiple services in one checkout.
- Example: · Directory Listing · + · Featured Listing · + · Event Promotion · + · Gallery
The checkout should show:
- Individual service · Quantity · Duration · Price · Subtotal · Unplug Credit · Amount payable · Payment method · Total
Each service retains its own internal service record and reference relationship.

### §10.5 Invoice/receipt

Users receive an invoice/receipt.
- It should contain: · Unplug branding · User name
Business name where applicable
- Email · Contact number · Invoice number · Unplug reference number · Service · Description · Quantity · Price · Discount/credit
VAT/tax information where applicable
- Total · Payment method · Payment status · Date · Terms

### §10.6 Unplug Credit

Users have an Unplug Credit balance.
Credit can be used toward eligible:
- Articles · Advertising · Listings · Events · Other services
Credits do not expire under the approved business rule.

### §10.7 Rejected paid submission

If the user has paid and Unplug rejects the submission:
- NO CASH REFUND · Instead:
Unplug Credit is issued to the user's account.
The credit amount must be recorded against:
- Original reference · Original payment · Rejection reason · Credit amount · Date · Admin
The full Terms & Conditions must govern this process.

### §10.8 Cancellation

Current approved cancellation requirement:
7 working days' notice
No cash refund is issued where the applicable terms provide credit instead.

### §10.9 Renewal

Expired services should display:
RENEW
The user should be able to renew with one click.
The renewal process should prepopulate:
- Existing service · Existing information
Existing media where applicable
- User only needs to: · Confirm/update · Review · Pay · Submit

### §10.10 Upgrade

Users should be able to upgrade eligible services.
- Example: · Basic · ↓ · Upgrade · ↓ · Standard
The system should calculate the applicable upgrade amount according to the configured pricing rules.

### §10.11 Service expiry

Paid services automatically expire according to their configured duration.
Default behaviour:
DISABLE / HIDE SERVICE WHEN EXPIRED
The underlying record must remain in the database for:
- History · Reporting · Renewal · Audit · Admin review

### §10.12 ADMIN SYSTEM

Admin has full administrative access.
Admin dashboard should display:
- Submissions · New · Awaiting payment · Payment received · Under review · Changes requested · Resubmitted · Approved · Rejected · Published · Expired · Payments · Pending
EFT awaiting verification
- Paid · Verified · Failed
Refunded/credited where applicable
- Competitions · Entries · Contestants · Codes · Online votes · Bulk votes · Pending votes · Rankings
Suspicious voting activity
- Competition closure · Content · Articles · Events · Profiles · Directory · Marketplace · Gallery · Advertising

### §10.13 ADMIN APPROVAL ACTIONS

- Admin may: · Approve · Reject · Request changes · Edit · Publish · Unpublish · Suspend · Extend · Expire · Renew · Upgrade · Issue credit · Verify payment · Reject payment · Manage references · Manage competition votes · Close competitions

### §10.14 REQUEST CHANGES

When admin requests changes:
Admin must select/request specific fields.
- Example: · Changes Required · ☑ Cover Image · ☑ Article Introduction · ☐ Author · ☐ Category · ☐ Social Links · The user should see: · ACTION REQUIRED
The user edits only the requested fields.
- After submission: · CHANGES_SUBMITTED · ↓ · UNDER_ADMIN_REVIEW

### §10.15 USER EDITING AFTER APPROVAL

Users cannot directly edit an approved service.
- Instead: · Request an Edit
The request is sent to Admin.
- Admin decides whether: · Change is approved · Change is rejected · User must resubmit

### §10.16 ADMIN COMMUNICATION

Primary communication channels:
- Email · WhatsApp · My Unplug notifications
Important transactional messages must also remain visible inside My Unplug.

### §10.17 NOTIFICATION EVENTS

The system should notify users when:
- Account created · Email verified · Profile created · Submission received · Reference generated
Payment instructions issued
Payment received
EFT awaiting verification
- Payment verified · Submission under review · Changes requested · Changes resubmitted · Submission approved · Submission rejected · Credit issued · Service published
Service approaching expiry
- Service expired · Renewal available · Upgrade available
Competition entry approved
Contestant code generated
- Bulk vote received · Bulk vote approved · Votes added · Ranking changes · Competition closes

## §11. UNIVERSAL SUBMISSION DESIGN

Every paid/service pathway should follow a consistent user interface.
Standard pathway
1. Choose Service
↓
2. Understand Service
↓
3. Choose Package
↓
4. Enter Details
↓
5. Upload Media
↓
6. Configure Options
↓
7. Preview
↓
8. Accept Terms
↓
9. Submit
↓
10. Reference Created
↓
11. Payment
↓
12. Admin Review
↓
13. Approval / Changes / Rejection
↓
14. Publication / Activation
↓
15. Expiry
↓
16. Renewal / Upgrade
The user should always know:
- WHERE AM I? · WHAT DO I NEED TO DO? · WHAT HAPPENS NEXT?

## §12. SERVICE INTRODUCTION SCREEN

Every service should begin with an information screen.
- It must display: · Service name · What is it?
Short plain-language explanation.
Who is it for?
Individual / Business / Both.
- Price · Clearly displayed. · What's included? · Bullet list. · What do I need?
Required information/media.
- Approval · Clearly state:
"This service requires Unplug admin approval."
Processing
Explain that payment does not automatically mean publication.
Duration
Clearly display how long the service remains active.
Important terms
Provide link to relevant Terms & Conditions.
- CTA: · START

## §13. SAVE & CONTINUE

Every lengthy service form should support:
SAVE DRAFT
The user can leave and return later.
Drafts should not create:
- Reference number · Payment obligation · Published content · until the user submits.

## §14. PREVIEW SYSTEM

Before submission, users must see a realistic preview.
The preview should resemble how the content will appear publicly.
- The user can: · EDIT · or · SUBMIT
No payment should be required before the final review screen.

## §15. REFERENCE NUMBER SYSTEM

Every submitted service receives a unique reference number.
- Recommended format: · UNP-2026-000001
The exact format may be configured by Admin.
- Reference must be: · Unique · Searchable · Immutable
Stored against submission
- Stored against payment · Displayed to user · Displayed to Admin · Included in invoices
Used for EFT reconciliation
Exception:
Top 10/Top 20 contestant codes are separate unique 10-digit codes.

## §16. DATABASE STATUS MODEL

- User · ACTIVE · SUSPENDED · DEACTIVATED · Profile · DRAFT · PRIVATE · PUBLISHED · SUSPENDED · ARCHIVED · Submission · DRAFT · SUBMITTED · AWAITING_PAYMENT · PAYMENT_RECEIVED · UNDER_REVIEW · CHANGES_REQUESTED · RESUBMITTED · APPROVED · PUBLISHED · REJECTED · CREDIT_ISSUED · EXPIRED · CANCELLED · Payment · PENDING · AWAITING_EFT · PROOF_RECEIVED · PROCESSING · PAID · VERIFIED · FAILED · CANCELLED · Service · PENDING · ACTIVE · PAUSED · EXPIRED · SUSPENDED · CANCELLED · Competition · DRAFT · OPEN · CLOSED · JUDGING · FINAL · ARCHIVED · Contestant · PENDING · PAYMENT_RECEIVED · UNDER_REVIEW · APPROVED · ACTIVE · DISQUALIFIED · WITHDRAWN · FINAL · Vote · PENDING · VALIDATED · APPROVED · REJECTED · REVERSED

## §17. USER PERMISSIONS

- Public visitor · Can: · Read · Search · Browse · View profiles · View listings · View events · Vote · View rankings · Cannot: · Publish · Submit services · Access My Unplug · Manage profiles · Registered member · Can: · Create/manage profile · Publish articles · Submit events · Purchase services · Manage submissions · View invoices · View credits · Enter competitions
Manage competition activity
Business member
All member permissions plus:
- Business profile · Marketplace access · Business directory · Business services · Contestant
All applicable member permissions plus:
- Contestant dashboard · Contestant code · Vote statistics · Ranking · Competition information · Admin
Full platform management.

## §18. ACCEPTANCE CRITERIA

The developer must not consider the platform complete merely because the forms work.
The following must all work.
- Account · User can register
User can select Individual/Business
- Email verification works · User can log in · My Unplug appears
Public navigation remains
- Profiles · One profile per user
Profile can remain private
User can save incomplete profile
Paid package controls available fields
- Profile can be published · Articles · Members only
300–2,500 words
Cover + 5 additional images
10 MB limit
YouTube/TikTok/Instagram links
- Author selection works · Preview works · Reference generated · Payment linked · Admin approval required · Changes return to admin · Publication works · Events · Account required · Event date/time required
Physical/online location supported
Up to 5 images
External ticket link supported
Automatically expires at event date/time
- Admin approval works · Advertising · Account required · Package selection works · Creative upload works · Campaign dates work · Admin approval required · Automatic expiry works · Marketplace · Business accounts only
Product/service selection
- One image · Three pricing options · Admin approval · Gallery
Exactly configured number of images
Current package supports 3 images
Caption/credit/photographer supported
- Admin approval · Competition · Paid entry · Admin approval · Unique 10-digit code
Public contestant profile
Code displayed
Bulk votes connected to code
- Online votes work · Rankings update · Tie-breaking works
Competition closes correctly
- Voting · No account required
Maximum 5 online votes per calendar day
Votes must be distributed across contestants
Multiple contestants allowed
Anti-abuse controls active
Valid votes affect ranking immediately
Public sees ranking
Contestant sees exact verified count
Payments
Reference generated before payment
- EFT reference displayed · Online payment supported · Admin can verify EFT
Payment tied to submission
Invoice generated
Multiple services can be purchased
Credits can be applied
Rejected paid submissions generate credit according to T&Cs
- Renewal works · Upgrade works · Notifications · Email works
WhatsApp notification workflow works
My Unplug notifications work
Admin and user receive appropriate status updates

## §19. CRITICAL USER EXPERIENCE REQUIREMENT

The website must never make the user guess what happens next.
Every service should clearly communicate:
- BEFORE STARTING · What is this? · Who can use it? · What does it cost? · What do I need?
Does it require approval?
- How long will it take? · DURING SUBMISSION · Show: · Step X of Y
with a progress indicator.
- Example: · Service · ●────○────○────○────○
1     2    3    4    5
- BEFORE SUBMISSION · Show: · REVIEW YOUR SUBMISSION · AFTER SUBMISSION · Show: · Submission received
Reference: UNP-2026-000123
Next step: Make payment using this reference.
- AFTER PAYMENT · Show:
Payment received / awaiting verification
- DURING ADMIN REVIEW · Show: · Under Review · IF CHANGES ARE REQUIRED · Show: · Action Required
Clearly state exactly what must be changed.
- AFTER APPROVAL · Show: · Approved · Then: · Published / Active · BEFORE EXPIRY · Show:
Your service expires on [date].
- CTA: · RENEW

## §20. ADMIN CONFIGURATION REQUIREMENT

Prices, packages and service rules should NOT be hard-coded.
Admin should be able to configure:
- Service name · Service description · Price · Package · Duration · Required fields · Optional fields · Image limits · File size · Approval requirement · Publication rules · Expiry rules · Renewal availability · Upgrade options · Homepage placement · Category · Eligibility · Active/inactive status
This will allow Unplug to change its business model without requiring a developer every time a price or package changes.

## §21. AUDIT LOG

Every significant action must be logged.
- Examples: · USER_CREATED · PROFILE_CREATED · SUBMISSION_CREATED · REFERENCE_GENERATED · PAYMENT_SUBMITTED · PAYMENT_VERIFIED · ADMIN_APPROVED · ADMIN_REJECTED · CHANGES_REQUESTED · USER_RESUBMITTED · SERVICE_PUBLISHED · SERVICE_EXPIRED · CREDIT_ISSUED · VOTE_SUBMITTED · VOTE_APPROVED · VOTE_REJECTED · RANKING_UPDATED · COMPETITION_CLOSED · Each log should record: · User · Admin where applicable · Action · Date/time · Reference · Previous status · New status · Relevant notes

## §22. MASTER SERVICE MATRIX

- Service · Account · Paid · Admin Approval · Reference · Auto Expiry · Membership · No/Yes · Free · No · No · No · Individual Profile · Yes · Configurable · No · If paid · Configurable · Business Profile · Yes · Configurable · No · If paid · Configurable · Directory Listing · Yes · Yes · Yes · Yes · Yes · Featured Listing · Yes · Yes · Yes · Yes · Yes · Publish Article · Yes · Yes · Yes · Yes · Publication-based · Event Listing · Yes · Yes · Yes · Yes · Event date/time · Event Promotion · Yes · Yes · Yes · Yes · Yes · Homepage Banner · Yes · Yes · Yes · Yes · Yes · Page Banner · Yes · Yes · Yes · Yes · Yes · Marketplace · Yes · Yes · Yes · Yes · Configurable · Gallery · Yes · Yes · Yes · Yes · Configurable · Competition Entry · Yes · Yes · Yes · Yes · Competition · Online Voting · No · Free · No · No · Competition · Bulk Voting · No/Yes · Yes · Yes · Contestant code · Competition

## §23. MOST IMPORTANT NAVIGATION STRUCTURE

The current main navigation should remain.
- Add: · SERVICES
as a prominent navigation item.
- Add: · JOIN UNPLUG · as a prominent CTA. · After login: · MY UNPLUG
is added while normal public navigation remains.
On mobile:
All navigation remains accessible through the hamburger menu.

## §24. SERVICES MENU

The Services menu should make the platform understandable.
- Recommended structure: · CONTENT · Publish an Article · PROFILES & DIRECTORY · Individual Profile · Business Profile · Directory Listing · Featured Listing · EVENTS · Event Listing · Event Promotion · ADVERTISING · Homepage Banner · Page Banner · MARKETPLACE · Marketplace Listing · Gallery Submission · COMPETITIONS · Top 10 / Top 20 · Other Competitions · Vote · Buy Bulk Votes
Each service page should explain:
WHAT IT IS → WHO IT IS FOR → PRICE → WHAT'S INCLUDED → WHAT YOU NEED → HOW IT WORKS → START

## §25. FINAL DEVELOPER PRINCIPLE

The developer should build the platform around a consistent service engine, rather than creating completely separate systems for every service.
The common architecture should be:
- USER · ↓ · SERVICE · ↓ · PACKAGE · ↓ · SUBMISSION · ↓ · REFERENCE · ↓ · PAYMENT · ↓ · ADMIN REVIEW · ↓
APPROVAL / CHANGES / REJECTION
- ↓ · SERVICE ACTIVATION · ↓ · PUBLICATION · ↓ · EXPIRY · ↓ · RENEW / UPGRADE
Competitions and voting extend this architecture with:
- CONTESTANT · ↓
10-DIGIT CODE
↓
ONLINE VOTES / BULK VOTES
- ↓ · VERIFICATION · ↓ · VERIFIED VOTE TOTAL · ↓ · RANKING · ↓ · COMPETITION CLOSURE
This common architecture is important because it will make Unplug easier to maintain, expand and monetise as new services are introduced.

## §26. DEFINITION OF DONE

The Unplug platform is considered functionally complete only when:
Every active service has a defined pathway.
Every pathway has defined steps.
Every step has defined fields.
Every required field has validation.
Every submission has a status.
Every paid submission has a reference.
Every payment is connected to the reference.
Every approval pathway is defined.
Every rejection pathway is defined.
Every change-request pathway is defined.
Every paid rejection is handled through Unplug Credit according to the Terms.
Every service has an expiry rule where applicable.
Every service can be renewed where applicable.
Every eligible service can be upgraded.
Every important action is logged.
Users can see their submissions and statuses in My Unplug.
Admin can manage the complete lifecycle.
Notifications are generated at every important status change.
Competition codes and voting are independently traceable.
The public and contestants see different levels of voting information according to the approved rules.
Mobile and desktop pathways use the same business logic.
Users always know what step they are on and what happens next.

## §27. FINAL BUSINESS MODEL

The completed Unplug platform therefore operates as:
DIGITAL MAGAZINE+MEMBERSHIP COMMUNITY+PROFILES & DIRECTORY+CONTENT PUBLISHING+EVENT DISCOVERY+ADVERTISING+MARKETPLACE+COMPETITIONS+VOTING+DIGITAL VISIBILITY SERVICES
The central user journey is:
JOIN → CREATE PROFILE → DISCOVER → PARTICIPATE → PUBLISH → PROMOTE → COMPETE → VOTE → GROW
And the central commercial journey is:
CHOOSE SERVICE → COMPLETE → PREVIEW → SUBMIT → REFERENCE → PAY → ADMIN APPROVAL → ACTIVATE → RENEW / UPGRADE
END OF MASTER FUNCTIONAL SPECIFICATION — VERSION 2.0
