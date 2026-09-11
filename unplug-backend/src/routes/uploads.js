const express = require('express');
const fs = require('fs');
const pool = require('../db');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const {
  upload, uploadPdf, uploadProof, verifySignature,
  ALLOWED_MIME_TYPES, ALLOWED_PROOF_MIME_TYPES,
  MAX_PDF_SIZE_BYTES, MAX_PROOF_SIZE_BYTES,
} = require('../middleware/upload');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Persistent object storage — Cloudflare R2, the only backend this project
// uses. It used to also support Supabase Storage as a fallback (kept working
// automatically while both were configured, so nothing broke mid-migration);
// that was removed once every new upload was confirmed landing on R2 and no
// PRIVATE file (a paid edition PDF, a proof-of-payment) was still on
// Supabase. Anything still referencing an old Supabase URL is legacy data —
// see scripts/migrate-supabase-to-r2.js and the admin "Storage audit" tool
// (routes/admin.js) for moving/finding what's left.
//   R2_ACCOUNT_ID          Cloudflare account ID
//   R2_ACCESS_KEY_ID       from an R2 API token (S3-compatible credentials)
//   R2_SECRET_ACCESS_KEY   from that same token
//   R2_BUCKET              a PUBLIC bucket name, e.g. "uploads"
//   R2_PUBLIC_URL          that bucket's public base URL (its r2.dev URL, or
//                          a custom domain) — R2 has no built-in public URL
//                          the way Supabase does, so this must be set by hand
//   R2_PRIVATE_BUCKET      a PRIVATE bucket name (defaults to "edition-downloads")
const { storeDerivatives } = require('../utils/imageDerivativeStore');

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL } = process.env;
const R2_PRIVATE_BUCKET = process.env.R2_PRIVATE_BUCKET || 'edition-downloads';
const r2Configured = Boolean(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET && R2_PUBLIC_URL);
const r2PrivateConfigured = Boolean(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);

// Built only when actually needed — the SDK doesn't validate credentials at
// construction time, but there's no reason to create a client nothing calls.
const r2Client = (r2Configured || r2PrivateConfigured)
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
      // Cloudflare's own R2 docs recommend this: the SDK's default
      // virtual-hosted style (<bucket>.<account>.r2.cloudflarestorage.com)
      // isn't reliably supported, unlike real path-style addressing.
      forcePathStyle: true,
    })
  : null;

// Best-effort catalogue entry for the Admin Media Library. Upload success must
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

// A second, PRIVATE bucket — used only for the full-quality edition PDF
// behind the paid single-use download (094_edition_download_pdf.sql) and for
// EFT proof-of-payment uploads. Deliberately not the same bucket as the
// public one above: that one is public (needed for "View Online" and every
// other image on the site), and a public bucket can't be made to enforce
// the single-use gate — the raw URL is fetchable by anyone who has it, app
// logic notwithstanding.

// Uploads the just-saved multer file to the PUBLIC bucket and returns its
// public URL, then removes the local temp copy.
async function uploadPublicFile(file) {
  const buffer = fs.readFileSync(file.path);
  const objectPath = `${Date.now()}-${file.filename}`;
  const url = await putPublicObject(objectPath, buffer, file.mimetype);
  fs.unlink(file.path, () => {}); // best-effort cleanup of the local temp file
  // The key and the bytes come back with the URL because the caller needs both
  // to build responsive derivatives. They are RETURNED, not stashed on the
  // function: two uploads landing at once would otherwise overwrite each
  // other's key, and the second image would get the first one's derivatives.
  return { url, key: objectPath, buffer };
}

// Puts bytes in the PRIVATE bucket at an exact key and returns its object
// URL. That URL is NOT directly fetchable by a browser (the bucket is
// private) — reading it back later always goes through fetchPrivateObject
// below, which signs a short-lived GET.
async function putPrivateObject(objectPath, buffer, mimetype) {
  if (!(r2Configured || r2PrivateConfigured)) {
    throw new Error('No private object storage is configured.');
  }
  await r2Client.send(new PutObjectCommand({
    Bucket: R2_PRIVATE_BUCKET,
    Key: objectPath,
    Body: buffer,
    ContentType: mimetype || 'application/octet-stream',
  }));
  // The real R2 object path, not a signed URL — signing happens only at READ
  // time (see fetchPrivateObject).
  return `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_PRIVATE_BUCKET}/${objectPath}`;
}

