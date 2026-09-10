# Agreement Forms + Growth Applications — Locked Build Decisions

Branch: `feature/agreement-growth-applications-20260910`

Date locked: 2026-09-10

## Confirmed decisions

1. **Agreement payment timing:** configurable rather than one fixed timing rule.
2. **Service scope:** agreements may cover external/off-site services, not only services delivered inside Unplug.
3. **Paid agreements:** use the normal Unplug checkout/payment flow.
4. **Signatures:** support both typed signatures and drawn signatures.
5. **Growth Applications:** free to applicants.
6. **Deep Discovery:** build separate Individual and Business questionnaires, each targeting approximately 250 questions, using the approved source-of-truth proposal wording rather than generated replacement questions.
7. **Growth Journey:** retain a permanent history/journey record rather than replacing prior milestones/status history.
8. **Privacy:** POPIA/privacy consent is required as part of the application flow.

## Source-of-truth boundaries

- Agreement Forms implementation must preserve the tested local backend described in `agreement-forms-HANDOVER` and must be reconciled with the current staging-derived codebase before integration.
- Exact Agreement Forms field definitions, business rules and UI wording must come from `docs/proposals/agreement-forms-proposal.md` when that source file is available.
- Exact Growth Application fields, validation, business copy, and the Individual/Business Deep Discovery question sets must come from `docs/proposals/growth-application-proposal.md`. Do not invent or silently replace missing questionnaire content.

## Verified integration notes

- The feature branch currently contains migrations through `189_admin_content_trash.sql`; migration numbers `183`–`187` and `189` are already occupied. The old local `183_agreement_forms.sql` must therefore be renumbered. **Reserve `190_agreement_forms.sql` for the Agreement Forms migration** unless a new migration lands on this branch before integration, in which case re-check the sequence first.
- The migration runner reads every `db/migrations/*.sql` filename and applies them in zero-padded lexical order. The existing gap at `188` is not a reason to back-fill a feature migration there.
- Current `src/app.js` still mounts `/forms` immediately before `/privacy`, matching the handover's intended Agreement Forms insertion point. Agreement Forms should add `/agreement-forms` and the top-level `/a` short-link router between those mounts, without altering the existing `/agreements` system.
- Current `src/utils/submissionReference.js` still lacks `agreement_payment`. The handover's two additions remain applicable: `agreement_payment: 'agreement_submissions'` in `SUBMISSION_TABLE`, and `agreement_payment: 'Agreement'` in `SERVICE_LABEL`.
- Do not wire either of those code changes before the actual Agreement Forms route/migration source is integrated, because `app.js` would otherwise require a module that is not yet present.

## Release safety

All feature work stays on `feature/agreement-growth-applications-20260910` until it passes the required automated tests and review. Do not merge or deploy this feature directly to production. Production remains untouched until the normal feature → staging → validation → approved production release path is complete.
