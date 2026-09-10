from pathlib import Path

path = Path('unplug-backend/src/routes/uploads.js')
s = path.read_text()

if "const pool = require('../db');" not in s:
    needle = "const fs = require('fs');\n"
    if needle not in s:
        raise SystemExit('uploads merge: fs import anchor not found')
    s = s.replace(needle, needle + "const pool = require('../db');\n", 1)

if 'async function indexPublicUpload' not in s:
    anchor = "// A second, PRIVATE bucket — used only for the full-quality edition PDF\n"
    if anchor not in s:
        raise SystemExit('uploads merge: private bucket anchor not found')
    helper = """// Best-effort catalogue entry for the Admin Media Library. Upload success must
// never be turned into upload failure merely because a migration has not yet
// run on an environment, so indexing errors are logged and swallowed.
async function indexPublicUpload({ url, filename, storage, mimetype, sizeBytes, uploadedBy, width, height }) {
  try {
    await pool.query(`INSERT INTO media_assets
      (url, filename, storage, mime_type, size_bytes, width, height, uploaded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (url) DO UPDATE SET
        filename=COALESCE(EXCLUDED.filename, media_assets.filename),
        storage=COALESCE(EXCLUDED.storage, media_assets.storage),
        mime_type=COALESCE(EXCLUDED.mime_type, media_assets.mime_type),
        size_bytes=COALESCE(EXCLUDED.size_bytes, media_assets.size_bytes),
        width=COALESCE(EXCLUDED.width, media_assets.width),
        height=COALESCE(EXCLUDED.height, media_assets.height),
        uploaded_by=COALESCE(media_assets.uploaded_by, EXCLUDED.uploaded_by),
        updated_at=now()`,
      [url, filename || null, storage || null, mimetype || null, sizeBytes || null,
       width || null, height || null, uploadedBy || null]);
  } catch (err) {
    console.warn('[media library] upload was saved but could not be indexed:', err.message);
  }
}

"""
    s = s.replace(anchor, helper + anchor, 1)

old = """    if (r2Configured) {
      try {
        const { url } = await uploadPublicFile(req.file);
        return res.status(201).json({ url, filename: req.file.filename, sizeBytes: req.file.size, storage: 'r2' });
      } catch (e) {
"""
new = """    if (r2Configured) {
      try {
        const { url, key, buffer } = await uploadPublicFile(req.file);
        let derivatives = null;
        try {
          derivatives = await storeDerivatives({ key, buffer, putObject: putPublicObject });
        } catch (derr) {
          console.error('[uploads] derivatives failed for', key, '-', derr.message);
        }
        await indexPublicUpload({
          url, filename: req.file.filename, storage: 'r2', mimetype: req.file.mimetype,
          sizeBytes: req.file.size, uploadedBy: req.user && req.user.id,
          width: derivatives && derivatives.meta && derivatives.meta.width,
          height: derivatives && derivatives.meta && derivatives.meta.height,
        });
        return res.status(201).json({
          url, filename: req.file.filename, sizeBytes: req.file.size, storage: 'r2',
          responsive: derivatives && derivatives.made > 0
            ? { widths: derivatives.widths, formats: derivatives.formats }
            : null,
        });
      } catch (e) {
"""
if old not in s:
    raise SystemExit('uploads merge: R2 image upload block anchor not found')
s = s.replace(old, new, 1)

old_local = """    const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
    const url = `${proto}://${req.get('host')}/uploads/${req.file.filename}`;
    res.status(201).json({
"""
new_local = """    const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
    const url = `${proto}://${req.get('host')}/uploads/${req.file.filename}`;
    await indexPublicUpload({
      url, filename: req.file.filename, storage: 'local',
      mimetype: req.file.mimetype, sizeBytes: req.file.size,
      uploadedBy: req.user && req.user.id,
    });
    res.status(201).json({
"""
if old_local not in s:
    raise SystemExit('uploads merge: local image upload block anchor not found')
s = s.replace(old_local, new_local, 1)

path.write_text(s)