// Same upload mechanics as uploadPublicFile above, but targets the PRIVATE
// bucket — fetching the result back later requires a signed GET (see
// GET /editions/download/:token).
async function uploadPrivateFile(file) {
  const buffer = fs.readFileSync(file.path);
  const objectPath = `${Date.now()}-${file.filename}`;
  const url = await putPrivateObject(objectPath, buffer, file.mimetype);
  fs.unlink(file.path, () => {}); // best-effort cleanup of the local temp file
  return url;
}

// Uploads an already-in-memory Buffer (as opposed to uploadPublicFile above,
// which reads a multer-saved temp file) straight to the PUBLIC bucket, and
// returns its public URL. Written for the invoice/receipt PDFs the admin
// payment queue generates on the fly (routes/adminPaymentQueue.js) — there's
// no local file for those, just bytes already held in memory.
// HOW LONG A STORED FILE MAY BE CACHED.
//
// Every object here is written under a key containing a timestamp and a
// random name, and is never rewritten, so the bytes at a given URL can never
// change. That is the definition of immutable, and a year is the longest
// max-age browsers respect.
const STORAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

// Puts bytes in the PUBLIC bucket at an exact key and returns the public URL.
//
// The key is passed in rather than invented here, because responsive
// derivatives have to land at names the frontend can work out for itself
// ("derivatives/<original>-800.avif"). Callers that just want a unique name
// use uploadPublicBuffer below, which is this function plus a timestamp.
async function putPublicObject(objectPath, buffer, mimetype) {
  if (!r2Configured) {
    throw new Error('No public object storage is configured.');
  }
  await r2Client.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: objectPath,
    Body: buffer,
    ContentType: mimetype || 'application/octet-stream',
    CacheControl: STORAGE_CACHE_CONTROL,
  }));
  return `${R2_PUBLIC_URL}/${objectPath}`;
}

async function uploadPublicBuffer(buffer, filename, mimetype) {
  return putPublicObject(`${Date.now()}-${filename}`, buffer, mimetype);
}

// Fetches a file back out of the PRIVATE bucket — signs a short-lived GET,
// then fetches that. Reused by GET /admin/payment-queue/:source/:id/proof
// (see routes/adminPaymentQueue.js) so an admin can actually view a
// proof-of-payment upload, and by GET /editions/download/:token.
async function fetchPrivateObject(url) {
  const R2_MARKER = '.r2.cloudflarestorage.com/';
  const idx = typeof url === 'string' ? url.indexOf(R2_MARKER) : -1;
  if (idx === -1) {
    throw new Error('Not a recognised private object URL.');
  }
  const path = url.slice(idx + R2_MARKER.length);
  const [bucket, ...keyParts] = path.split('/');
  const signedUrl = await getSignedUrl(
    r2Client,
    new GetObjectCommand({ Bucket: bucket, Key: keyParts.join('/') }),
    { expiresIn: 60 }
  );
  return fetch(signedUrl);
}

// POST /uploads/proof — proof of payment for an EFT. Deliberately NOT behind
// requireAuth: the standalone Bulk Votes portal (095_vote_bundle_standalone_
// portal.sql) has no login at all, and this same endpoint has to work for an
// anonymous vote-bundle buyer too. Uploading bytes is harmless on its own;
// what actually needs authorising is ATTACHING the resulting URL to a real
// payment/order/vote-bundle, which each do their own auth-or-reference check
// (PATCH /payments/:id/proof, /orders/:id/proof, /vote-bundles/:reference/proof).
//
// Goes to the PRIVATE bucket, not the public one images use: a bank screenshot
// can show the account's balance and other transactions, which is materially
// more sensitive than a magazine photo — same reasoning as the private edition
// download PDF (094_edition_download_pdf.sql), reusing that existing bucket
// and upload function rather than inventing a second private-storage path.
router.post('/proof', (req, res) => {
  if (!r2PrivateConfigured) {
    return res.status(400).json({ error: 'File storage is not configured on this server yet — proof of payment cannot be uploaded right now. Please contact us instead.' });
  }
  uploadProof.single('file')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `That file is too large. The maximum is ${Math.round(MAX_PROOF_SIZE_BYTES / (1024 * 1024))}MB.`
        : err.message;
      return res.status(400).json({ error: msg });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file was uploaded (expected multipart field "file").' });
    }

    // What the bytes say it is, not what the browser called it. multer's
    // fileFilter only ever saw a client-supplied Content-Type; this is the
    // first point at which the file itself can be read. A mismatch deletes
    // the temp file and refuses — proof of payment is what this endpoint stores.
    const signature = verifySignature(req.file, ALLOWED_PROOF_MIME_TYPES);
    if (!signature.ok) {
      return res.status(400).json({ error: signature.reason });
    }
    try {
      const url = await uploadPrivateFile(req.file);
      res.status(201).json({ url, filename: req.file.filename, sizeBytes: req.file.size });
    } catch (e) {
      console.error('Object storage proof upload failed:', e.message);
      res.status(502).json({ error: 'Could not save that file. Please try again.' });
    }
  });
});

