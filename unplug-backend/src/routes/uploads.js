const express = require('express');
const fs = require('fs');
const {
  upload, uploadPdf, uploadProof, verifySignature,
  ALLOWED_MIME_TYPES, ALLOWED_PROOF_MIME_TYPES,
  MAX_PDF_SIZE_BYTES, MAX_PROOF_SIZE_BYTES,
} = require('../middleware/upload');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Persistent object storage (Supabase Storage) — used automatically when
// these three env vars are set. Without them we fall back to local disk
// (fine for local dev, but on free/ephemeral hosts local files are wiped on
// every redeploy, so real deployments should set these):
//   SUPABASE_URL          e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY  the service_role key (server-side only, never public)
//   SUPABASE_BUCKET       a PUBLIC storage bucket name, e.g. "uploads"
const { storeDerivatives } = require('../utils/imageDerivativeStore');

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_BUCKET } = process.env;
const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY && SUPABASE_BUCKET);

// A second, PRIVATE bucket — used only for the full-quality edition PDF
// behind the paid single-use download (094_edition_download_pdf.sql).
// Deliberately not the same bucket as SUPABASE_BUCKET above: that one is
// public (needed for "View Online" and every other image on the site),
// and a public bucket can't be made to enforce the single-use gate — the
// raw URL is fetchable by anyone who has it, app logic notwithstanding.
const SUPABASE_PRIVATE_BUCKET = process.env.SUPABASE_PRIVATE_BUCKET || 'edition-downloads';
const supabasePrivateConfigured = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);

// Uploads the just-saved multer file to Supabase Storage over the REST API
// (no extra dependency — uses Node's built-in fetch) and returns its public
// URL, then removes the local temp copy.
async function uploadToSupabase(file) {
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

// Same upload mechanics as uploadToSupabase above, but targets the PRIVATE
// bucket and returns the non-public object URL (no `/public/` segment) —
// fetching it back later requires the same service-role auth headers used
// here, which only this backend has (see GET /editions/download/:token).
async function uploadToSupabasePrivate(file) {
  const buffer = fs.readFileSync(file.path);
  const objectPath = `${Date.now()}-${file.filename}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_PRIVATE_BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      apikey: SUPABASE_SERVICE_KEY,
      'Content-Type': file.mimetype || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: buffer,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Supabase Storage upload failed (${res.status}): ${detail}`);
  }
  fs.unlink(file.path, () => {});
  return `${SUPABASE_URL}/storage/v1/object/${SUPABASE_PRIVATE_BUCKET}/${objectPath}`;
}

// Uploads an already-in-memory Buffer (as opposed to uploadToSupabase above,
// which reads a multer-saved temp file) straight to the PUBLIC bucket, and
// returns its public URL. Written for the invoice/receipt PDFs the admin
// payment queue generates on the fly (routes/adminPaymentQueue.js) — there's
// no local file for those, just bytes already held in memory, and unlike a
// proof-of-payment upload an invoice/receipt is fine to be a plain public
// link (it's what WE billed, not a bank statement).
// HOW LONG A STORED FILE MAY BE CACHED.
//
// Supabase serves uploads with "Cache-Control: no-cache" unless told otherwise,
// which is why every image on the site is revalidated on every single page
// view — including the 1.9 MB one. Every object here is written under a key
// containing a timestamp and a random name, and is never rewritten, so the
// bytes at a given URL can never change. That is the definition of immutable,
// and a year is the longest max-age browsers respect.
const STORAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

