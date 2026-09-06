# Unplug Control Centre — Phase 6: Pages & Layout

## Objective
Turn the existing immediate-live Page CMS into a safer WordPress-like editing workflow without replacing the proven public renderer.

## New workflow
1. Open **Pages & Layout**.
2. Select a page.
3. Edit a private draft: reorder/show/hide custom blocks, change block content/images, stage wording overrides, stage built-in page images.
4. **Save Draft** — public site remains unchanged.
5. **Preview Draft** — structural admin preview.
6. **Publish** — draft is applied atomically to the existing `page_content` and `page_blocks` tables.
7. **Discard Draft** — deletes only the private draft and leaves the live page untouched.

## Backend changes
`unplug-backend/src/routes/pageContent.js`

New admin endpoints:
- `GET /page-cms/admin/pages`
- `GET /page-cms/admin/workspace/:pageKey`
- `PUT /page-cms/admin/workspace/:pageKey`
- `POST /page-cms/admin/workspace/:pageKey/publish`
- `DELETE /page-cms/admin/workspace/:pageKey`

The public `GET /page-cms` endpoint is unchanged and never reads drafts.

### Conflict protection
A draft records the live page state at the time drafting starts. Publish compares that base state with the current live state. If another action changed the live page in the meantime, publishing returns HTTP 409 (`CMS_DRAFT_CONFLICT`) rather than overwriting newer work.

### Audit log actions
- `cms_draft_saved`
- `cms_draft_discarded`
- `cms_page_published`

## Database migration
`184_page_cms_drafts.sql`

Adds `page_cms_drafts`, storing:
- page key
- staged wording/content JSON
- staged blocks JSON
- base-state metadata for conflict detection
- admin who last updated the draft
- timestamps

## Admin changes
The previous direct-live block editor is hidden and replaced by **Page Layout Studio**:
- page selector
- saved/unsaved/live state indicator
- Save Draft / Preview / Publish / Discard controls
- block reordering (up/down)
- block visibility
- edit/remove block in draft
- image upload reuse through the existing upload component
- page wording overrides in the same draft
- built-in site image positions staged into the same draft

The old misplaced **Reword the site** and **Site images** panels under Marketplace Placements are hidden. Their DOM remains temporarily so legacy JavaScript bindings do not break while the dashboard is gradually modularised.

## Preview limitation
Phase 6 preview is a **structural/content preview inside Admin**, not a pixel-perfect rendering of the public page. A secure full-site preview URL can be added later without exposing drafts publicly.

## Compatibility / safety notes
- Existing public CMS rendering is untouched.
- Existing live `page_content` and `page_blocks` remain the publication source of truth.
- Site-image rows are included in the page draft snapshot so publication does not drop them accidentally.
- If a live site image/content/block is changed outside the workspace after a draft starts, conflict protection blocks stale publication.

## Validation performed
- `node --check unplug-backend/src/routes/pageContent.js` — passed.
- `node --check unplug-backend/src/app.js` — passed.
- Extracted admin inline JavaScript and `node --check` — passed.
- Full frontend build could not execute because the extracted repository has an incomplete `node_modules` tree: `require('esbuild')` fails even though package directory placeholders exist.
- Backend integration tests remain unavailable until backend dependencies are installed.

## Deployment requirement
Run migration `184_page_cms_drafts.sql` before using the new Pages & Layout draft workspace.

Do not deploy this phase blindly to production without a database backup and a staging/smoke-test cycle.