// POST /uploads — member uploads a single image, gets back a URL to use as
// imageUrl / posterImageUrl / photoUrl in any of the other endpoints. Every
// route that accepts an `imageUrl` string doesn't care where it lives, so
// switching to object storage is transparent to them.
// POST /uploads/pdf — admin uploads a magazine edition PDF. Separate from the
// image route above because that one rejects anything that isn't an image and
// caps at 8MB, which a full monthly edition exceeds.
//
// Registered BEFORE the '/' handler so the router matches it first.
router.post('/pdf', requireRole('admin'), (req, res) => {
  uploadPdf.single('file')(req, res, async (err) => {
    if (err) {
      // Multer's size message is unhelpful on its own — say the actual limit.
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `That PDF is too large. The maximum is ${Math.round(MAX_PDF_SIZE_BYTES / (1024 * 1024))}MB.`
        : err.message;
      return res.status(400).json({ error: msg });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file was uploaded (expected multipart field "file").' });
    }

    // What the bytes say it is, not what the browser called it. multer's
    // fileFilter only ever saw a client-supplied Content-Type; this is the
    // first point at which the file itself can be read. A mismatch deletes
    // the temp file and refuses — a PDF is what this endpoint stores.
    const signature = verifySignature(req.file, ['application/pdf']);
    if (!signature.ok) {
      return res.status(400).json({ error: signature.reason });
    }

    if (r2Configured) {
      try {
        const { url, key, buffer } = await uploadPublicFile(req.file);

        // Responsive derivatives, built now so a reader never waits for them.
        //
        // Deliberately AWAITED rather than left running after the response.
        // Render's free instance sleeps when idle, so work started after the
        // reply is work that may simply never finish — and an image recorded
        // as having derivatives that were never uploaded is the one failure
        // that breaks the page rather than merely slowing it. The uploader
        // waits a few seconds; the site stays correct.
        //
        // A failure here is NOT a failed upload. The original is already
        // stored and is what the page will serve, exactly as before this
        // pipeline existed.
        let derivatives = null;
        try {
          derivatives = await storeDerivatives({ key, buffer, putObject: putPublicObject });
        } catch (derr) {
          console.error('[uploads] derivatives failed for', key, '-', derr.message);
        }

        return res.status(201).json({
          url, filename: req.file.filename, sizeBytes: req.file.size, storage: 'r2',
          // Reported so an admin screen can say what happened, and so the
          // response is honest about whether the responsive versions exist.
          responsive: derivatives && derivatives.made > 0
            ? { widths: derivatives.widths, formats: derivatives.formats,
                bytes: derivatives.derivativeBytes }
            : null,
        });
      } catch (e) {
        // Same reasoning as the image route: never fall back to Render's
        // ephemeral disk, or the edition PDF disappears on the next redeploy
        // and paying customers are left with a dead download.
        console.error('Object storage PDF upload failed:', e.message);
        return res.status(502).json({
          error: 'PDF storage is misconfigured, so the upload was not saved. Please try again — if it keeps failing, check your R2 settings.',
        });
      }
    }

    const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
    res.status(201).json({
      url: `${proto}://${req.get('host')}/uploads/${req.file.filename}`,
      filename: req.file.filename,
      sizeBytes: req.file.size,
      storage: 'local',
    });
  });
});