// Puts bytes in the PUBLIC bucket at an exact key and returns the public URL.
//
// The key is passed in rather than invented here, because responsive
// derivatives have to land at names the frontend can work out for itself
// ("derivatives/<original>-800.avif"). Callers that just want a unique name
// use uploadBufferToSupabase below, which is this function plus a timestamp.
async function putPublicObject(objectPath, buffer, mimetype) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: {
      // Works with both the legacy service_role JWT and the new sb_secret_*
      // keys. The Storage API gateway expects the key in the `apikey` header
      // as well as the Bearer token, so we send both.
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      apikey: SUPABASE_SERVICE_KEY,
      'Content-Type': mimetype || 'application/octet-stream',
      'cache-control': STORAGE_CACHE_CONTROL,
      'x-upsert': 'true',
    },
    body: buffer,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Supabase Storage upload failed (${res.status}): ${detail}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${objectPath}`;
}

async function uploadBufferToSupabase(buffer, filename, mimetype) {
  return putPublicObject(`${Date.now()}-${filename}`, buffer, mimetype);
}

// Fetches a file back out of the private bucket with the service-role key —
// the same credentials uploadToSupabasePrivate used to put it there. Reused
// by GET /admin/payment-queue/:source/:id/proof (see routes/adminPaymentQueue.js)
// so an admin can actually view a proof-of-payment upload; exported the same
// way notifyProfileOwner is in interactions.js, so it doesn't need its own file.
async function fetchFromSupabasePrivate(url) {
  return fetch(url, {
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY },
  });
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
  if (!supabasePrivateConfigured) {
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
      const url = await uploadToSupabasePrivate(req.file);
      res.status(201).json({ url, filename: req.file.filename, sizeBytes: req.file.size });
    } catch (e) {
      console.error('Supabase Storage proof upload failed:', e.message);
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

    if (supabaseConfigured) {
      try {
        const { url, key, buffer } = await uploadToSupabase(req.file);

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
          url, filename: req.file.filename, sizeBytes: req.file.size, storage: 'supabase',
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
        console.error('Supabase Storage PDF upload failed:', e.message);
        return res.status(502).json({
          error: 'PDF storage is misconfigured, so the upload was not saved. Please try again — if it keeps failing, check the Supabase Storage settings.',
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
// only GET /editions/download/:token (with the server's own service-role
// key) can ever retrieve it.
router.post('/edition-download-pdf', requireRole('admin'), (req, res) => {
  if (!supabasePrivateConfigured) {
    return res.status(400).json({ error: 'Supabase Storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY), so there is nowhere private to put this file.' });
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
      const url = await uploadToSupabasePrivate(req.file);
      res.status(201).json({ url, filename: req.file.filename, sizeBytes: req.file.size, storage: 'supabase-private' });
    } catch (e) {
      console.error('Supabase Storage private PDF upload failed:', e.message);
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

    if (supabaseConfigured) {
      try {
        const { url } = await uploadToSupabase(req.file);
        return res.status(201).json({ url, filename: req.file.filename, sizeBytes: req.file.size, storage: 'supabase' });
      } catch (e) {
        // Do NOT silently fall back to local disk in production: Render's disk is
        // ephemeral, so a locally-stored image looks fine now but vanishes on the
        // next redeploy. Failing loudly means the admin retries / fixes the config
        // instead of shipping an image that will 404 later.
        console.error('Supabase Storage upload failed:', e.message);
        return res.status(502).json({
          error: 'Image storage is misconfigured, so the upload was not saved. Please try again — if it keeps failing, check the Supabase Storage settings.',
        });
      }
    }

    // No object storage configured (e.g. local dev): serve from local disk.
    // Render terminates TLS at its proxy and forwards plain http to the app, so
    // req.protocol is 'http' here. Trust the proxy's x-forwarded-proto instead —
    // otherwise we'd save an http:// URL that the https site blocks as mixed content.
    const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
    const url = `${proto}://${req.get('host')}/uploads/${req.file.filename}`;
    res.status(201).json({
      url, filename: req.file.filename, sizeBytes: req.file.size, storage: 'local',
      warning: 'Saved to temporary local storage — this file will be lost on the next server restart. Configure Supabase Storage for permanent uploads.',
    });
  });
});

// Reused by routes/adminPaymentQueue.js: viewing a proof-of-payment upload
// (fetchFromSupabasePrivate), storing a generated invoice/receipt PDF
// (uploadBufferToSupabase), and knowing whether that's even possible right
// now (supabaseConfigured) — all without duplicating this file's storage logic.
// The private-bucket twin of uploadBufferToSupabase, for bytes that are
// nobody's business but the customer's — an edition order confirmation
// carries their name, email and what they paid, so it must not sit on a
// public URL the way an invoice PDF harmlessly can.
async function uploadBufferToSupabasePrivate(buffer, filename, mimetype) {
  const objectPath = `${Date.now()}-${filename}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_PRIVATE_BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      apikey: SUPABASE_SERVICE_KEY,
      'Content-Type': mimetype || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: buffer,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Supabase Storage upload failed (${res.status}): ${detail}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/${SUPABASE_PRIVATE_BUCKET}/${objectPath}`;
}

// True when a URL points at the PUBLIC bucket — i.e. anyone holding the link
// can read the file without going through this backend at all. Used to tell
// an admin, in plain words, which paid editions are still being served from a
// link that needs no purchase.
function isPublicStorageUrl(url) {
  return typeof url === 'string' && url.includes('/storage/v1/object/public/');
}

router.fetchFromSupabasePrivate = fetchFromSupabasePrivate;
router.uploadBufferToSupabase = uploadBufferToSupabase;
router.putPublicObject = putPublicObject;
router.STORAGE_CACHE_CONTROL = STORAGE_CACHE_CONTROL;
router.uploadBufferToSupabasePrivate = uploadBufferToSupabasePrivate;
router.isPublicStorageUrl = isPublicStorageUrl;
router.supabaseConfigured = supabaseConfigured;
router.supabasePrivateConfigured = supabasePrivateConfigured;

module.exports = router;
