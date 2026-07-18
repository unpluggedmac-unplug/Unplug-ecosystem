const express = require('express');
const fs = require('fs');
const { upload } = require('../middleware/upload');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Persistent object storage (Supabase Storage) — used automatically when
// these three env vars are set. Without them we fall back to local disk
// (fine for local dev, but on free/ephemeral hosts local files are wiped on
// every redeploy, so real deployments should set these):
//   SUPABASE_URL          e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY  the service_role key (server-side only, never public)
//   SUPABASE_BUCKET       a PUBLIC storage bucket name, e.g. "uploads"
const { SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_BUCKET } = process.env;
const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY && SUPABASE_BUCKET);

// Uploads the just-saved multer file to Supabase Storage over the REST API
// (no extra dependency — uses Node's built-in fetch) and returns its public
// URL, then removes the local temp copy.
async function uploadToSupabase(file) {
  const buffer = fs.readFileSync(file.path);
  const objectPath = `${Date.now()}-${file.filename}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': file.mimetype || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: buffer,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Supabase Storage upload failed (${res.status}): ${detail}`);
  }
  fs.unlink(file.path, () => {}); // best-effort cleanup of the local temp file
  return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${objectPath}`;
}

// POST /uploads — member uploads a single image, gets back a URL to use as
// imageUrl / posterImageUrl / photoUrl in any of the other endpoints. Every
// route that accepts an `imageUrl` string doesn't care where it lives, so
// switching to object storage is transparent to them.
router.post('/', requireAuth, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file was uploaded (expected multipart field "file").' });
    }

    if (supabaseConfigured) {
      try {
        const url = await uploadToSupabase(req.file);
        return res.status(201).json({ url, filename: req.file.filename, sizeBytes: req.file.size, storage: 'supabase' });
      } catch (e) {
        // Don't fail the upload — fall back to serving from local disk.
        console.error('Supabase Storage upload failed, using local disk:', e.message);
      }
    }

    const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    res.status(201).json({ url, filename: req.file.filename, sizeBytes: req.file.size, storage: 'local' });
  });
});

module.exports = router;