// POST /uploads/edition-download-pdf — admin uploads the full-quality file
// behind a paid edition's single-use download, kept separate from the free
// "View Online" PDF above. Never returns a fetchable URL to the browser —
// only GET /editions/download/:token (with server-side signing) can ever
// retrieve it.
router.post('/edition-download-pdf', requireRole('admin'), (req, res) => {
  if (!r2PrivateConfigured) {
    return res.status(400).json({ error: 'Object storage is not configured (set R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY), so there is nowhere private to put this file.' });
  }
  uploadPdf.single('file')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `That PDF is too large. The maximum is ${Math.round(MAX_PDF_SIZE_BYTES / (1024 * 1024))}MB.`
        : err.message;
      return res.status(400).json({ error: msg });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file was uploaded (expected multipart field "file").' });
    }

    // What the bytes say it is, not what the browser called it. multer's
    // fileFilter only ever saw a client-supplied Content-Type; this is the
    // first point at which the file itself can be read. A mismatch deletes
    // the temp file and refuses — a PDF is what this endpoint stores.
    const signature = verifySignature(req.file, ['application/pdf']);
    if (!signature.ok) {
      return res.status(400).json({ error: signature.reason });
    }
    try {
      const url = await uploadPrivateFile(req.file);
      res.status(201).json({ url, filename: req.file.filename, sizeBytes: req.file.size, storage: 'r2-private' });
    } catch (e) {
      console.error('Object storage private PDF upload failed:', e.message);
      res.status(502).json({ error: 'The download file could not be saved. Please try again.' });
    }
  });
});

router.post('/', requireAuth, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file was uploaded (expected multipart field "file").' });
    }

    // What the bytes say it is, not what the browser called it. multer's
    // fileFilter only ever saw a client-supplied Content-Type; this is the
    // first point at which the file itself can be read. A mismatch deletes
    // the temp file and refuses — an image is what this endpoint stores.
    const signature = verifySignature(req.file, ALLOWED_MIME_TYPES);
    if (!signature.ok) {
      return res.status(400).json({ error: signature.reason });
    }

    if (r2Configured) {
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
        // Do NOT silently fall back to local disk in production: Render's disk is
        // ephemeral, so a locally-stored image looks fine now but vanishes on the
        // next redeploy. Failing loudly means the admin retries / fixes the config
        // instead of shipping an image that will 404 later.
        console.error('Object storage upload failed:', e.message);
        return res.status(502).json({
          error: 'Image storage is misconfigured, so the upload was not saved. Please try again — if it keeps failing, check your R2 settings.',
        });
      }
    }

    // No object storage configured (e.g. local dev): serve from local disk.
    // Render terminates TLS at its proxy and forwards plain http to the app, so
    // req.protocol is 'http' here. Trust the proxy's x-forwarded-proto instead —
    // otherwise we'd save an http:// URL that the https site blocks as mixed content.
    const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
    const url = `${proto}://${req.get('host')}/uploads/${req.file.filename}`;
    await indexPublicUpload({
      url, filename: req.file.filename, storage: 'local',
      mimetype: req.file.mimetype, sizeBytes: req.file.size,
      uploadedBy: req.user && req.user.id,
    });
    res.status(201).json({
      url, filename: req.file.filename, sizeBytes: req.file.size, storage: 'local',
      warning: 'Saved to temporary local storage — this file will be lost on the next server restart. Configure R2 for permanent uploads.',
    });
  });
});

// Reused by routes/adminPaymentQueue.js: viewing a proof-of-payment upload
// (fetchPrivateObject), storing a generated invoice/receipt PDF
// (uploadPublicBuffer), and knowing whether that's even possible right
// now (r2Configured) — all without duplicating this file's storage logic.
// The private-bucket twin of uploadPublicBuffer, for bytes that are
// nobody's business but the customer's — an edition order confirmation
// carries their name, email and what they paid, so it must not sit on a
// public URL the way an invoice PDF harmlessly can.
async function uploadPrivateBuffer(buffer, filename, mimetype) {
  return putPrivateObject(`${Date.now()}-${filename}`, buffer, mimetype);
}

// True when a URL points at the PUBLIC bucket — i.e. anyone holding the link
// can read the file without going through this backend at all. Used to tell
// an admin, in plain words, which paid editions are still being served from a
// link that needs no purchase.
function isPublicStorageUrl(url) {
  return typeof url === 'string' && Boolean(R2_PUBLIC_URL) && url.startsWith(R2_PUBLIC_URL);
}

router.fetchPrivateObject = fetchPrivateObject;
router.uploadPublicBuffer = uploadPublicBuffer;
router.putPublicObject = putPublicObject;
router.STORAGE_CACHE_CONTROL = STORAGE_CACHE_CONTROL;
router.uploadPrivateBuffer = uploadPrivateBuffer;
router.isPublicStorageUrl = isPublicStorageUrl;
router.r2Configured = r2Configured;
router.r2PrivateConfigured = r2PrivateConfigured;

module.exports = router;
