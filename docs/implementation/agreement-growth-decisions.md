# Agreement Forms + Growth Application — Locked Build Decisions

Date: 2026-09-10
Branch: `feature/agreement-growth-applications-20260910`
Status: Approved for implementation on feature/staging path only. Production remains untouched until staging validation passes.

This file is the durable decision log for the two approved builds. It captures the site owner's answers and must be treated as implementation requirements unless explicitly superseded by a later documented decision.

## Agreement Forms

1. Paid agreements: build the complete payment/checkout flow. Both free and paid agreements must work end-to-end.
2. Versioning: use visible agreement version numbers (v1, v2, v3...) while preserving the immutable snapshot of exactly what every signer signed.
3. Required/reference attachment scope: support all applicable Unplug website services AND external/off-site services. Agreement Forms is not limited to on-site services. Admin must be able to create/send agreements for external services or activities that do not exist as website flows.
4. Public visibility: there is no always-on public Agreements directory. Admin explicitly chooses whether an agreement is public and, if public, chooses which approved site pages display it. Direct/private links remain supported.
5. Control Centre navigation label: `Agreements`.

### Agreement Forms — implementation decisions batch 2

21. Payment timing is configurable per agreement. Admin chooses one of: `pay_before_sign`, `sign_before_pay`, or `free/no payment`.
22. External/off-site agreements support structured external-service metadata entered by admin, including service name, description/reference, client, amount, and an optional external reference.
23. When an external/off-site agreement has a price, payment still runs through Unplug's normal checkout/payment system and produces the normal payment record/reference/receipt.
24. Signing must support both typed signature/name and drawn signature where applicable. The agreement configuration/UI may present both methods to the signer.

## Growth Application

6. User-facing name: `Growth Application`.
7. Eligibility: members only. A user must have an Unplug account/login to start a Growth Application.
8. Deep Discovery: rebuild approximately 250 detailed questions.
9. Research scope approved: career/business history, skills, credibility, goals, opportunities, finances/business revenue ranges, marketing, audience, challenges, resources, partnerships, education, achievements, digital presence, support needs, and future plans.
10. Sensitive information: exclude unnecessary medical/health, religion, political beliefs, sexual-life and similarly sensitive personal questions unless a future use case creates a strict need and the site owner explicitly approves it.
11. `I don't have this` / N/A answers count as completed answers for progress.
12. Short-link regeneration: old Growth Application short links continue working after a new short link is generated.
13. Page placements: use a controlled/fixed list of real Unplug site pages with admin switches, not arbitrary free-text page names.
14. Image uploads: maximum 10 MB per image. Keep the two galleries described in the handover, up to 10 images each, using R2 storage rules.
15. Workflow statuses: `New -> Under Review -> Contacted -> In Progress -> Closed`. Applicant-facing message is required when moving to Contacted, In Progress or Closed. New and Under Review do not notify the applicant.
16. Response expectation default: 5 business days, admin-adjustable.
17. Repeat applications: allowed without a lifetime cap; retain full application history.
18. Member dashboard: show a persistent `My Growth Journey` card containing progress, tasks, messages and Resume Application access.
19. Admin research workspace: include private research notes, admin/internal notes, tasks, due dates and applicant-facing message history. Private/internal material must never be exposed to the applicant.

### Growth Application — implementation decisions batch 2

25. The Growth Application itself is free for members.
26. Deep Discovery must contain approximately 250 detailed questions for Individuals AND a separate approximately 250-question tailored set for Businesses.
27. After an application is Closed, the member's `My Growth Journey` card remains visible as permanent history, including completed tasks/messages, and the member may start another application.
28. Final submission requires POPIA/privacy consent explaining that Unplug may use the applicant's answers to assess growth needs, research opportunities, and communicate with the applicant about the application.

## Build and release rule

20. Approved release path: feature branch -> implementation -> automated tests/build -> staging -> validate all required gates green -> production. Do not merge to `main`, trigger production deployment, or alter the public production site before staging validation passes.

## Existing handover facts to preserve

- Agreement Forms' original handover records a previously built backend implementation, including migration, REST API, PDF generation and tests; where original source files are unavailable, reconstruct behavior from the handover and current codebase without silently removing documented safeguards.
- Preserve the legacy `signed_agreements` system; Agreement Forms is a separate configurable system.
- Guest signing remains supported for Agreement Forms where appropriate, including external/off-site signers.
- A signed agreement must never be hard-deleted. Archive instead and retain the signed record/document.
- The signer must always be able to retrieve the exact terms/version they originally signed, regardless of later admin edits.
- Agreement links must support both required and reference-only use cases, while also supporting standalone external/off-site agreements with no website service attachment.
- Growth Application is separate from Agreement Forms, `signed_agreements`, Impact Makers, Directory and the participation/recognition system unless a later explicit decision connects them.
- Growth Application must autosave and resume, support the three-stage applicant journey, admin research/tasks/messages, configurable placements, previews and applicant/admin PDF output as described in the handover.

## Source-loss rule

Do not rely on chat memory alone for build-critical decisions. Any new material decision made during implementation must be appended to this file (or a successor decision-log file in the repository) before it is treated as locked.
