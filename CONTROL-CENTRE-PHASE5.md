# Unplug Control Centre — Phase 5: Media Library

## What changed

- Reframed the existing **Media & Gallery** admin section into two clear areas:
  1. **Media Library** — all uploaded/referenced images across the ecosystem.
  2. **Community Gallery** — the editorial gallery shown to readers.
- Added `/admin/media` admin API.
- Added migration `183_media_library.sql` with a central `media_assets` catalogue.
- New public image uploads are automatically indexed in the Media Library.
- Existing images already referenced by content are adopted into the catalogue on first Media Library load; no image bytes are copied and existing URLs are not changed.
- Search by filename, caption, URL, content type, and the content item's label.
- Filters for All / In use / Unused / Trash.
- Shows usage count and up to the first few places where an image is used.
- Shows storage source, file size and image dimensions when known.
- Supports editing alt text and an internal caption.
- Supports copying an image URL for reuse in other content.
- Supports safe Trash / Restore.
- Trash is refused while the image is still referenced by live/site content.
- Media metadata/trash/restore actions are written to the existing admin activity log.
- Standard image uploads now generate responsive derivatives through the existing image pipeline before being indexed.

## Safety decisions

### No destructive object deletion yet
Moving an image to Media Library Trash does **not** delete its bytes from Cloudflare R2, Supabase Storage, or local development storage. Physical deletion will be added only once a storage-aware permanent-delete flow can verify that no references remain.

### Existing media remains the source of truth
The Media Library is an index, not a rewrite of every content table. Articles, profiles, banners, pages, etc. continue storing the image URL they already use. This makes Phase 5 compatible with the existing public site.

### Existing images are adopted, not copied
When the library sees an image referenced by existing content, it creates metadata in `media_assets` for that same URL. This does not create duplicate storage or alter public content.

## Migration

Run database migrations before using the Media Library:

- `183_media_library.sql`

The production `npm start` script already runs the migration runner first.

## Validation performed

- `node --check unplug-backend/src/routes/adminMedia.js`
- `node --check unplug-backend/src/routes/uploads.js`
- `node --check unplug-backend/src/app.js`
- Extracted dashboard inline JavaScript and passed `node --check`.

The database/storage integration tests could not run in the extracted ZIP because its npm dependencies are not installed (`express`, `@aws-sdk/client-s3`, `embedded-postgres`, etc.). This is an environment limitation, not a passing integration-test claim.
